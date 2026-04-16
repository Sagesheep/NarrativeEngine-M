import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

export const embeddingStorage = {
    async store(campaignId: string, id: string, vector: number[], type: 'scene' | 'lore'): Promise<void> {
        await idbSet(`nn_embed_${campaignId}_${type}_${id}`, { vector });
    },

    async get(campaignId: string, id: string): Promise<number[] | null> {
        const entry = await idbGet(`nn_embed_${campaignId}_scene_${id}`) as { vector: number[] } | null;
        if (entry) return entry.vector;
        const loreEntry = await idbGet(`nn_embed_${campaignId}_lore_${id}`) as { vector: number[] } | null;
        return loreEntry?.vector ?? null;
    },

    async getAll(campaignId: string, type?: 'scene' | 'lore'): Promise<Array<{ id: string; vector: number[] }>> {
        const results: Array<{ id: string; vector: number[] }> = [];
        const types = type ? [type] : ['scene', 'lore'] as const;
        for (const t of types) {
            const prefix = `nn_embed_${campaignId}_${t}_`;
            const allKeys = await import('idb-keyval').then(m => m.keys());
            for (const key of allKeys) {
                if (typeof key === 'string' && key.startsWith(prefix)) {
                    const id = key.slice(prefix.length);
                    const entry = await idbGet(key) as { vector: number[] } | null;
                    if (entry) results.push({ id, vector: entry.vector });
                }
            }
        }
        return results;
    },

    async delete(campaignId: string, id: string): Promise<void> {
        await idbDel(`nn_embed_${campaignId}_scene_${id}`).catch(() => {});
        await idbDel(`nn_embed_${campaignId}_lore_${id}`).catch(() => {});
    },

    async deleteAll(campaignId: string): Promise<void> {
        const allKeys = await import('idb-keyval').then(m => m.keys());
        const prefix = `nn_embed_${campaignId}_`;
        for (const key of allKeys) {
            if (typeof key === 'string' && key.startsWith(prefix)) {
                await idbDel(key);
            }
        }
    },
};
