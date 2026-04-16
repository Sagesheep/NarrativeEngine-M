import type { LoreChunk, ArchiveScene } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { buildPayload } from './chatEngine';
import { retrieveRelevantLore } from './loreRetriever';
import { recallArchiveScenes } from './archiveMemory';
import { countTokens } from './tokenizer';
import { offlineStorage } from './storage';
import { recommendContext } from './contextRecommender';
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
            const funnelPromise = recallWithChapterFunnel(
                activeCampaignId, chapters, archiveIndex, finalInput, messages, npcLedger, semanticFacts, 3000, utilityEndpoint!, undefined, semanticArchiveIds
            );
            const fallbackPromise = new Promise<{ scenes: string; usedTokens: number } | null>(resolve => setTimeout(resolve, 5000)).then(() => null);

            const result = await Promise.race([funnelPromise, fallbackPromise]);
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
    if (utilityEndpoint?.endpoint) {
        callbacks.setLoadingStatus?.('[4/5] Consulting AI Recommender...');
        try {
            const result = await recommendContext(utilityEndpoint, npcLedger, loreChunks, messages, finalInput);
            recommendedNPCNames = result.relevantNPCNames;
        } catch (err) {
            console.warn('[TurnOrchestrator] UtilityAI recommender failed:', err);
        }
    }

    const freshMessages = state.getMessages();
    callbacks.setLoadingStatus?.('[5/5] Architecting AI Prompt...');

    const { condenser } = state;

    const payloadResult = buildPayload(
        settings, state.context, freshMessages, finalInput, condenser.condensedSummary || undefined,
        condenser.condensedUpToIndex, relevantLore, npcLedger, archiveRecall, sceneNumber, recommendedNPCNames, semanticFactText
    );

    return { relevantLore, sceneNumber, archiveRecall, semanticFactText, recommendedNPCNames, payloadResult };
}
