import fs from 'node:fs';
import path from 'node:path';
import type { EvalCampaign, VectorsCache } from './evalTypes';

// Loads fixture campaigns + their cached vectors, and builds the deterministic
// substitutes the eval suite injects in place of the live embedder and storage.
// The cache is produced offline by `npm run eval:build` (the real MiniLM model).

const campaignDir = (id: string) => path.resolve(process.cwd(), 'src/services/__evals__/fixtures', id);

export function loadCampaign(id: string): EvalCampaign {
    return JSON.parse(fs.readFileSync(path.join(campaignDir(id), 'campaign.json'), 'utf8'));
}

export function loadVectors(id: string): VectorsCache {
    const p = path.join(campaignDir(id), 'vectors.json');
    if (!fs.existsSync(p)) {
        throw new Error(`[eval] missing ${p} — run \`npm run eval:build\` to generate cached vectors.`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Replacement for `../embedding/embedder`. embedText resolves the cached query
 * vector by exact text (queries are pre-embedded by the builder); always ready.
 */
export function buildEmbedderMock(id: string) {
    const cache = loadVectors(id);
    return {
        isEmbedderReady: () => true,
        embedText: async (text: string): Promise<Float32Array | null> => {
            const v = cache.queries[text];
            return v ? Float32Array.from(v) : null;
        },
        embedBatch: async (texts: string[]): Promise<(Float32Array | null)[]> =>
            texts.map(t => (cache.queries[t] ? Float32Array.from(cache.queries[t]) : null)),
        getEmbedDims: () => cache.dims,
        getCurrentModelId: () => cache.model,
        warmupEmbedder: async () => {},
    };
}

/**
 * Replacement for `../storage`. Only embeddings.getAll is exercised by the vector
 * search path; it returns the cached document vectors for the requested type.
 */
export function buildStorageMock(id: string) {
    const cache = loadVectors(id);
    return {
        offlineStorage: {
            embeddings: {
                getAll: async (_campaignId: string, type?: 'scene' | 'lore' | 'npc' | 'rule') =>
                    type ? (cache.docs[type] ?? []) : Object.values(cache.docs).flat(),
            },
        },
    };
}
