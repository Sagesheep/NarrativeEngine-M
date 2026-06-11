import type { AppSettings, ArchiveIndexEntry, LLMProvider, LoreChunk } from '../../../types';
import type { SemanticCandidates } from './retrievalTypes';
import { rerankCandidates, type RerankCandidate } from '../../payload';
import { tierAllows } from '../aiTier';

/**
 * LLM cross-encoder rerank of the scene and lore candidate sets. Only fires when
 * the reranker tier is enabled, an endpoint exists, and there are ≥5 candidates
 * of that kind (below that, vector order is already trustworthy). On any failure
 * the original semantic order is preserved. Rule candidates are never reranked.
 */
export async function rerankStage(params: {
    candidates: SemanticCandidates;
    finalInput: string;
    archiveIndex: ArchiveIndexEntry[];
    loreChunks: LoreChunk[];
    rerankerEndpoint: LLMProvider | undefined;
    settings: AppSettings;
    utilityTimeoutMs: number;
}): Promise<SemanticCandidates> {
    const { candidates, finalInput, archiveIndex, loreChunks, rerankerEndpoint, settings, utilityTimeoutMs } = params;
    let { semanticArchiveIds, semanticArchiveHits, semanticLoreIds } = candidates;
    const { semanticRuleIds } = candidates;

    if (tierAllows(settings.aiTier, 'reranker') && rerankerEndpoint?.endpoint && (semanticArchiveIds?.length || semanticLoreIds?.length)) {
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
                const rerankedIds = await rerankCandidates(finalInput, sceneCandidates, rerankerEndpoint, { maxCandidates: 30, topN: 12, timeoutMs: utilityTimeoutMs, trackingLabel: 'rerank-scene' });
                const scoreLookup = new Map(semanticArchiveHits.map(h => [h.id, h.score]));
                semanticArchiveHits = rerankedIds.map((id, i) => ({ id, score: scoreLookup.get(id) ?? (1 - i * 0.05) }));
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
                const rerankedLoreIds = await rerankCandidates(finalInput, loreCandidates, rerankerEndpoint, { maxCandidates: 25, topN: 10, timeoutMs: utilityTimeoutMs, trackingLabel: 'rerank-lore' });
                semanticLoreIds = rerankedLoreIds;
                console.log(`[Reranker] Lore candidates: ${rerankedLoreIds.length} after rerank`);
            }
        } catch (err) {
            console.warn('[Reranker] Failed, using semantic order:', err);
        }
    }

    return { semanticArchiveIds, semanticArchiveHits, semanticLoreIds, semanticRuleIds };
}
