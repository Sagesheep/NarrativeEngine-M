import type { AppSettings, ArchiveIndexEntry, LLMProvider, LoreChunk, NPCEntry } from '../../../types';
import type { SemanticCandidates } from './retrievalTypes';
import { rerankCandidates, type RerankCandidate } from '../../payload';
import { tierAllows } from '../aiTier';

/** What the reranker sees of a scene: what happened (event tags), who was there, and
 *  the player's line. The player's line + 5 keywords alone was too thin to judge
 *  relevance (port of mainApp's sceneRerankSummary). */
export function sceneRerankSummary(entry: ArchiveIndexEntry, npcNameById: ReadonlyMap<string, string>): string {
    const events = (entry.events ?? []).map(e => e.text).filter(Boolean).slice(0, 3);
    const what = events.length > 0 ? events.join('; ') : entry.keywords.slice(0, 5).join(', ');
    const witnessed = (entry.npcsWitnessed ?? []).map(id => npcNameById.get(id)).filter((n): n is string => !!n);
    const who = (witnessed.length > 0 ? witnessed : entry.npcsMentioned ?? []).slice(0, 6).join(', ');
    return [what, who ? `present: ${who}` : '', `player: ${entry.userSnippet}`].filter(Boolean).join(' | ');
}

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
    npcLedger: NPCEntry[];
    rerankerEndpoint: LLMProvider | undefined;
    settings: AppSettings;
    utilityTimeoutMs: number;
}): Promise<SemanticCandidates> {
    const { candidates, finalInput, archiveIndex, loreChunks, npcLedger, rerankerEndpoint, settings, utilityTimeoutMs } = params;
    let { semanticArchiveIds, semanticArchiveHits, semanticLoreIds } = candidates;
    const { semanticRuleIds } = candidates;

    if (tierAllows(settings.aiTier, 'reranker') && rerankerEndpoint?.endpoint && (semanticArchiveIds?.length || semanticLoreIds?.length)) {
        try {
            // The two reranks are independent model calls; run them side by side.
            const rerankScenes = async () => {
                if (!semanticArchiveIds || semanticArchiveIds.length < 5) return;
                const npcNameById = new Map(npcLedger.map(n => [n.id, n.name]));
                const sceneCandidates: RerankCandidate[] = semanticArchiveIds.map(id => {
                    const idxEntry = archiveIndex.find(e => e.sceneId === id);
                    return {
                        id,
                        summary: idxEntry ? sceneRerankSummary(idxEntry, npcNameById) : id,
                        type: 'scene' as const,
                    };
                });
                const rerankedIds = await rerankCandidates(finalInput, sceneCandidates, rerankerEndpoint, { maxCandidates: 30, topN: 12, timeoutMs: utilityTimeoutMs, trackingLabel: 'rerank-scene' });
                const scoreLookup = new Map(semanticArchiveHits.map(h => [h.id, h.score]));
                semanticArchiveHits = rerankedIds.map((id, i) => ({ id, score: scoreLookup.get(id) ?? (1 - i * 0.05) }));
                semanticArchiveIds = rerankedIds;
                console.log(`[Reranker] Scene candidates: ${rerankedIds.length} after rerank`);
            };

            const rerankLore = async () => {
                if (!semanticLoreIds || semanticLoreIds.length < 5) return;
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
            };

            await Promise.all([rerankScenes(), rerankLore()]);
        } catch (err) {
            console.warn('[Reranker] Failed, using semantic order:', err);
        }
    }

    return { semanticArchiveIds, semanticArchiveHits, semanticLoreIds, semanticRuleIds };
}
