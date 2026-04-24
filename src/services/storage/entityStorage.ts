import type { EntityEntry } from '../../types';
import { getList, setList, k } from './_helpers';
import { normalizeEntityName } from '../../utils/entityResolution';

export const entityStorage = {
    async get(cid: string): Promise<EntityEntry[]> {
        return getList(k(cid, 'entities'));
    },
    async merge(cid: string, survivorId: string, absorbedId: string): Promise<{ ok: boolean } | null> {
        const entities = await getList<EntityEntry>(k(cid, 'entities'));
        const survivor = entities.find(e => e.id === survivorId);
        const absorbed = entities.find(e => e.id === absorbedId);
        if (!survivor || !absorbed) return null;
        survivor.aliases = [...new Set([...(survivor.aliases || []), absorbed.name, ...(absorbed.aliases || [])])];
        await setList(k(cid, 'entities'), entities.filter(e => e.id !== absorbedId));
        return { ok: true };
    },
    async resolve(cid: string, name: string): Promise<string> {
        const entities = await getList<EntityEntry>(k(cid, 'entities'));
        return normalizeEntityName(name, entities);
    },
};
