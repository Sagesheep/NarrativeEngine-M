import type { LoreChunk, ArchiveScene } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { buildPayload } from './chatEngine';
import { retrieveRelevantLore } from './loreRetriever';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';
import { countTokens } from './tokenizer';
import { offlineStorage } from './storage';
import { recommendContext } from './contextRecommender';
import { deepArchiveScan } from './deepArchiveSearch';
import { queryFacts, formatFactsForContext } from './semanticMemory';
import { formatResolvedForContext } from './timelineResolver';
import { recallWithChapterFunnel } from './archiveChapterEngine';
import { isEmbedderReady } from './embedder';
import { semanticSearch } from './vectorSearch';


export type GatheredContext = {
    relevantLore: LoreChunk[] | undefined;
    sceneNumber: string | undefined;
    archiveRecall: ArchiveScene[] | undefined;
    semanticFactText: string;
    recommendedNPCNames: string[] | undefined;
    deepContextSummary: string | undefined;
    payloadResult: ReturnType<typeof buildPayload>;
};

export async function gatherContext(
    state: TurnState,
    callbacks: TurnCallbacks,
    finalInput: string
): Promise<GatheredContext> {
    const { settings, context, loreChunks, npcLedger, archiveIndex, activeCampaignId } = state;
    let semanticArchiveIds: string[] | undefined;
    let semanticLoreIds: string[] | undefined;

    if (isEmbedderReady() && activeCampaignId) {
        try {
            const [sceneIds, loreIds] = await Promise.all([
                semanticSearch(activeCampaignId, finalInput, 'scene', 20),
                semanticSearch(activeCampaignId, finalInput, 'lore', 15),
            ]);
            semanticArchiveIds = sceneIds;
            semanticLoreIds = loreIds;

            if (semanticArchiveIds?.length) console.log(`[Semantic] Found ${semanticArchiveIds.length} scene candidates`);
            if (semanticLoreIds?.length) console.log(`[Semantic] Found ${semanticLoreIds.length} lore candidates`);
        } catch (e) {
            console.warn('[Semantic] Candidate search failed, using keyword fallback:', e);
        }
    }

    const messages = state.getMessages();
    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, finalInput, 1200, messages, semanticLoreIds)
        : undefined;

    let sceneNumber: string | undefined;
    if (activeCampaignId) {
        callbacks.setLoadingStatus?.('[2/5] Fetching Timeline...');
        try {
            const nextScene = await offlineStorage.archive.getNextSceneNumber(activeCampaignId);
            sceneNumber = String(nextScene).padStart(3, '0');
        } catch { /* ignored */ }
    }

    callbacks.setLoadingStatus?.('[3/5] Recalling Archive Memory...');
    let archiveResult = { scenes: [] as ArchiveScene[], usedTokens: 0 };
    const { chapters, semanticFacts } = state;

    if (chapters.length > 0 && activeCampaignId) {
        try {
            const utilityEndpoint = state.getUtilityEndpoint?.();
            if (!utilityEndpoint) throw new Error('No utility endpoint');
            const funnelPromise = recallWithChapterFunnel(
                activeCampaignId, chapters, archiveIndex, finalInput, messages, npcLedger, semanticFacts, 3000, utilityEndpoint, undefined, semanticArchiveIds
            );
            let fallbackTimeoutId: ReturnType<typeof setTimeout>;
            const fallbackPromise = new Promise<{ scenes: string; usedTokens: number } | null>(resolve => {
                fallbackTimeoutId = setTimeout(resolve, 5000) as unknown as ReturnType<typeof setTimeout>;
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
            }
        } catch {
            if (activeCampaignId) {
                const flatRecall = await recallArchiveScenes(activeCampaignId, archiveIndex, finalInput, messages, 3000, npcLedger, semanticFacts, semanticArchiveIds);
                archiveResult = { scenes: flatRecall || [], usedTokens: 0 };
            }
        }
    } else if (archiveIndex.length > 0 && activeCampaignId) {
        const flatRecall = await recallArchiveScenes(
            activeCampaignId, archiveIndex, finalInput, messages, 3000, npcLedger, semanticFacts, semanticArchiveIds
        );
        archiveResult = { scenes: flatRecall || [], usedTokens: 0 };
    }

    const archiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    // ── Pinned Chapter Injection ──
    if (state.pinnedChapterIds.length > 0 && activeCampaignId) {
        const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));

        const pinnedRanges: [string, string][] = state.pinnedChapterIds
            .map(id => state.chapters.find(c => c.chapterId === id))
            .filter((c): c is import('../types').ArchiveChapter => !!c)
            .map(c => c.sceneRange);

        if (pinnedRanges.length > 0) {
            try {
                const scoredIds = retrieveArchiveMemory(
                    archiveIndex, finalInput, messages, npcLedger,
                    undefined, semanticFacts, pinnedRanges, semanticArchiveIds
                ).filter(id => !alreadyCoveredIds.has(id));

                if (scoredIds.length > 0) {
                    const pinnedBudget = Math.floor((settings.contextLimit || 8192) * 0.35);
                    const pinnedScenes = await fetchArchiveScenes(activeCampaignId, scoredIds, pinnedBudget);
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
    if (state.deepContextSearch && activeCampaignId) {
        const utilityForDeep = state.getUtilityEndpoint?.();
        if (utilityForDeep?.endpoint) {
            try {
                const sealedChapters = (state.chapters ?? []).filter(c => c.sealedAt !== undefined);
                const deepBudget = Math.floor((settings.contextLimit || 8192) * 0.45);
                const brief = await deepArchiveScan(
                    utilityForDeep,
                    archiveIndex,
                    sealedChapters,
                    activeCampaignId,
                    state.getMessages(),
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

    let semanticFactText = '';
    try {
        semanticFactText = formatFactsForContext(queryFacts(semanticFacts, finalInput, messages, npcLedger, 500));
    } catch {}

    try {
        const timeline = state.timeline;
        if (timeline && timeline.length > 0) {
            const { resolveTimeline } = await import('./timelineResolver');
            const resolvedText = formatResolvedForContext(resolveTimeline(timeline));
            if (resolvedText) semanticFactText += '\n' + resolvedText;
        }
    } catch {}

    let recommendedNPCNames: string[] | undefined;
    const utilityEndpoint = state.getUtilityEndpoint?.();
    const pinnedChaptersForRecommender = state.pinnedChapterIds.length > 0
        ? state.chapters.filter(c => state.pinnedChapterIds.includes(c.chapterId))
        : undefined;
    if (utilityEndpoint?.endpoint) {
        callbacks.setLoadingStatus?.('[4/5] Consulting AI Recommender...');
        try {
            const recommenderResult = await Promise.race([
                recommendContext(utilityEndpoint, npcLedger, loreChunks, messages, finalInput, pinnedChaptersForRecommender),
                new Promise<null>(resolve => setTimeout(() => {
                    console.warn('[TurnContext] Recommender timeout — proceeding without recommendations');
                    resolve(null);
                }, 15_000)),
            ]);
            if (recommenderResult) {
                recommendedNPCNames = recommenderResult.relevantNPCNames;
            }
        } catch (err) {
            console.warn('[TurnOrchestrator] UtilityAI recommender failed:', err);
        }
    }

    const freshMessages = state.getMessages();
    callbacks.setLoadingStatus?.('[5/5] Architecting AI Prompt...');

    const { condenser } = state;

    const payloadResult = buildPayload(
        settings, state.context, freshMessages, finalInput, condenser.condensedSummary || undefined,
        condenser.condensedUpToIndex, relevantLore, npcLedger, finalArchiveRecall, sceneNumber, recommendedNPCNames, semanticFactText, deepContextSummary
    );

    return { relevantLore, sceneNumber, archiveRecall: finalArchiveRecall, semanticFactText, recommendedNPCNames, deepContextSummary, payloadResult };
}
