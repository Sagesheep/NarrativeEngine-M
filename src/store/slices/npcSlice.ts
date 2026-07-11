import type { StateCreator } from 'zustand';
import type { NPCEntry } from '../../types';
import { notify } from '../../services/ports/notify';
import { embedText, getCurrentModelId } from '../../services/embedding';
import { embeddingStorage } from '../../services/storage/embeddingStorage';
import { imageStorage } from '../../services/storage/imageStorage';
import { buildNPCEmbeddingText, findLedgerMatches } from '../../services/npc';

/** A name the auto-detector noticed but did NOT add — the player decides. */
export type NpcSuggestion = { name: string; context?: string; firstSeen: number };

const NPC_EMBED_FIELDS: (keyof NPCEntry)[] = ['name', 'aliases', 'faction', 'tier', 'appearance', 'personality', 'voice', 'goals', 'storyRelevance'];

// ── Debounced NPC ledger save ──────────────────────────────────────────

let npcTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveNPCLedger(campaignId: string | null, npcs: NPCEntry[]) {
    if (!campaignId) return;
    if (npcTimer) clearTimeout(npcTimer);
    npcTimer = setTimeout(async () => {
        try {
            const { saveNPCLedger } = await import('../../store/campaignStore');
            await saveNPCLedger(campaignId, npcs);
        } catch (e) {
            console.error(e);
            notify.error('Failed to save NPC ledger');
        }
    }, 1000);
}

/**
 * Deduplicates the NPC ledger by name comparison:
 *   Rule 1: Exact full-name match -> keep the newer (later in array) entry
 *   Rule 2: First-name-only entry matches a full-name entry -> keep the fuller/newer entry
 *   Rule 3: Same first name but different last names -> do NOT touch
 */
export function dedupeNPCLedger(ledger: NPCEntry[]): NPCEntry[] {
    const removeIndices = new Set<number>();

    for (let i = 0; i < ledger.length; i++) {
        if (removeIndices.has(i)) continue;

        const nameI = ledger[i].name.trim().toLowerCase();
        const partsI = nameI.split(/\s+/);
        const firstI = partsI[0];
        const hasLastI = partsI.length > 1;

        for (let j = i + 1; j < ledger.length; j++) {
            if (removeIndices.has(j)) continue;

            const nameJ = ledger[j].name.trim().toLowerCase();
            const partsJ = nameJ.split(/\s+/);
            const firstJ = partsJ[0];
            const hasLastJ = partsJ.length > 1;

            // Rule 1: Exact full name match -> remove the older (i)
            if (nameI === nameJ) {
                console.log(`[NPC Dedup] Exact match: "${ledger[i].name}" == "${ledger[j].name}" → removing older entry`);
                removeIndices.add(i);
                break;
            }

            // Rule 2: First-name-only entry matches a first+last entry
            if (!hasLastI && hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[i].name}" ⊂ "${ledger[j].name}" → removing shorter entry`);
                removeIndices.add(i);
                break;
            }
            if (hasLastI && !hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[j].name}" ⊂ "${ledger[i].name}" → removing shorter entry`);
                removeIndices.add(j);
                continue;
            }

            // Rule 3: Same first name, different last names -> do NOT touch
        }
    }

    if (removeIndices.size > 0) {
        console.log(`[NPC Dedup] Removed ${removeIndices.size} duplicate(s) from ledger`);
    }

    return ledger.filter((_, idx) => !removeIndices.has(idx));
}

// ── Slice type ─────────────────────────────────────────────────────────

