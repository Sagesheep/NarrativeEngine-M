import { offlineStorage } from '../storage';
import { embedText, isEmbedderReady } from './embedder';

export type SearchHit = {
    id: string;
    score: number;
};

/** Internal hit that carries the vector for MMR computation. Discarded before return. */
type ScoredVector = SearchHit & { vector: ArrayLike<number> };

/**
 * Balance between query-relevance (1.0) and diversity (0.0).
 * 0.7 = strongly relevance-leaning, still penalises near-duplicates.
 */
const MMR_LAMBDA = 0.7;

/**
 * Minimum pool size before MMR is worth running.
 * Below this the diversity benefit is negligible and we skip for speed.
 */
const MMR_MIN_POOL = 4;

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

/**
 * Greedy Maximal Marginal Relevance selection.
 * Picks `topK` items from `pool` balancing query-relevance against similarity
 * to already-selected items, using `lambda` to weight the trade-off.
 *
 * Pure computation — no I/O, no async. Runs fine in Lite mode.
 */
export function mmrSelect(pool: ScoredVector[], topK: number, lambda = MMR_LAMBDA): SearchHit[] {
    if (pool.length <= topK) return pool.map(({ id, score }) => ({ id, score }));

    const selected: ScoredVector[] = [];
    const remaining = [...pool];

    // Seed with the highest-relevance candidate
    remaining.sort((a, b) => b.score - a.score);
    selected.push(remaining.shift()!);

    while (selected.length < topK && remaining.length > 0) {
        let bestIdx = -1;
        let bestMmr = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            // Max similarity to any already-selected item
            let maxSim = 0;
            for (const sel of selected) {
                const sim = cosineSimilarity(candidate.vector, sel.vector);
                if (sim > maxSim) maxSim = sim;
            }
            const mmr = lambda * candidate.score - (1 - lambda) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) break;
        selected.push(remaining.splice(bestIdx, 1)[0]);
    }

    return selected.map(({ id, score }) => ({ id, score }));
}

function dedupeSubChunks(hits: ScoredVector[]): ScoredVector[] {
    const bestByBase = new Map<string, ScoredVector>();
    for (const hit of hits) {
        const baseId = hit.id.replace(/#w\d+$/, '');
        const existing = bestByBase.get(baseId);
        if (!existing || hit.score > existing.score) {
            bestByBase.set(baseId, { ...hit, id: baseId });
        }
    }
    const deduped = Array.from(bestByBase.values());
    deduped.sort((a, b) => b.score - a.score);
    return deduped;
}

export async function searchVectors(
    campaignId: string,
    queryVectors: number[][],
    type: 'scene' | 'lore' | 'npc' | 'rule',
    topK = 20,
    minScore = 0
): Promise<SearchHit[]> {
    const allEmbeddings = await offlineStorage.embeddings.getAll(campaignId, type);
    if (allEmbeddings.length === 0) return [];

    const scored: ScoredVector[] = allEmbeddings.map(entry => {
        let maxScore = 0;
        for (const qv of queryVectors) {
            const s = cosineSimilarity(qv, entry.vector);
            if (s > maxScore) maxScore = s;
        }
        return { id: entry.id, score: maxScore, vector: entry.vector };
    });

    scored.sort((a, b) => b.score - a.score);

    const filtered = minScore > 0 ? scored.filter(h => h.score >= minScore) : scored;

    // Dedupe sub-chunks (preserves vectors for MMR) before diversity selection
    const deduped = dedupeSubChunks(filtered);

    // Apply MMR diversity for scene type only; other types use plain top-K
    if (type === 'scene' && deduped.length >= MMR_MIN_POOL) {
        return mmrSelect(deduped, topK);
    }

    return deduped.slice(0, topK).map(({ id, score }) => ({ id, score }));
}

export async function semanticSearch(
    campaignId: string,
    queries: string[],
    type: 'scene' | 'lore' | 'npc' | 'rule',
    topK?: number,
    minScore?: number
): Promise<string[] | undefined> {
    const hits = await semanticSearchScored(campaignId, queries, type, topK, minScore);
    return hits?.map(h => h.id);
}

export async function semanticSearchScored(
    campaignId: string,
    queries: string[],
    type: 'scene' | 'lore' | 'npc' | 'rule',
    topK?: number,
    minScore?: number
): Promise<SearchHit[] | undefined> {
    if (!isEmbedderReady()) return undefined;

    const queryVectors: number[][] = [];
    for (const q of queries) {
        const vec = await embedText(q);
        if (vec) queryVectors.push(Array.from(vec));
    }
    if (queryVectors.length === 0) return undefined;

    const hits = await searchVectors(campaignId, queryVectors, type, topK, minScore ?? 0);

    if (minScore && minScore > 0 && hits.length === 0) {
        const allEmbeddings = await offlineStorage.embeddings.getAll(campaignId, type);
        let bestScore = 0;
        for (const entry of allEmbeddings) {
            for (const qv of queryVectors) {
                const s = cosineSimilarity(qv, entry.vector);
                if (s > bestScore) bestScore = s;
            }
        }
        console.log(`[turnContext] semantic search returned 0 above floor (best=${bestScore.toFixed(3)})`);
    }

    return hits;
}
