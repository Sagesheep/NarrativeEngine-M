import type { LoreChunk, ArchiveScene } from '../../types';
import type { TurnCallbacks, TurnState, UtilityLLM } from './turnTypes';
import { realUtilityLLM } from './utilityLLM';
import { tierAllows } from './aiTier';
import { buildPayload } from '../chatEngine';
import { offlineStorage } from '../storage';
import { recommendContext } from '../payload';
import type { SearchHit } from '../embedding/vectorSearch';
import { runPlannerCall, type PlannerResult } from './stages/plannerStage';
import { gatherFactsAndTimeline } from './stages/factsTimelineStage';
import { recallNpcsSemantically } from './stages/npcSemanticRecallStage';
import { semanticCandidatesStage } from './stages/semanticCandidatesStage';
import { rerankStage } from './stages/rerankStage';
import { loreStage } from './stages/loreStage';
import { rulesStage } from './stages/rulesStage';
import { archiveRecallStage } from './stages/archiveRecallStage';
import { deepScanStage } from './stages/deepScanStage';

export type GatheredContext = {
    relevantLore: LoreChunk[] | undefined;
    relevantRules: LoreChunk[] | undefined;
    sceneNumber: string | undefined;
    archiveRecall: ArchiveScene[] | undefined;
    semanticArchiveHits: SearchHit[];
    semanticFactText: string;
    recommendedNPCNames: string[] | undefined;
    deepContextSummary: string | undefined;
    payloadResult: ReturnType<typeof buildPayload>;
};

