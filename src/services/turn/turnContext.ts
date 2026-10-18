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
import { recommenderStage, injectRecommendedLore } from './stages/recommenderStage';

export type GatheredContext = {
    relevantLore: LoreChunk[] | undefined;
    relevantRules: LoreChunk[] | undefined;
    archiveRecall: ArchiveScene[] | undefined;
    semanticArchiveHits: SearchHit[];
    semanticFactText: string;
    recommendedNPCNames: string[] | undefined;
    deepContextSummary: string | undefined;
    payloadResult: ReturnType<typeof buildPayload>;
};

export type DirectorSignals = {
    /** The Director Brief, or the still-running Director call. The gather runs
     *  alongside it and waits for it only when the payload is built. */
    directorBrief?: string | Promise<string | undefined>;
    absoluteCommand?: string;
};

export async function gatherContext(
    state: TurnState,
    callbacks: TurnCallbacks,
    finalInput: string,
    userMsgId: string,
    utilityLLM: UtilityLLM = realUtilityLLM(() => state.getUtilityEndpoint?.()),
    directorSignals: DirectorSignals = {},
): Promise<GatheredContext> {
    const { settings, loreChunks, npcLedger, archiveIndex, activeCampaignId } = state;
    const utilityTimeoutMs = (settings.utilityTimeoutSeconds ?? 45) * 1000;
    const messages = state.getMessages().filter(m => m.id !== userMsgId);

    const plannerEndpoint = utilityLLM.endpoint();
    let plannerPromise: Promise<PlannerResult | null> = Promise.resolve(null);
    if (tierAllows(settings.aiTier, 'planner') && plannerEndpoint?.endpoint) {
        const chapterSummary = state.chapters.length > 0 ? state.chapters[state.chapters.length - 1].summary : undefined;
        plannerPromise = runPlannerCall(finalInput, messages.slice(-8), npcLedger, chapterSummary, utilityLLM, settings.utilityTimeoutSeconds);
    }

    // Every track that needs nothing from another starts now, side by side (desktop
    // contextGatherer pattern). They used to run one after another, so the turn
    // waited for the sum of them instead of the slowest.
    const recommenderPromise = recommenderStage({ state, finalInput, messages, utilityLLM, utilityTimeoutMs });
    const deepScanPromise = deepScanStage({ state, callbacks, finalInput, userMsgId, utilityLLM });
    const npcRecallPromise = recallNpcsSemantically({ activeCampaignId, npcLedger, freshMessages: messages, finalInput });
    const factsPromise = gatherFactsAndTimeline({
        semanticFacts: state.semanticFacts, finalInput, messages, npcLedger, timeline: state.timeline,
    });

    // Vector candidates → LLM rerank. Also resolves the planner when the embedder
    // runs (planner ∥ query-expansion); otherwise plannerResult comes back null and
    // the planner is awaited below.
    const sem = await semanticCandidatesStage({
        activeCampaignId, finalInput, npcLedger, settings, plannerPromise, utilityLLM, utilityTimeoutMs,
        recentMessages: messages,
    });
    const { semanticArchiveIds, semanticArchiveHits, semanticLoreIds, semanticRuleIds } = await rerankStage({
        candidates: sem.candidates,
        finalInput, archiveIndex, loreChunks, npcLedger,
        rerankerEndpoint: utilityLLM.endpoint(),
        settings, utilityTimeoutMs,
    });
    const plannerResult = sem.plannerResult ?? await plannerPromise;
    const plannerFilters = plannerResult?.filters;

    // World-lore RAG (sync) and rules RAG, then archive recall (flat recall →
    // pinned-chapter injection). Recall runs while the other tracks finish.
    const relevantLore = loreStage({ loreChunks, finalInput, messages, semanticLoreIds });
    const [relevantRules, archiveResult, recommender, deepContextSummary, semanticFactText, semanticallyRecalledNpcIds] = await Promise.all([
        rulesStage({ context: state.context, settings, finalInput, messages, semanticRuleIds }),
        archiveRecallStage({
            state, finalInput, messages,
            semanticArchiveHits, semanticArchiveIds, plannerFilters, utilityLLM,
        }),
        recommenderPromise,
        deepScanPromise,
        factsPromise,
        npcRecallPromise,
    ]);

    // Recommender lore picks that keyword/semantic retrieval missed join the lore.
    injectRecommendedLore(relevantLore, recommender.relevantLoreIds, loreChunks);
    const { recommendedNPCNames } = recommender;
    const finalArchiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    const directorBrief = await directorSignals.directorBrief;
    callbacks.setLoadingStatus?.('Architecting AI Prompt...');

    const { condenser } = state;

    const payloadResult = buildPayload({
        settings,
        context: state.context,
        history: messages,
        userMessage: finalInput,
        condensedUpToIndex: condenser.condensedUpToIndex,
        relevantLore,
        relevantRules,
        npcLedger,
        archiveRecall: finalArchiveRecall,
        onStageNpcIds: state.onStageNpcIds,
        recommendedNPCNames,
        semanticFactText,
        deepContextSummary,
        divergenceRegister: state.divergenceRegister,
        chapters: state.chapters,
        archiveIndex: state.archiveIndex,
        semanticallyRecalledNpcIds,
        pinnedExcerpts: state.pinnedExcerpts,
        plannerEventTypes: plannerResult?.filters?.eventTypes as SceneEventType[] | undefined,
        directorBrief,
        absoluteCommand: directorSignals.absoluteCommand,
    });

    return { relevantLore, relevantRules, archiveRecall: finalArchiveRecall, semanticArchiveHits, semanticFactText, recommendedNPCNames, deepContextSummary, payloadResult };
}