export type NPCSlice = {
    npcLedger: NPCEntry[];
    setNPCLedger: (npcs: NPCEntry[]) => void;
    addNPC: (npc: NPCEntry) => void;
    addNPCs: (newNpcs: NPCEntry[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    removeNPC: (id: string) => void;
    mergeOrRenameNpc: (from: string, to: string, turn: number) => 'merged' | 'renamed' | 'none';

    // On-stage NPC tracking (perception bounding)
    onStageNpcIds: string[];
    setOnStageNpcIds: (ids: string[]) => void;

    // NPC suggestions — auto-detected names awaiting player promotion
    npcSuggestions: NpcSuggestion[];
    addNpcSuggestions: (names: string[], context?: string) => void;
    dismissNpcSuggestion: (name: string) => void;
    clearNpcSuggestions: () => void;
};

// ── Cross-slice deps (reads activeCampaignId for persistence + embedding) ──

type NPCDeps = NPCSlice & {
    activeCampaignId: string | null;
    clearNpcPressure: (id: string) => void;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createNPCSlice: StateCreator<NPCDeps, [], [], NPCSlice> = (set, get) => ({
    npcLedger: [],
    setNPCLedger: (npcs) => set((s) => {
        debouncedSaveNPCLedger(s.activeCampaignId, npcs);
        return { npcLedger: npcs };
    }),
    addNPC: (npc) => set((s) => {
        const withNew = [...s.npcLedger, npc];
        const deduped = dedupeNPCLedger(withNew);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    addNPCs: (newNpcs) => set((s) => {
        const withNew = [...s.npcLedger, ...newNpcs];
        const deduped = dedupeNPCLedger(withNew);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    updateNPC: (id, patch) => set((s) => {
        const oldNpc = s.npcLedger.find(n => n.id === id);
        const newLedger = s.npcLedger.map(n => n.id === id ? { ...n, ...patch } : n);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        if (oldNpc && s.activeCampaignId && NPC_EMBED_FIELDS.some(f => f in patch)) {
            const updatedNpc = { ...oldNpc, ...patch };
            const cId = s.activeCampaignId;
            embedText(buildNPCEmbeddingText(updatedNpc))
                .then(vec => vec && embeddingStorage.store(cId, id, Array.from(vec), 'npc', getCurrentModelId()))
                .catch(e => console.warn(`[NPC] Re-embed failed for ${updatedNpc.name}:`, e));
        }
        return { npcLedger: newLedger };
    }),
    removeNPC: (id) => set((s) => {
        const newLedger = s.npcLedger.filter(n => n.id !== id);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        if (s.activeCampaignId) {
            embeddingStorage.deleteByTypeAndId(s.activeCampaignId, 'npc', id)
                .catch(e => console.warn('[NPC] Vector delete failed:', e));
            imageStorage.deletePortrait(s.activeCampaignId, id)
                .catch(e => console.warn('[NPC] Portrait delete failed:', e));
        }
        get().clearNpcPressure(id);
        return { npcLedger: newLedger };
    }),
    // Manual rename/merge backstop for the user-driven highlight→rename tool.
    // Find the ledger entry that owns `from`. If `to` is already owned by a
    // DIFFERENT entry, this was a duplicate/phantom → delete the `from` entry
    // (merge into the real one). Otherwise rename the `from` entry to `to`.
    // Renaming via updateNPC re-embeds with the correct model id (invariant).
    mergeOrRenameNpc: (from, to, _turn) => {
        const fromKey = from.trim().toLowerCase();
        const toKey = to.trim().toLowerCase();
        if (!fromKey || !toKey || fromKey === toKey) return 'none';
        const s = get();
        const matches = (n: NPCEntry, key: string) => {
            const names = [n.name, ...(n.aliases || '').split(',')].map(x => x.trim().toLowerCase());
            return names.includes(key);
        };
        const fromNpc = s.npcLedger.find(n => matches(n, fromKey));
        if (!fromNpc) return 'none';
        const toNpc = s.npcLedger.find(n => n.id !== fromNpc.id && matches(n, toKey));
        if (toNpc) {
            get().removeNPC(fromNpc.id);
            return 'merged';
        }
        get().updateNPC(fromNpc.id, { name: to.trim() });
        return 'renamed';
    },

    onStageNpcIds: [],
    setOnStageNpcIds: (ids) => set({ onStageNpcIds: ids }),

    npcSuggestions: [],
    addNpcSuggestions: (names, context) => set((s) => {
        const existing = new Set(s.npcSuggestions.map(x => x.name.toLowerCase()));
        const now = Date.now();
        const fresh: NpcSuggestion[] = [];
        for (const raw of names) {
            const name = raw.trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (existing.has(key)) continue;
            // Skip anything already tracked in the ledger (or a name variant of it)
            if (findLedgerMatches(name, s.npcLedger).length > 0) continue;
            existing.add(key);
            fresh.push({ name, context, firstSeen: now });
        }
        if (fresh.length === 0) return {};
        return { npcSuggestions: [...s.npcSuggestions, ...fresh] };
    }),
    dismissNpcSuggestion: (name) => set((s) => ({
        npcSuggestions: s.npcSuggestions.filter(x => x.name.toLowerCase() !== name.toLowerCase()),
    })),
    clearNpcSuggestions: () => set({ npcSuggestions: [] }),
});
