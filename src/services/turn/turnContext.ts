import type { LoreChunk, ArchiveScene, SceneEventType } from '../../types';
import type { TurnCallbacks, TurnState, UtilityLLM } from './turnTypes';
import { realUtilityLLM } from './utilityLLM';
import { tierAllows } from './aiTier';
import { buildPayload } from '../chatEngine';
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
import { sceneNumberStage } from './stages/sceneNumberStage';
import { recommenderStage } from './stages/recommenderStage';

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

    const sceneNumber = await sceneNumberStage({ state, callbacks });

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

    // Stage 7 — AI recommender (NPC names + missed-lore injection into relevantLore).
    const recommendedNPCNames = await recommenderStage({
        state, callbacks, finalInput, messages, relevantLore, utilityLLM, utilityTimeoutMs,
    });

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
        pinnedExcerpts: state.pinnedExcerpts,
        plannerEventTypes: plannerResult?.filters?.eventTypes as SceneEventType[] | undefined,
    });

    return { relevantLore, relevantRules, sceneNumber, archiveRecall: finalArchiveRecall, semanticArchiveHits, semanticFactText, recommendedNPCNames, deepContextSummary, payloadResult };
}
