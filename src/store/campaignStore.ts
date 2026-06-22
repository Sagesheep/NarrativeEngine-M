import { get, set, del } from 'idb-keyval';
import type { Campaign, LoreChunk, GameContext, ChatMessage, CondenserState, NPCEntry, ArchiveIndexEntry, ArchiveChapter, SemanticFact, TimelineEvent, EntityEntry, DivergenceRegister, PinnedExcerpt, NPCPressure } from '../types';
import { imageStorage } from '../services/storage/imageStorage';

export type CampaignState = {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    pinnedExcerpts?: PinnedExcerpt[];
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
    await del(`divergence_${id}`);
    await del(`combat_${id}`);
    await del(`items_${id}`);
    await del(`skills_${id}`);
    await imageStorage.deleteAll(id);
}

// ─── Campaign State ───

// Drop the heavy per-message `debugPayload` blobs before they touch IndexedDB.
// They are captured for the inline payload viewer (debug mode) and can be
// hundreds of KB each — with debug mode on, a long campaign accumulates dozens
// of MB of them, which re-serialize on every save and reload straight back into
// the WebView renderer's heap, pushing it toward the OOM ceiling. The live copy
// in the store keeps its payloads, so the viewer still works for the current
// session; only the persisted/reloaded copy is slimmed.
function stripDebugPayloads(state: CampaignState): CampaignState {
    const messages = state.messages;
    if (!Array.isArray(messages) || !messages.some(m => m.debugPayload !== undefined)) {
        return state;
    }
    return {
        ...state,
        messages: messages.map(m => {
            if (m.debugPayload === undefined) return m;
            const { debugPayload: _drop, ...rest } = m;
            return rest;
        }),
    };
}

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    await set(`state_${campaignId}`, stripDebugPayloads(state));
}

const AI_PLAYER_CONTEXT_KEYS = [
    'worldVibe', 'enemyPlayerActive', 'neutralPlayerActive', 'allyPlayerActive',
    'enemyPlayerPrompt', 'neutralPlayerPrompt', 'allyPlayerPrompt',
    'interventionChance', 'enemyCooldown', 'neutralCooldown', 'allyCooldown', 'interventionQueue',
] as const;

export async function loadCampaignState(campaignId: string): Promise<CampaignState | null> {
    const state = await get(`state_${campaignId}`);
    if (!state) return null;
    if (state.context) {
        for (const key of AI_PLAYER_CONTEXT_KEYS) delete (state.context as any)[key];
        // Migrate legacy flat-string characterProfile to structured CharacterProfileState.
        // The old string is preserved verbatim as legacyNotes (storage-only, never
        // injected). activeTraits starts empty and the parser rebuilds it over
        // the next few turns. See AGENTS.md / CharacterProfileState type.
        type MutableContext = Record<string, unknown>;
        const ctx = state.context as MutableContext;
        const cp = ctx.characterProfile;
        if (typeof cp === 'string') {
            ctx.characterProfile = {
                identity: {},
                activeTraits: [],
                legacyNotes: cp || undefined,
            };
        } else if (cp && typeof cp === 'object') {
            // Forward-compatible: ensure required fields exist for older struct saves.
            const cpObj = cp as Record<string, unknown>;
            if (!cpObj.identity) cpObj.identity = {};
            if (!Array.isArray(cpObj.activeTraits)) cpObj.activeTraits = [];
        }
    }
    // Existing campaigns saved with debug mode on still carry fat per-message
    // debugPayloads on disk; strip them on load so they never re-enter the
    // renderer heap. (Fresh saves are already slim via saveCampaignState.)
    return stripDebugPayloads(state);
}

// ─── Lore Chunks ───

export async function saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void> {
    await set(`lore_${campaignId}`, chunks);
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

// ─── NPC Pressure ───

export async function savePressure(campaignId: string, map: Record<string, NPCPressure>): Promise<void> {
    await set(`npc_pressure_${campaignId}`, map);
}

export async function getPressure(campaignId: string): Promise<Record<string, NPCPressure>> {
    return (await get(`npc_pressure_${campaignId}`)) || {};
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

export async function saveDivergenceRegister(campaignId: string, register: DivergenceRegister): Promise<void> {
    await set(`divergence_${campaignId}`, register);
}

export async function loadDivergenceRegister(campaignId: string): Promise<DivergenceRegister | null> {
    const register = await get(`divergence_${campaignId}`);
    if (!register) return null;
    if (!register.version || register.version < 2) {
        const { migrateV1ToV2 } = await import('../services/campaign-state');
        return migrateV1ToV2(register);
    }
    return {
        ...register,
        chapterToggles: register.chapterToggles ?? {},
        categoryToggles: register.categoryToggles ?? {},
    };
}

