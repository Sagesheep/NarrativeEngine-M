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
import { getDivergenceSceneIds } from './divergenceRegister';
import { EMPTY_REGISTER } from './divergenceRegister';
import { rerankCandidates, type RerankCandidate } from './semanticReranker';
import type { LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';

const SEMANTIC_FLOOR_SCENE = 0.30;
const SEMANTIC_FLOOR_LORE = 0.30;

const CALLBACK_REGEX = /\b(remember|earlier|back when|before|previously|that .*(we|i) (did|met|fought|saw|found|got))\b/i;

async function expandQuery(query: string, npcLedger: import('../types').NPCEntry[], utilityEndpoint: LLMProvider): Promise<string[]> {
    try {
        const npcContext = npcLedger.slice(0, 10).map(n => n.name).join(', ');
        const prompt = `User query: "${query}"
Known NPCs: ${npcContext}
Generate 2 alternative phrasings that expand pronouns, add likely entity names from context, and use synonyms. Return ONLY a JSON array of 2 strings. No prose.`;

        const raw = await llmCall(utilityEndpoint, prompt, {
            temperature: 0.2,
            priority: 'high',
            maxTokens: 200,
        });

        let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const bracketStart = clean.indexOf('[');
        const bracketEnd = clean.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1) return [query];

        const parsed = JSON.parse(clean.substring(bracketStart, bracketEnd + 1));
        if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((x: unknown) => typeof x === 'string')) {
            return [query, parsed[0], parsed[1]];
        }
        return [query];
    } catch {
        return [query];
    }
}


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
    const { settings, loreChunks, npcLedger, archiveIndex, activeCampaignId } = state;
    let semanticArchiveIds: string[] | undefined;
    let semanticLoreIds: string[] | undefined;

    if (isEmbedderReady() && activeCampaignId) {
        try {
            let queries = [finalInput];
            const isCallback = CALLBACK_REGEX.test(finalInput);
            const isShort = finalInput.trim().split(/\s+/).length < 8;
            const expansionEndpoint = state.getUtilityEndpoint?.();
            if ((isCallback || isShort) && expansionEndpoint?.endpoint) {
                const expanded = await expandQuery(finalInput, npcLedger, expansionEndpoint);
                queries = expanded;
                if (expanded.length > 1) {
                    console.log(`[QueryExpansion] "${finalInput}" → ${expanded.length} variants`);
                }
            }

            const [sceneIds, loreIds] = await Promise.all([
                semanticSearch(activeCampaignId, queries, 'scene', 40, SEMANTIC_FLOOR_SCENE),
                semanticSearch(activeCampaignId, queries, 'lore', 25, SEMANTIC_FLOOR_LORE),
            ]);
            semanticArchiveIds = sceneIds;
            semanticLoreIds = loreIds;

            if (semanticArchiveIds?.length) console.log(`[Semantic] Found ${semanticArchiveIds.length} scene candidates`);
            if (semanticLoreIds?.length) console.log(`[Semantic] Found ${semanticLoreIds.length} lore candidates`);
        } catch (e) {
            console.warn('[Semantic] Candidate search failed, using keyword fallback:', e);
        }
    }

    const rerankerEndpoint = state.getUtilityEndpoint?.();
    if (rerankerEndpoint?.endpoint && (semanticArchiveIds?.length || semanticLoreIds?.length)) {
        try {
            if (semanticArchiveIds && semanticArchiveIds.length >= 5) {
                const sceneCandidates: RerankCandidate[] = semanticArchiveIds.map(id => {
                    const idxEntry = archiveIndex.find(e => e.sceneId === id);
                    return {
                        id,
                        summary: idxEntry ? `${idxEntry.userSnippet} — ${idxEntry.keywords.slice(0, 5).join(', ')}` : id,
                        type: 'scene' as const,
                    };
                });
                const rerankedIds = await rerankCandidates(finalInput, sceneCandidates, rerankerEndpoint, { maxCandidates: 30, topN: 12 });
                semanticArchiveIds = rerankedIds;
                console.log(`[Reranker] Scene candidates: ${rerankedIds.length} after rerank`);
            }

            if (semanticLoreIds && semanticLoreIds.length >= 5) {
                const loreCandidates: RerankCandidate[] = semanticLoreIds.map(id => {
                    const chunk = loreChunks.find(c => c.id === id);
                    return {
                        id,
                        summary: chunk ? `${chunk.header} — ${chunk.summary || chunk.content.slice(0, 80)}` : id,
                        type: 'lore' as const,
                    };
                });
                const rerankedLoreIds = await rerankCandidates(finalInput, loreCandidates, rerankerEndpoint, { maxCandidates: 25, topN: 10 });
                semanticLoreIds = rerankedLoreIds;
                console.log(`[Reranker] Lore candidates: ${rerankedLoreIds.length} after rerank`);
            }
        } catch (err) {
            console.warn('[Reranker] Failed, using semantic order:', err);
        }
    }

    const messages = state.getMessages();
    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, finalInput, 1200, messages, semanticLoreIds)
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
                const flatRecall = await recallArchiveScenes(activeCampaignId, archiveIndex, finalInput, messages, 3000, npcLedger, semanticFacts, semanticArchiveIds, getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER));
                archiveResult = { scenes: flatRecall || [], usedTokens: 0 };
            }
        }
    } else if (archiveIndex.length > 0 && activeCampaignId) {
        const flatRecall = await recallArchiveScenes(
            activeCampaignId, archiveIndex, finalInput, messages, 3000, npcLedger, semanticFacts, semanticArchiveIds, getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER)
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
        settings, state.context, freshMessages, finalInput,
        condenser.condensedUpToIndex, relevantLore, npcLedger, finalArchiveRecall, recommendedNPCNames, semanticFactText, deepContextSummary,
        state.divergenceRegister,
        state.chapters
    );

    return { relevantLore, sceneNumber, archiveRecall: finalArchiveRecall, semanticFactText, recommendedNPCNames, deepContextSummary, payloadResult };
}
