import { offlineStorage } from './offlineStorage';
import { embedText, isEmbedderReady } from './embedder';

export type SearchHit = {
    id: string;
    score: number;
};

export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

export async function searchVectors(
    campaignId: string,
    queryVector: number[],
    type: 'scene' | 'lore',
    topK = 20
): Promise<SearchHit[]> {
    const allEmbeddings = await offlineStorage.embeddings.getAll(campaignId, type);
    if (allEmbeddings.length === 0) return [];

    const scored = allEmbeddings.map(entry => ({
        id: entry.id,
        score: cosineSimilarity(queryVector, entry.vector),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}

export async function semanticSearch(
    campaignId: string,
    query: string,
    type: 'scene' | 'lore',
    topK?: number
): Promise<string[] | undefined> {
    if (!isEmbedderReady()) return undefined;

    const queryVector = await embedText(query);
    if (!queryVector) return undefined;

    const hits = await searchVectors(campaignId, Array.from(queryVector), type, topK);
    return hits.map(h => h.id);
}