export async function gatherContext(
    state: TurnState,
    callbacks: TurnCallbacks,
    finalInput: string,
    userMsgId: string,
    utilityLLM: UtilityLLM = realUtilityLLM(() => state.getUtilityEndpoint?.()),
): Promise<GatheredContext> {
    const { settings, loreChunks, npcLedger, archiveIndex, activeCampaignId } = state;
    const utilityTimeoutMs = (settings.utilityTimeoutSeconds ?? 45) * 1000;

    const plannerEndpoint = utilityLLM.endpoint();
    let plannerPromise: Promise<PlannerResult | null> = Promise.resolve(null);
    if (tierAllows(settings.aiTier, 'planner') && plannerEndpoint?.endpoint) {
        const recentForPlanner = state.getMessages().filter(m => m.id !== userMsgId).slice(-8);
        const chapterSummary = state.chapters.length > 0 ? state.chapters[state.chapters.length - 1].summary : undefined;
        plannerPromise = runPlannerCall(finalInput, recentForPlanner, npcLedger, chapterSummary, utilityLLM, settings.utilityTimeoutSeconds);
    }

    // Stage 1 — vector candidates. Also resolves the planner when the embedder
    // runs (planner ∥ query-expansion); otherwise plannerResult comes back null
    // and is resolved before archive recall below.
    const sem = await semanticCandidatesStage({
        activeCampaignId, finalInput, npcLedger, settings, plannerPromise, utilityLLM, utilityTimeoutMs,
    });
    let plannerResult = sem.plannerResult;

    // Stage 2 — LLM rerank of the scene/lore candidate sets.
    const { semanticArchiveIds, semanticArchiveHits, semanticLoreIds, semanticRuleIds } = await rerankStage({
        candidates: sem.candidates,
        finalInput, archiveIndex, loreChunks,
        rerankerEndpoint: utilityLLM.endpoint(),
        settings, utilityTimeoutMs,
    });

    const messages = state.getMessages().filter(m => m.id !== userMsgId);

    // Stage 3 / 4 — world-lore RAG and (conditional) rules RAG.
    const relevantLore = loreStage({ loreChunks, finalInput, messages, semanticLoreIds });
    const relevantRules = await rulesStage({ context: state.context, settings, finalInput, messages, semanticRuleIds });

    let sceneNumber: string | undefined;
    if (activeCampaignId) {
        callbacks.setLoadingStatus?.('[2/5] Fetching Timeline...');
        try {
            const nextScene = await offlineStorage.archive.getNextSceneNumber(activeCampaignId);
            sceneNumber = String(nextScene).padStart(3, '0');
        } catch (err) {
            console.warn('[TurnContext] Failed to get next scene number:', err);
        }
    }

    // If the embedder path didn't run, still resolve the planner before archive recall.
    if (!plannerResult && tierAllows(settings.aiTier, 'planner') && plannerEndpoint?.endpoint) {
        plannerResult = await plannerPromise;
    }

    const plannerFilters = plannerResult?.filters;

    // Stage 5 — archive recall (chapter funnel raced against a timeout → flat
    // fallback → pinned-chapter injection).
    const archiveResult = await archiveRecallStage({
        state, callbacks, finalInput, messages,
        semanticArchiveHits, semanticArchiveIds, plannerFilters, utilityLLM,
    });

    // Stage 6 — deep archive scan (opt-in one-shot continuity brief).
    const deepContextSummary = await deepScanStage({ state, callbacks, finalInput, userMsgId, utilityLLM });

    const finalArchiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    const semanticFactText = await gatherFactsAndTimeline({
        semanticFacts: state.semanticFacts, finalInput, messages, npcLedger, timeline: state.timeline,
    });

    let recommendedNPCNames: string[] | undefined;
    const utilityEndpoint = utilityLLM.endpoint();
    const pinnedChaptersForRecommender = state.pinnedChapterIds.length > 0
        ? state.chapters.filter(c => state.pinnedChapterIds.includes(c.chapterId))
        : undefined;
    if (tierAllows(settings.aiTier, 'recommender') && utilityEndpoint?.endpoint) {
        callbacks.setLoadingStatus?.('[4/5] Consulting AI Recommender...');
        try {
            const recommenderResult = await recommendContext(utilityEndpoint, npcLedger, loreChunks, messages, finalInput, pinnedChaptersForRecommender, utilityTimeoutMs);
            if (recommenderResult) {
                recommendedNPCNames = recommenderResult.relevantNPCNames;

                // Inject lore chunks the recommender picked that keyword/semantic retrieval missed
                const { relevantLoreIds } = recommenderResult;
                if (relevantLoreIds.length > 0 && loreChunks.length > 0 && relevantLore) {
                    const alreadyIn = new Set(relevantLore.map(c => c.id));
                    const RECOMMENDER_EXTRA_BUDGET = 600;
                    let extraTokens = 0;

                    for (const id of relevantLoreIds) {
                        const chunk = loreChunks.find(c => c.id === id);
                        if (!chunk || alreadyIn.has(chunk.id) || chunk.alwaysInclude) continue;
                        if (extraTokens + chunk.tokens > RECOMMENDER_EXTRA_BUDGET) continue;
                        relevantLore.push(chunk);
                        alreadyIn.add(chunk.id);
                        extraTokens += chunk.tokens;
                    }

                    if (extraTokens > 0) console.log(`[TurnContext] Recommender injected lore (${extraTokens} extra tokens)`);
                }
            }
        } catch (err) {
            console.warn('[TurnOrchestrator] UtilityAI recommender failed:', err);
        }
    }

    const freshMessages = state.getMessages().filter(m => m.id !== userMsgId);
    callbacks.setLoadingStatus?.('[5/5] Architecting AI Prompt...');

    const semanticallyRecalledNpcIds = await recallNpcsSemantically({
        activeCampaignId, npcLedger, freshMessages, finalInput,
    });

    const { condenser } = state;

    const payloadResult = buildPayload({
        settings,
        context: state.context,
        history: freshMessages,
        userMessage: finalInput,
        condensedUpToIndex: condenser.condensedUpToIndex,
        relevantLore,
        relevantRules,
        npcLedger,
        archiveRecall: finalArchiveRecall,
        onStageNpcIds: state.onStageNpcIds,
        sceneNumber,
        recommendedNPCNames,
        semanticFactText,
        deepContextSummary,
        divergenceRegister: state.divergenceRegister,
        chapters: state.chapters,
        archiveIndex: state.archiveIndex,
        semanticallyRecalledNpcIds,
        combatState: state.combatState,
        pinnedExcerpts: state.pinnedExcerpts,
    });

    return { relevantLore, relevantRules, sceneNumber, archiveRecall: finalArchiveRecall, semanticArchiveHits, semanticFactText, recommendedNPCNames, deepContextSummary, payloadResult };
}
