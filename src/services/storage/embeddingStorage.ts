import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys, getMany as idbGetMany, delMany as idbDelMany } from 'idb-keyval';

// v4: rule embeddings switched from 500-char-truncated to full content (windowed by
// the embedder worker). Rule vectors with version < 4 are re-embedded by indexRules.
export const EMBEDDING_VERSION = 4;

const LEGACY_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/**
 * Stored vectors are Float32Array (compact: ~4 bytes/dim, stored natively by
 * IndexedDB). Legacy records persisted before 2026-06 are plain `number[]`; the
 * read path tolerates both since cosineSimilarity indexes either, and they
 * upgrade to Float32Array naturally as scenes/lore are re-embedded.
 */
export type VectorLike = Float32Array | number[];

type EmbeddingType = 'scene' | 'lore' | 'npc' | 'rule';
const ALL_TYPES: readonly EmbeddingType[] = ['scene', 'lore', 'npc', 'rule'];

export type EmbeddingRecord = {
    vector: VectorLike;
    version: number;
    updatedAt: number;
    modelId?: string;
};

type CacheEntry = { id: string; vector: VectorLike };

/**
 * In-memory vector cache, keyed `${campaignId}_${type}`. Populated lazily on the
 * first getAll and kept fresh by every write/delete below (all mutations funnel
 * through this module — single chokepoint). Scoped to the active campaign and
 * released on campaign switch via releaseCache(), so only one campaign's vectors
 * are ever resident. This removes the per-turn disk re-read that crashed the app
 * once the store reached ~1k vectors: steady ~1.5 KB/vector instead of jagged
 * per-turn allocate-and-discard spikes.
 */
const cache = new Map<string, CacheEntry[]>();

const cacheKey = (campaignId: string, type: EmbeddingType) => `${campaignId}_${type}`;
const recordKey = (campaignId: string, type: EmbeddingType, id: string) => `nn_embed_${campaignId}_${type}_${id}`;

function normalizeVector(vector: VectorLike): Float32Array {
    return vector instanceof Float32Array ? vector : Float32Array.from(vector);
}

/**
 * Ensure the requested types for a campaign are cached. On a miss, reads all
 * matching records in exactly 2 IndexedDB transactions (keys() + getMany())
 * rather than one transaction per vector.
 */
async function ensureCached(campaignId: string, types: readonly EmbeddingType[]): Promise<void> {
    const missing = types.filter(t => !cache.has(cacheKey(campaignId, t)));
    if (missing.length === 0) return;

    const prefixes = missing.map(t => ({ t, prefix: `nn_embed_${campaignId}_${t}_` }));
    const allKeys = await idbKeys();

    const matched: Array<{ key: IDBValidKey; t: EmbeddingType; id: string }> = [];
    for (const key of allKeys) {
        if (typeof key !== 'string') continue;
        for (const { t, prefix } of prefixes) {
            if (key.startsWith(prefix)) {
                matched.push({ key, t, id: key.slice(prefix.length) });
                break;
            }
        }
    }

    const values = matched.length > 0
        ? await idbGetMany(matched.map(m => m.key)) as Array<EmbeddingRecord | undefined>
        : [];

    // Seed empty buckets so a campaign with zero vectors of a type still caches
    // (empty) and never re-hits the disk on subsequent turns.
    const buckets = new Map<EmbeddingType, CacheEntry[]>();
    for (const t of missing) buckets.set(t, []);
    matched.forEach((m, i) => {
        const rec = values[i];
        if (rec && rec.vector) buckets.get(m.t)!.push({ id: m.id, vector: rec.vector });
    });
    for (const t of missing) cache.set(cacheKey(campaignId, t), buckets.get(t)!);
}

