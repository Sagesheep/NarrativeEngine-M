import { embeddingStorage, EMBEDDING_VERSION } from '../storage/embeddingStorage';
import { embedText, isEmbedderReady, warmupEmbedder, getCurrentModelId } from './embedder';
import { getList, k, type SceneRecord } from '../storage/_helpers';
import { buildNPCEmbeddingText } from '../npcGeneration';
import type { NPCEntry } from '../../types';
import { get as idbGet } from 'idb-keyval';

const RULE_EMBED_SLICE = 500;


export type BackfillProgress = {
    total: number;
    done: number;
    current: string;
};

let backfillCursor: { campaignId: string; type: 'scene' | 'lore' | 'npc' | 'rule'; index: number } | null = null;

function setBackfillCursor(cursor: typeof backfillCursor) {
    backfillCursor = cursor;
}

export function getBackfillCursor() {
    return backfillCursor;
}

export async function runBackfill(
    campaignId: string,
    onProgress?: (progress: BackfillProgress) => void
): Promise<void> {
    if (!isEmbedderReady()) {
        await warmupEmbedder();
        if (!isEmbedderReady()) {
            console.warn('[Backfill] Embedder not ready, skipping');
            return;
        }
    }

    const modelId = getCurrentModelId();
    const allRecords = await embeddingStorage.getAllWithVersion(campaignId);
    const outdated = allRecords.filter(r => r.version < EMBEDDING_VERSION);

    if (outdated.length === 0) {
        console.log('[Backfill] All embeddings up to date');
        return;
    }

    console.log(`[Backfill] ${outdated.length} outdated embeddings to re-index (version ${EMBEDDING_VERSION})`);

    const sceneRecords: SceneRecord[] = await getList(k(campaignId, 'scenes'));
    const sceneMap = new Map(sceneRecords.map(s => [s.sceneId, s]));

    const YIELD_EVERY = 10;
    let done = 0;

    for (let i = 0; i < outdated.length; i++) {
        const record = outdated[i];
        setBackfillCursor({ campaignId, type: record.type, index: i });

        if (record.type === 'scene') {
            const sceneRec = sceneMap.get(record.id);
            if (sceneRec) {
                const combinedText = `${sceneRec.userContent}\n${sceneRec.assistantContent}`;
                const vector = await embedText(combinedText);
                if (vector) {
                    await embeddingStorage.store(campaignId, record.id, Array.from(vector), 'scene', modelId);
                }
            } else {
                await embeddingStorage.deleteByTypeAndId(campaignId, 'scene', record.id);
            }
        } else if (record.type === 'npc') {
            const npcs: NPCEntry[] = await idbGet(`npcs_${campaignId}`) || [];
            const npc = npcs.find(n => n.id === record.id);
            if (npc) {
                const text = buildNPCEmbeddingText(npc);
                if (text) {
                    const vector = await embedText(text);
                    if (vector) {
                        await embeddingStorage.store(campaignId, record.id, Array.from(vector), 'npc', modelId);
                    }
                }
            } else {
                await embeddingStorage.deleteByTypeAndId(campaignId, 'npc', record.id);
            }
        } else {
            const baseId = record.id.replace(/#w\d+$/, '');
            const loreChunks = await getLoreChunksForBackfill(campaignId);
            const chunk = loreChunks.find(c => c.id === baseId) || loreChunks.find(c => c.id === record.id);
            if (chunk) {
                const vector = await embedText(chunk.content);
                if (vector) {
                    await embeddingStorage.store(campaignId, record.id, Array.from(vector), 'lore', modelId);
                }
            } else {
                await embeddingStorage.deleteByTypeAndId(campaignId, 'lore', record.id);
            }
        }

        done++;
        onProgress?.({ total: outdated.length, done, current: `${record.type}:${record.id}` });

        if (done % YIELD_EVERY === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    const subChunked = allRecords.filter(r =>
        r.version < EMBEDDING_VERSION && r.type === 'lore' && r.id.includes('#w')
    );
    for (const oldSub of subChunked) {
        if (outdated.find(r => r.id === oldSub.id && r.type === oldSub.type)) continue;
    }

    setBackfillCursor(null);
    console.log(`[Backfill] Complete. Re-indexed ${done} embeddings.`);
}

async function getLoreChunksForBackfill(_campaignId: string): Promise<Array<{ id: string; content: string }>> {
    try {
        const { chunkLoreFile } = await import('../lore');
        const { useAppStore } = await import('../../store/useAppStore');
        const state = useAppStore.getState();
        const loreRaw = state.context?.loreRaw;
        if (loreRaw) {
            return chunkLoreFile(loreRaw).map(c => ({ id: c.id, content: c.content }));
        }
    } catch {
        console.warn('[Backfill] Could not access lore chunks from store');
    }
    return [];
}

async function getRuleChunksForReindex(_campaignId: string): Promise<Array<{ id: string; content: string }>> {
    try {
        const { chunkLoreFile } = await import('../lore');
        const { useAppStore } = await import('../../store/useAppStore');
        const state = useAppStore.getState();
        const rulesRaw = state.context?.rulesRaw;
        if (rulesRaw) {
            return chunkLoreFile(rulesRaw, 'rule').map(c => ({ id: c.id, content: c.content }));
        }
    } catch {
        console.warn('[FullReindex] Could not access rule chunks from store');
    }
    return [];
}

export async function backfillScenes(
    campaignId: string,
    sceneIds: string[],
    onProgress?: (progress: BackfillProgress) => void
): Promise<void> {
    if (!isEmbedderReady()) {
        await warmupEmbedder();
        if (!isEmbedderReady()) return;
    }

    const modelId = getCurrentModelId();
    const sceneRecords: SceneRecord[] = await getList(k(campaignId, 'scenes'));
    const sceneMap = new Map(sceneRecords.map(s => [s.sceneId, s]));

    let done = 0;
    for (const sceneId of sceneIds) {
        const sceneRec = sceneMap.get(sceneId);
        if (!sceneRec) continue;

        const combinedText = `${sceneRec.userContent}\n${sceneRec.assistantContent}`;
        const vector = await embedText(combinedText);
        if (vector) {
            await embeddingStorage.store(campaignId, sceneId, Array.from(vector), 'scene', modelId);
        }

        done++;
        onProgress?.({ total: sceneIds.length, done, current: `scene:${sceneId}` });

        if (done % 10 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }
}

export async function backfillNPCs(
    campaignId: string,
    npcLedger: NPCEntry[],
    onProgress?: (progress: BackfillProgress) => void
): Promise<void> {
    if (!isEmbedderReady()) {
        await warmupEmbedder();
        if (!isEmbedderReady()) return;
    }

    const modelId = getCurrentModelId();
    const existingNpcEmbeds = await embeddingStorage.getAll(campaignId, 'npc');
    const embeddedIds = new Set(existingNpcEmbeds.map(e => e.id));

    const toEmbed = npcLedger.filter(npc => !embeddedIds.has(npc.id));

    if (toEmbed.length === 0) {
        console.log('[Backfill] All NPC embeddings up to date');
        return;
    }

    console.log(`[Backfill] ${toEmbed.length} NPCs need embedding`);

    let done = 0;
    for (const npc of toEmbed) {
        const text = buildNPCEmbeddingText(npc);
        if (!text) {
            done++;
            continue;
        }
        const vector = await embedText(text);
        if (vector) {
            await embeddingStorage.store(campaignId, npc.id, Array.from(vector), 'npc', modelId);
        }

        done++;
        onProgress?.({ total: toEmbed.length, done, current: `npc:${npc.name}` });

        if (done % 10 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    console.log(`[Backfill] NPC backfill complete. Embedded ${done} NPCs.`);
}

/**
 * Rebuild ALL embeddings for a campaign from source content (scenes, lore, NPCs, rules).
 * Use this when embeddings are missing/corrupted — does not require existing records.
 * Wipes existing embedding storage for the campaign before re-embedding.
 */
export async function rebuildAllEmbeddings(
    campaignId: string,
    onProgress?: (progress: BackfillProgress) => void
): Promise<{ scenes: number; lore: number; npcs: number; rules: number }> {
    if (!isEmbedderReady()) {
        await warmupEmbedder();
        if (!isEmbedderReady()) {
            throw new Error('Embedder not ready');
        }
    }

    const modelId = getCurrentModelId();

    // Gather all source content
    const scenes: SceneRecord[] = await getList(k(campaignId, 'scenes'));
    const npcs: NPCEntry[] = await idbGet(`npcs_${campaignId}`) || [];
    const loreChunks = await getLoreChunksForBackfill(campaignId);
    const ruleChunks = await getRuleChunksForReindex(campaignId);

    const totalUnits = scenes.length + loreChunks.length + npcs.length + ruleChunks.length;
    if (totalUnits === 0) {
        console.warn('[RebuildAll] No source content found for campaign', campaignId);
        return { scenes: 0, lore: 0, npcs: 0, rules: 0 };
    }

    console.log(`[RebuildAll] Wiping existing embeddings and rebuilding ${totalUnits} units`);

    // Wipe existing embedding storage for this campaign
    await embeddingStorage.deleteAll(campaignId);

    let done = 0;
    const YIELD_EVERY = 5;
    const counts = { scenes: 0, lore: 0, npcs: 0, rules: 0 };

    // Scenes
    for (const scene of scenes) {
        const text = `${scene.userContent}\n${scene.assistantContent}`;
        const vector = await embedText(text);
        if (vector) {
            await embeddingStorage.store(campaignId, scene.sceneId, Array.from(vector), 'scene', modelId);
            counts.scenes++;
        }
        done++;
        onProgress?.({ total: totalUnits, done, current: `scene:${scene.sceneId}` });
        if (done % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
    }

    // Lore
    for (const chunk of loreChunks) {
        const vector = await embedText(chunk.content);
        if (vector) {
            await embeddingStorage.store(campaignId, chunk.id, Array.from(vector), 'lore', modelId);
            counts.lore++;
        }
        done++;
        onProgress?.({ total: totalUnits, done, current: `lore:${chunk.id}` });
        if (done % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
    }

    // NPCs
    for (const npc of npcs) {
        const text = buildNPCEmbeddingText(npc);
        if (!text) { done++; continue; }
        const vector = await embedText(text);
        if (vector) {
            await embeddingStorage.store(campaignId, npc.id, Array.from(vector), 'npc', modelId);
            counts.npcs++;
        }
        done++;
        onProgress?.({ total: totalUnits, done, current: `npc:${npc.name}` });
        if (done % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
    }

    // Rules
    for (const chunk of ruleChunks) {
        const vector = await embedText(chunk.content.slice(0, RULE_EMBED_SLICE));
        if (vector) {
            await embeddingStorage.store(campaignId, chunk.id, Array.from(vector), 'rule', modelId);
            counts.rules++;
        }
        done++;
        onProgress?.({ total: totalUnits, done, current: `rule:${chunk.id}` });
        if (done % YIELD_EVERY === 0) await new Promise(r => setTimeout(r, 0));
    }

    console.log(`[RebuildAll] Complete. scenes=${counts.scenes} lore=${counts.lore} npcs=${counts.npcs} rules=${counts.rules}`);
    return counts;
}

export async function runFullReindex(
    campaignId: string,
    onProgress?: (progress: BackfillProgress) => void
): Promise<void> {
    if (!isEmbedderReady()) {
        await warmupEmbedder();
        if (!isEmbedderReady()) {
            console.warn('[FullReindex] Embedder not ready, skipping');
            return;
        }
    }

    const modelId = getCurrentModelId();
    const allRecords = await embeddingStorage.getAllWithVersion(campaignId);
    const stale = allRecords.filter(r => r.modelId !== modelId);

    if (stale.length === 0) {
        console.log('[FullReindex] No stale vectors found');
        return;
    }

    console.log(`[FullReindex] ${stale.length} vectors need re-indexing (model: ${modelId})`);

    const sceneRecords: SceneRecord[] = await getList(k(campaignId, 'scenes'));
    const sceneMap = new Map(sceneRecords.map(s => [s.sceneId, s]));
    const npcs: NPCEntry[] = await idbGet(`npcs_${campaignId}`) || [];
    const npcMap = new Map(npcs.map(n => [n.id, n]));
    const loreChunks = await getLoreChunksForBackfill(campaignId);
    const ruleChunks = await getRuleChunksForReindex(campaignId);

    const YIELD_EVERY = 5;
    let done = 0;

    for (let i = 0; i < stale.length; i++) {
        const record = stale[i];
        setBackfillCursor({ campaignId, type: record.type, index: i });

        if (record.type === 'scene') {
            const sceneRec = sceneMap.get(record.id);
            if (sceneRec) {
                const combinedText = `${sceneRec.userContent}\n${sceneRec.assistantContent}`;
                const vector = await embedText(combinedText);
                if (vector) {
                    await embeddingStorage.store(campaignId, record.id, Array.from(vector), 'scene', modelId);
                }
            } else {
                await embeddingStorage.deleteByTypeAndId(campaignId, 'scene', record.id);
            }
        } else if (record.type === 'npc') {
            const npc = npcMap.get(record.id);
            if (npc) {
                const text = buildNPCEmbeddingText(npc);
                if (text) {
                    const vector = await embedText(text);
                    if (vector) {
                        await embeddingStorage.store(campaignId, record.id, Array.from(vector), 'npc', modelId);
                    }
                }
            } else {
                await embeddingStorage.deleteByTypeAndId(campaignId, 'npc', record.id);
            }
        } else if (record.type === 'rule') {
            const chunk = ruleChunks.find(c => c.id === record.id);
            if (chunk) {
                const vector = await embedText(chunk.content.slice(0, RULE_EMBED_SLICE));
                if (vector) {
                    await embeddingStorage.store(campaignId, record.id, Array.from(vector), 'rule', modelId);
                }
            } else {
                await embeddingStorage.deleteByTypeAndId(campaignId, 'rule', record.id);
            }
        } else {
            const baseId = record.id.replace(/#w\d+$/, '');
            const chunk = loreChunks.find(c => c.id === baseId) || loreChunks.find(c => c.id === record.id);
            if (chunk) {
                const vector = await embedText(chunk.content);
                if (vector) {
                    await embeddingStorage.store(campaignId, record.id, Array.from(vector), 'lore', modelId);
                }
            } else {
                await embeddingStorage.deleteByTypeAndId(campaignId, 'lore', record.id);
            }
        }

        done++;
        onProgress?.({ total: stale.length, done, current: `${record.type}:${record.id}` });

        if (done % YIELD_EVERY === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    setBackfillCursor(null);
    console.log(`[FullReindex] Complete. Re-indexed ${done} vectors.`);
}