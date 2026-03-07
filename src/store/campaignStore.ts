import { Preferences } from '@capacitor/preferences';
import type { Campaign, LoreChunk, GameContext, ChatMessage, CondenserState, NPCEntry } from '../types';

export type CampaignState = {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
};

// ─── Helpers ───

async function getKeysByPrefix(prefix: string): Promise<string[]> {
    const { keys } = await Preferences.keys();
    return keys.filter(k => k.startsWith(prefix));
}

// ─── Campaign CRUD ───

export async function listCampaigns(): Promise<Campaign[]> {
    const keys = await getKeysByPrefix('campaign_meta_');
    const campaigns: Campaign[] = [];
    for (const key of keys) {
        const { value } = await Preferences.get({ key });
        if (value) campaigns.push(JSON.parse(value));
    }
    // Sort by last played
    return campaigns.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
    const { value } = await Preferences.get({ key: `campaign_meta_${id}` });
    return value ? JSON.parse(value) : undefined;
}

export async function saveCampaign(campaign: Campaign): Promise<void> {
    await Preferences.set({
        key: `campaign_meta_${campaign.id}`,
        value: JSON.stringify(campaign)
    });
}

export async function deleteCampaign(id: string): Promise<void> {
    await Preferences.remove({ key: `campaign_meta_${id}` });
    await Preferences.remove({ key: `campaign_state_${id}` });
    await Preferences.remove({ key: `campaign_lore_${id}` });
    await Preferences.remove({ key: `campaign_npcs_${id}` });
}

// ─── Campaign State ───

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    await Preferences.set({
        key: `campaign_state_${campaignId}`,
        value: JSON.stringify(state)
    });
}

export async function loadCampaignState(campaignId: string): Promise<CampaignState | null> {
    const { value } = await Preferences.get({ key: `campaign_state_${campaignId}` });
    if (!value) return null;
    const record = JSON.parse(value);
    const { context, messages, condenser } = record;
    return { context, messages, condenser };
}

// ─── Lore Chunks ───

export async function saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void> {
    await Preferences.set({
        key: `campaign_lore_${campaignId}`,
        value: JSON.stringify(chunks)
    });
}

export async function getLoreChunks(campaignId: string): Promise<LoreChunk[]> {
    const { value } = await Preferences.get({ key: `campaign_lore_${campaignId}` });
    return value ? JSON.parse(value) : [];
}

// ─── NPC Ledger ───

export async function saveNPCLedger(campaignId: string, npcs: NPCEntry[]): Promise<void> {
    await Preferences.set({
        key: `campaign_npcs_${campaignId}`,
        value: JSON.stringify(npcs)
    });
}

export async function getNPCLedger(campaignId: string): Promise<NPCEntry[]> {
    const { value } = await Preferences.get({ key: `campaign_npcs_${campaignId}` });
    return value ? JSON.parse(value) : [];
}