export const embeddingStorage = {
    async store(campaignId: string, id: string, vector: VectorLike, type: EmbeddingType, modelId?: string): Promise<void> {
        const stored = normalizeVector(vector);
        const record: EmbeddingRecord = {
            vector: stored,
            version: EMBEDDING_VERSION,
            updatedAt: Date.now(),
            modelId: modelId ?? LEGACY_MODEL_ID,
        };
        await idbSet(recordKey(campaignId, type, id), record);

        // Keep the cache in sync so a write is immediately visible without a disk
        // round-trip. Only touch the cache if this type is already loaded.
        const arr = cache.get(cacheKey(campaignId, type));
        if (arr) {
            const idx = arr.findIndex(e => e.id === id);
            if (idx >= 0) arr[idx] = { id, vector: stored };
            else arr.push({ id, vector: stored });
        }
    },

    async getRecord(campaignId: string, id: string, type: EmbeddingType): Promise<EmbeddingRecord | null> {
        const entry = await idbGet(recordKey(campaignId, type, id)) as EmbeddingRecord | null;
        return entry ?? null;
    },

    async get(campaignId: string, id: string): Promise<VectorLike | null> {
        const entry = await idbGet(recordKey(campaignId, 'scene', id)) as EmbeddingRecord | null;
        if (entry) return entry.vector;
        const loreEntry = await idbGet(recordKey(campaignId, 'lore', id)) as EmbeddingRecord | null;
        return loreEntry?.vector ?? null;
    },

    async getAll(campaignId: string, type?: EmbeddingType): Promise<Array<{ id: string; vector: VectorLike }>> {
        const types = type ? [type] : ALL_TYPES;
        await ensureCached(campaignId, types);
        const results: CacheEntry[] = [];
        for (const t of types) {
            const arr = cache.get(cacheKey(campaignId, t));
            if (arr) results.push(...arr);
        }
        return results;
    },

    async getAllWithVersion(campaignId: string, type?: EmbeddingType): Promise<Array<{ id: string; vector: VectorLike; version: number; type: EmbeddingType; modelId: string }>> {
        // Disk-backed (not cache-backed): only used by backfill/migration, not the
        // per-turn hot path. Still batched: keys() + getMany() = 2 transactions.
        const types = type ? [type] : ALL_TYPES;
        const prefixes = types.map(t => ({ t, prefix: `nn_embed_${campaignId}_${t}_` }));
        const allKeys = await idbKeys();

        const matched: Array<{ key: IDBValidKey; t: EmbeddingType; id: string }> = [];
        for (const key of allKeys) {
            if (typeof key !== 'string') continue;
            for (const { t, prefix } of prefixes) {
                if (key.startsWith(prefix)) {
                    matched.push({ key, t, id: key.slice(prefix.length) });
                    break;
                }
            }
        }
        if (matched.length === 0) return [];

        const values = await idbGetMany(matched.map(m => m.key)) as Array<EmbeddingRecord | { vector: VectorLike } | undefined>;
        const results: Array<{ id: string; vector: VectorLike; version: number; type: EmbeddingType; modelId: string }> = [];
        matched.forEach((m, i) => {
            const entry = values[i];
            if (entry && entry.vector) {
                const version = 'version' in entry ? entry.version : 1;
                const modelId = 'modelId' in entry && entry.modelId ? entry.modelId : LEGACY_MODEL_ID;
                results.push({ id: m.id, vector: entry.vector, version, type: m.t, modelId });
            }
        });
        return results;
    },

    async hasStaleVectors(campaignId: string, currentModelId: string): Promise<boolean> {
        const all = await this.getAllWithVersion(campaignId);
        return all.some(r => r.modelId !== currentModelId);
    },

    async countByModel(campaignId: string): Promise<Record<string, number>> {
        const all = await this.getAllWithVersion(campaignId);
        const counts: Record<string, number> = {};
        for (const r of all) {
            counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
        }
        return counts;
    },

    async delete(campaignId: string, id: string): Promise<void> {
        await Promise.all(ALL_TYPES.map(t => idbDel(recordKey(campaignId, t, id)).catch(() => {})));
        for (const t of ALL_TYPES) {
            const arr = cache.get(cacheKey(campaignId, t));
            if (!arr) continue;
            const idx = arr.findIndex(e => e.id === id);
            if (idx >= 0) arr.splice(idx, 1);
        }
    },

    async deleteAll(campaignId: string): Promise<void> {
        const prefix = `nn_embed_${campaignId}_`;
        const allKeys = await idbKeys();
        const toDelete = allKeys.filter(k => typeof k === 'string' && k.startsWith(prefix));
        if (toDelete.length > 0) await idbDelMany(toDelete);
        for (const t of ALL_TYPES) cache.delete(cacheKey(campaignId, t));
    },

    async deleteByTypeAndId(campaignId: string, type: EmbeddingType, id: string): Promise<void> {
        await idbDel(recordKey(campaignId, type, id)).catch(() => {});
        const arr = cache.get(cacheKey(campaignId, type));
        if (arr) {
            const idx = arr.findIndex(e => e.id === id);
            if (idx >= 0) arr.splice(idx, 1);
        }
    },

    /**
     * Drop cached vectors. Call on campaign switch/close so only the active
     * campaign's vectors stay resident. No arg = clear everything.
     */
    releaseCache(campaignId?: string): void {
        if (!campaignId) {
            cache.clear();
            return;
        }
        for (const t of ALL_TYPES) cache.delete(cacheKey(campaignId, t));
    },
};
