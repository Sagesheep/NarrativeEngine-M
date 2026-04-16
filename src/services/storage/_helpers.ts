import { get as idbGet, set as idbSet } from 'idb-keyval';

export type SceneRecord = { sceneId: string; userContent: string; assistantContent: string; timestamp: number };

export async function getList<T>(key: string): Promise<T[]> {
    return (await idbGet(key)) || [];
}

export async function setList<T>(key: string, data: T[]): Promise<void> {
    await idbSet(key, data);
}

export function k(cid: string, suffix: string) { return `${cid}_${suffix}`; }

export function computeHash(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        const chr = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return hash.toString(16);
}
