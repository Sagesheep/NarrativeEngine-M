import type { LoreChunk, ArchiveScene } from '../../types';
import type { TurnCallbacks, TurnState, UtilityLLM } from './turnTypes';
import { realUtilityLLM } from './utilityLLM';
import { tierAllows } from './aiTier';
import { buildPayload } from '../chatEngine';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes, deepArchiveScan, recallWithChapterFunnel } from '../archive';
import { offlineStorage } from '../storage';
import { recommendContext } from '../payload';
import { getDivergenceSceneIds, EMPTY_REGISTER } from '../campaign-state';
import type { SearchHit } from '../embedding/vectorSearch';
import { countTokens } from '../infrastructure';
import { runPlannerCall, type PlannerResult } from './stages/plannerStage';
import { gatherFactsAndTimeline } from './stages/factsTimelineStage';
import { recallNpcsSemantically } from './stages/npcSemanticRecallStage';
import { semanticCandidatesStage } from './stages/semanticCandidatesStage';
import { rerankStage } from './stages/rerankStage';
import { loreStage } from './stages/loreStage';
import { rulesStage } from './stages/rulesStage';

// How long gatherContext waits for the chapter funnel before falling back to
// flat recall. On timeout the funnel is aborted (so its remaining validation
// calls stop spending) and flat recall runs instead — never a turn with zero
// archive memory (AUDIT F1).
const FUNNEL_RACE_TIMEOUT_MS = 5000;

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

    callbacks.setLoadingStatus?.('[3/5] Recalling Archive Memory...');
    let archiveResult = { scenes: [] as ArchiveScene[], usedTokens: 0 };
    const { chapters, semanticFacts } = state;

    // Size the recall fetch to the world budget it has to live in, so a full
    // recall can't overflow and get dropped whole by trimWorldBlocks (AUDIT F5).
    // Use the non-deep world factor (0.40) — deepContextSummary isn't known yet,
    // and a conservative estimate is the safe side here.
    const contextLimit = settings.contextLimit || 8192;
    const rulesReserve = Math.max(50, Math.floor(contextLimit * (settings.rulesBudgetPct ?? 0.10)));
    const worldBudgetEstimate = Math.floor((contextLimit - rulesReserve) * 0.40);
    const archiveRecallBudget = Math.max(600, Math.min(3000, worldBudgetEstimate));

    // Single source of truth for flat recall — used as the funnel's fallback
    // (on both timeout and error) and as the no-funnel path. Divergence-scene
    // forcing and planner filters are applied here.
    const semanticForRecall = semanticArchiveHits.length > 0 ? semanticArchiveHits : semanticArchiveIds;
    const flatRecallFallback = (): Promise<ArchiveScene[]> =>
        recallArchiveScenes(
            activeCampaignId!, archiveIndex, finalInput, messages, archiveRecallBudget, npcLedger, semanticFacts,
            semanticForRecall, getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), undefined, plannerFilters
        ).then(scenes => scenes || []);

    if (tierAllows(settings.aiTier, 'archiveFunnel') && chapters.length > 0 && activeCampaignId) {
        const funnelAbort = new AbortController();
        try {
            const utilityEndpoint = utilityLLM.endpoint();
            if (!utilityEndpoint) throw new Error('No utility endpoint');
            const funnelPromise = recallWithChapterFunnel(
                activeCampaignId, chapters, archiveIndex, finalInput, messages, npcLedger, semanticFacts, archiveRecallBudget, utilityEndpoint, undefined, semanticForRecall, funnelAbort.signal,
                getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), plannerFilters
            );
            let fallbackTimeoutId: ReturnType<typeof setTimeout>;
            const fallbackPromise = new Promise<{ scenes: string; usedTokens: number } | null>(resolve => {
                fallbackTimeoutId = setTimeout(resolve, FUNNEL_RACE_TIMEOUT_MS) as unknown as ReturnType<typeof setTimeout>;
            }).then(() => null);

            const result = await Promise.race([
                funnelPromise.finally(() => clearTimeout(fallbackTimeoutId)),
                fallbackPromise
            ]);
            if (result) {
                archiveResult = { scenes: [] as ArchiveScene[], usedTokens: result.usedTokens };
                const sceneMatches = (result.scenes as string).match(/--- SCENE (\d+) ---\n([\s\S]*?)(?=\n--- SCENE \d+ ---|$)/g);
                if (sceneMatches) {
                    archiveResult.scenes = sceneMatches.map(match => {
                        const idMatch = match.match(/--- SCENE (\d+) ---/);
                        const content = match.replace(/--- SCENE \d+ ---\n/, '').trim();
                        return { sceneId: idMatch ? idMatch[1] : '', content, tokens: countTokens(content) };
                    });
                }
            } else {
                // Funnel lost the race (slow utility endpoint). Abort it so its
                // remaining validation calls stop spending, then fall back to flat
                // recall so the turn still has archive memory (AUDIT F1).
                funnelAbort.abort();
                console.warn(`[Funnel] lost ${FUNNEL_RACE_TIMEOUT_MS}ms race — falling back to flat recall`);
                archiveResult = { scenes: await flatRecallFallback(), usedTokens: 0 };
            }
        } catch (err) {
            funnelAbort.abort();
            console.warn('[Funnel] failed — falling back to flat recall:', err);
            if (activeCampaignId) {
                archiveResult = { scenes: await flatRecallFallback(), usedTokens: 0 };
            }
        }
    } else if (archiveIndex.length > 0 && activeCampaignId) {
        // Covers: (a) no chapters yet, (b) archiveFunnel tier-gated — fall through to engine flat-recall
        archiveResult = { scenes: await flatRecallFallback(), usedTokens: 0 };
    }

    const archiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    // ── Pinned Chapter Injection ──
    if (state.pinnedChapterIds.length > 0 && activeCampaignId) {
        const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));

        const pinnedRanges: [string, string][] = state.pinnedChapterIds
            .map(id => state.chapters.find(c => c.chapterId === id))
            .filter((c): c is import('../../types').ArchiveChapter => !!c)
            .map(c => c.sceneRange);

        if (pinnedRanges.length > 0) {
            try {
                const scoredIds = retrieveArchiveMemory(
                    archiveIndex, finalInput, messages, npcLedger,
                    undefined, semanticFacts, pinnedRanges, semanticArchiveHits.length > 0 ? semanticArchiveHits : semanticArchiveIds,
                    getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), plannerFilters
                ).filter(id => !alreadyCoveredIds.has(id));

                if (scoredIds.length > 0) {
                    // Pinned scenes share the world budget with the recall above —
                    // give them what recall left, not an independent 35% of the whole
                    // context (which used to push the combined block past the world
                    // budget and get it dropped, AUDIT F5).
                    const recallUsed = archiveResult.scenes.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
                    const pinnedBudget = Math.max(0, worldBudgetEstimate - recallUsed);
                    const pinnedScenes = pinnedBudget > 150
                        ? await fetchArchiveScenes(activeCampaignId, scoredIds, pinnedBudget)
                        : [];
                    archiveResult.scenes = [...(archiveResult.scenes ?? []), ...pinnedScenes];
                    console.log(`[Pin] Injected ${pinnedScenes.length} scored scenes from ${pinnedRanges.length} pinned chapter(s)`);
                }
            } catch (err) {
                console.warn('[Pin] Failed to fetch pinned scenes:', err);
            }
        }
        state.clearPinnedChapters();
    }

    // ── Deep Archive Scan (one-shot when GM long-presses Send) ──
    let deepContextSummary: string | undefined;
    if (state.deepContextSearch && tierAllows(settings.aiTier, 'deepScan') && activeCampaignId) {
        const utilityForDeep = utilityLLM.endpoint();
        if (utilityForDeep?.endpoint) {
            try {
                const sealedChapters = (state.chapters ?? []).filter(c => c.sealedAt !== undefined);
                const deepBudget = Math.floor((settings.contextLimit || 8192) * 0.45);
                const brief = await deepArchiveScan(
                    utilityForDeep,
                    archiveIndex,
                    sealedChapters,
                    activeCampaignId,
                    state.getMessages().filter(m => m.id !== userMsgId),
                    finalInput,
                    deepBudget,
                    (msg) => callbacks.setLoadingStatus?.(msg),
                );
                if (brief) deepContextSummary = brief;
            } catch (err) {
                console.warn('[DeepArchiveSearch] Failed, using standard recall:', err);
            }
        } else {
            console.warn('[DeepArchiveSearch] No utility endpoint configured — deep scan skipped.');
        }
    }

    const finalArchiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    const semanticFactText = await gatherFactsAndTimeline({
        semanticFacts, finalInput, messages, npcLedger, timeline: state.timeline,
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
