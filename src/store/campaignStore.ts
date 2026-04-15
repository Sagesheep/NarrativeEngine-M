import { get, set, del } from 'idb-keyval';
import type { Campaign, LoreChunk, GameContext, ChatMessage, CondenserState, NPCEntry, ArchiveIndexEntry, ArchiveChapter, SemanticFact, TimelineEvent, EntityEntry } from '../types';

export type CampaignState = {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
};

// ─── Campaign CRUD ───

export async function listCampaigns(): Promise<Campaign[]> {
    const campaigns: Campaign[] = await get('campaigns') || [];
    return campaigns.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
    const campaigns: Campaign[] = await get('campaigns') || [];
    return campaigns.find(c => c.id === id);
}

export async function saveCampaign(campaign: Campaign): Promise<void> {
    const campaigns: Campaign[] = await get('campaigns') || [];
    const idx = campaigns.findIndex(c => c.id === campaign.id);
    if (idx >= 0) {
        campaigns[idx] = campaign;
    } else {
        campaigns.push(campaign);
    }
    await set('campaigns', campaigns);
}

export async function deleteCampaign(id: string): Promise<void> {
    const campaigns: Campaign[] = await get('campaigns') || [];
    await set('campaigns', campaigns.filter(c => c.id !== id));
    await del(`state_${id}`);
    await del(`lore_${id}`);
    await del(`npcs_${id}`);
    await del(`archive_index_${id}`);
}

// ─── Campaign State ───

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    await set(`state_${campaignId}`, state);
}

export async function loadCampaignState(campaignId: string): Promise<CampaignState | null> {
    const state = await get(`state_${campaignId}`);
    return state || null;
}

// ─── Lore Chunks ───

export async function saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void> {
    await set(`lore_${campaignId}`, chunks);

    import('../services/embedder').then(({ embedText }) => {
        import('../services/offlineStorage').then(({ offlineStorage }) => {
            for (const chunk of chunks) {
                embedText(chunk.content.slice(0, 500)).then(vec => {
                    if (vec) offlineStorage.embeddings.store(campaignId, chunk.id, Array.from(vec), 'lore');
                }).catch(() => {});
            }
        });
    }).catch(() => {});
}

export async function getLoreChunks(campaignId: string): Promise<LoreChunk[]> {
    const chunks = await get(`lore_${campaignId}`);
    return chunks || [];
}

// ─── NPC Ledger ───

export async function saveNPCLedger(campaignId: string, npcs: NPCEntry[]): Promise<void> {
    await set(`npcs_${campaignId}`, npcs);
}

export async function getNPCLedger(campaignId: string): Promise<NPCEntry[]> {
    const npcs = await get(`npcs_${campaignId}`);
    return npcs || [];
}

// ─── Archive Index (Tier 4) ───

export async function loadArchiveIndex(campaignId: string): Promise<ArchiveIndexEntry[]> {
    const archive = await get(`archive_index_${campaignId}`);
    return archive || [];
}

// ─── Semantic Facts ───

export async function loadSemanticFacts(campaignId: string): Promise<SemanticFact[]> {
    const { api } = await import('../services/apiClient');
    return api.facts.get(campaignId);
}

// ─── Chapters ───

export async function loadChapters(campaignId: string): Promise<ArchiveChapter[]> {
    const { api } = await import('../services/apiClient');
    return api.chapters.list(campaignId);
}

export async function loadTimeline(campaignId: string): Promise<TimelineEvent[]> {
    const { api } = await import('../services/apiClient');
    return api.timeline.get(campaignId);
}

export async function loadEntities(campaignId: string): Promise<EntityEntry[]> {
    const { api } = await import('../services/apiClient');
    return api.entities.get(campaignId);
}
