import { get, set, del } from 'idb-keyval';
import type { Campaign, LoreChunk, GameContext, ChatMessage, CondenserState, NPCEntry, ArchiveIndexEntry, ArchiveChapter, SemanticFact, TimelineEvent, EntityEntry, DivergenceRegister, PinnedExcerpt, NPCPressure, RuleChunkMeta } from '../types';
import { imageStorage } from '../services/storage/imageStorage';
import { upgradeVectorOnlyDefault } from '../services/lore/loreIndexer';
import { affinityToPcRelation } from '../services/npc/agencyBands';

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
//
// Also strips Smart Retry v1 ephemeral fields (`retryable`, `precontext`):
// `retryable` is a transient UI state that must NOT survive reload (a crashed
// mid-retry turn just doesn't have a Retry button anymore — user resends, per
// the "crash = gone" rule). `precontext.capturedPayloadRef` is a string key
// into the in-memory `pendingSnapshot` singleton; on reload it's a dangling
// key with no resolution, so there's no value in persisting it either. Both
// are stripped here on save AND load — the load-side strip gives free cleanup
// of any pre-fix saves that slipped to disk. `swipeSet`/`pendingCommit` are
// deliberately NOT stripped — they are crash-safety markers that must persist.
function stripEphemeralFields(state: CampaignState): CampaignState {
    const messages = state.messages;
    if (!Array.isArray(messages)) return state;
    const needsDebugStrip = messages.some(m => m.debugPayload !== undefined);
    const needsRetryStrip = messages.some(m => m.retryable !== undefined || m.precontext !== undefined);
    if (!needsDebugStrip && !needsRetryStrip) return state;
    return {
        ...state,
        messages: messages.map(m => {
            const { debugPayload: _drop, retryable: _r, precontext: _pc, ...rest } = m;
            return rest as ChatMessage;
        }),
    };
}

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    // pinnedExcerpts is optional on CampaignState, but this is a full-record
    // overwrite — a caller that *omits* the field would silently wipe the user's
    // pinned memories (Header.handleExit / CampaignHub edits did exactly this).
    // Guard: when the field is undefined (omitted, not an explicit `[]` clear),
    // preserve whatever is already persisted. The hot turn path always passes
    // pinnedExcerpts explicitly, so this extra read never fires there.
    let toSave = state;
    if (state.pinnedExcerpts === undefined) {
        const prev = await get(`state_${campaignId}`).catch(() => null);
        if (prev?.pinnedExcerpts) {
            toSave = { ...state, pinnedExcerpts: prev.pinnedExcerpts };
        }
    }
    await set(`state_${campaignId}`, stripEphemeralFields(toSave));

    // B5 — bump the campaign meta's lastPlayedAt on every turn-commit. Previously
    // lastPlayedAt was only written when a campaign was opened/edited in CampaignHub,
    // so the stamp read "last opened" instead of "last played" and the recency sort
    // (listCampaigns) was wrong after ~10h of play. One small extra write per turn,
    // not per keystroke. Only the meta record is touched — no re-trigger of state save.
    try {
        const campaigns: Campaign[] = await get('campaigns') || [];
        const idx = campaigns.findIndex(c => c.id === campaignId);
        if (idx >= 0) {
            campaigns[idx] = { ...campaigns[idx], lastPlayedAt: Date.now() };
            await set('campaigns', campaigns);
        }
    } catch (e) {
        // Non-fatal — the state save above already succeeded; don't let a meta-write
        // failure break the turn.
        console.warn('[saveCampaignState] failed to bump lastPlayedAt:', e);
    }
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

        // Forward-compat: older saves predate characterProfileUserDisabled.
        // Default to false so legacy campaigns keep the existing auto-enable behavior
        // (the user never explicitly disabled it). See autoEnableCharacterProfile.
        if ((ctx as Record<string, unknown>).characterProfileUserDisabled === undefined) {
            (ctx as Record<string, unknown>).characterProfileUserDisabled = false;
        }

        // Migrate legacy vector-only rule meta to vector+keyword (matches the lore
        // chunk migration in getLoreChunks). Explicit `<!-- rag: vector -->` rules
        // re-assert vector-only on the next RulesManager parse via deriveDefaultMeta.
        const rulesMeta = (ctx.rulesChunkMeta ?? null) as Record<string, RuleChunkMeta> | null;
        if (rulesMeta) {
            for (const id of Object.keys(rulesMeta)) {
                const m = rulesMeta[id];
                const upgraded = upgradeVectorOnlyDefault(m?.activationModes);
                if (m && upgraded !== m.activationModes) m.activationModes = upgraded!;
            }
        }
    }
    // Existing campaigns saved with debug mode on still carry fat per-message
    // debugPayloads on disk; strip them on load so they never re-enter the
    // renderer heap. (Fresh saves are already slim via saveCampaignState.)
    return stripEphemeralFields(state);
}

// ─── Lore Chunks ───

export async function saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void> {
    await set(`lore_${campaignId}`, chunks);
}

export async function getLoreChunks(campaignId: string): Promise<LoreChunk[]> {
    const chunks: LoreChunk[] | undefined = await get(`lore_${campaignId}`);
    if (!chunks || chunks.length === 0) return chunks || [];

    // Migrate legacy unhinted vector-only chunks (the old chunker default) to
    // vector+keyword, so existing campaigns get keyword matching without a
    // manual per-chunk toggle. Leave user-edited modes and explicit
    // `<!-- rag: vector -->` hints (ragMode === 'vector') untouched.
    let mutated = false;
    for (const chunk of chunks) {
        if (chunk.modesUserEdited || chunk.ragMode === 'vector') continue;
        const upgraded = upgradeVectorOnlyDefault(chunk.activationModes);
        if (upgraded !== chunk.activationModes) {
            chunk.activationModes = upgraded;
            mutated = true;
        }
    }
    if (mutated) await set(`lore_${campaignId}`, chunks);

    return chunks;
}

// ─── NPC Ledger ───

export async function saveNPCLedger(campaignId: string, npcs: NPCEntry[]): Promise<void> {
    await set(`npcs_${campaignId}`, npcs);
}

export async function getNPCLedger(campaignId: string): Promise<NPCEntry[]> {
    const npcs = await get(`npcs_${campaignId}`);
    if (!npcs || npcs.length === 0) return npcs || [];

    // B2 — lazy migration for existing saves: home pcRelation for any NPC where it's still
    // undefined. populateAgencyFields only runs on UN-populated NPCs, and generated NPCs were
    // born populated:true with pcRelation unset, so legacy NPCs read "[Aff: Neutral]" forever
    // and Phase 2's reaction-menu relationship scoring never saw real drift. Home them here on
    // load regardless of `populated`, mirroring the birth-block fix. Skip PCs (matches
    // populateAgencyFields' !n.isPC filter). Never clobber an explicit value, never touch affinity.
    let mutated = false;
    for (const n of npcs) {
        if (!n.isPC && n.pcRelation === undefined) {
            n.pcRelation = affinityToPcRelation(n.affinity ?? 50);
            mutated = true;
        }
    }
    if (mutated) await set(`npcs_${campaignId}`, npcs);

    return npcs;
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

