import type { ArchiveChapter, ArchiveScene, ChatMessage } from '../../../types';
import type { SearchHit } from '../../embedding/vectorSearch';
import type { TurnCallbacks, TurnState, UtilityLLM } from '../turnTypes';
import type { PlannerResult } from './plannerStage';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes, recallWithChapterFunnel } from '../../archive';
import { getDivergenceSceneIds, EMPTY_REGISTER } from '../../campaign-state';
import { countTokens } from '../../infrastructure';
import { tierAllows } from '../aiTier';

// How long to wait for the chapter funnel before falling back to flat recall.
// On timeout the funnel is aborted (so its remaining validation calls stop
// spending) and flat recall runs instead — never a turn with zero archive
// memory (AUDIT F1).
const FUNNEL_RACE_TIMEOUT_MS = 5000;

/**
 * Archive recall: chapter funnel (raced against a timeout) → flat-recall fallback
 * → pinned-chapter injection. Returns the assembled scenes. Recall is sized to
 * the world budget it must live in so a full recall can't overflow and get
 * dropped whole by trimWorldBlocks (AUDIT F5). Behavior-identical extraction —
 * the Promise.race semantics and in-place pinned mutation are reproduced exactly.
 */
export async function archiveRecallStage(params: {
    state: TurnState;
    callbacks: TurnCallbacks;
    finalInput: string;
    messages: ChatMessage[];
    semanticArchiveHits: SearchHit[];
    semanticArchiveIds: string[] | undefined;
    plannerFilters: PlannerResult['filters'] | undefined;
    utilityLLM: UtilityLLM;
}): Promise<{ scenes: ArchiveScene[] }> {
    const { state, callbacks, finalInput, messages, semanticArchiveHits, semanticArchiveIds, plannerFilters, utilityLLM } = params;
    const { settings, archiveIndex, npcLedger, activeCampaignId, chapters, semanticFacts } = state;

    callbacks.setLoadingStatus?.('[3/5] Recalling Archive Memory...');
    let archiveResult = { scenes: [] as ArchiveScene[], usedTokens: 0 };

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
            .filter((c): c is ArchiveChapter => !!c)
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

    return { scenes: archiveResult.scenes };
}
