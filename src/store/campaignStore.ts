import { openDB, type IDBPDatabase } from 'idb';
import type { Campaign, LoreChunk, GameContext, ChatMessage, CondenserState } from '../types';

const DB_NAME = 'gm-cockpit';
const DB_VERSION = 1;

export type CampaignState = {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
};

async function getDb(): Promise<IDBPDatabase> {
    return openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
            if (!db.objectStoreNames.contains('campaigns')) {
                db.createObjectStore('campaigns', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('loreChunks')) {
                db.createObjectStore('loreChunks', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('campaignState')) {
                db.createObjectStore('campaignState', { keyPath: 'campaignId' });
            }
        },
    });
}

// ─── Campaign CRUD ───

export async function listCampaigns(): Promise<Campaign[]> {
    const db = await getDb();
    const all = await db.getAll('campaigns');
    return (all as Campaign[]).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
    const db = await getDb();
    return db.get('campaigns', id) as Promise<Campaign | undefined>;
}

export async function saveCampaign(campaign: Campaign): Promise<void> {
    const db = await getDb();
    await db.put('campaigns', campaign);
}

export async function deleteCampaign(id: string): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(['campaigns', 'loreChunks', 'campaignState'], 'readwrite');
    await tx.objectStore('campaigns').delete(id);
    await tx.objectStore('campaignState').delete(id);

    // Delete lore chunks for this campaign
    const chunkStore = tx.objectStore('loreChunks');
    const allChunks = await chunkStore.getAll();
    for (const chunk of allChunks) {
        if ((chunk as LoreChunk & { campaignId: string }).campaignId === id) {
            await chunkStore.delete(chunk.id);
        }
    }
    await tx.done;
}

// ─── Campaign State ───

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    const db = await getDb();
    await db.put('campaignState', { campaignId, ...state });
}

export async function loadCampaignState(campaignId: string): Promise<CampaignState | null> {
    const db = await getDb();
    const record = await db.get('campaignState', campaignId);
    if (!record) return null;
    const { context, messages, condenser } = record as CampaignState & { campaignId: string };
    return { context, messages, condenser };
}

// ─── Lore Chunks ───

export async function saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void> {
    const db = await getDb();
    const tx = db.transaction('loreChunks', 'readwrite');
    const store = tx.objectStore('loreChunks');

    // Clear existing chunks for this campaign
    const allChunks = await store.getAll();
    for (const chunk of allChunks) {
        if ((chunk as LoreChunk & { campaignId: string }).campaignId === campaignId) {
            await store.delete(chunk.id);
        }
    }

    // Store new chunks with campaignId
    for (const chunk of chunks) {
        await store.put({ ...chunk, campaignId });
    }
    await tx.done;
}

export async function getLoreChunks(campaignId: string): Promise<LoreChunk[]> {
    const db = await getDb();
    const all = await db.getAll('loreChunks');
    return (all as (LoreChunk & { campaignId: string })[])
        .filter((c) => c.campaignId === campaignId)
        .map(({ campaignId: _, ...chunk }) => chunk);
}
