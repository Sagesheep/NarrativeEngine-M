import type { StateCreator } from 'zustand';
import type { NPCEntry } from '../../types';
import { toast } from '../../components/Toast';
import { embedText, getCurrentModelId } from '../../services/embedding';
import { embeddingStorage } from '../../services/storage/embeddingStorage';
import { imageStorage } from '../../services/storage/imageStorage';
import { buildNPCEmbeddingText } from '../../services/npc';

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
            toast.error('Failed to save NPC ledger');
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
    archiveNPC: (id: string, turn: number, reason: string) => void;
    restoreNPC: (id: string) => void;

    // On-stage NPC tracking (perception bounding)
    onStageNpcIds: string[];
    setOnStageNpcIds: (ids: string[]) => void;
};

// ── Cross-slice deps (reads activeCampaignId for persistence + embedding) ──

type NPCDeps = NPCSlice & {
    activeCampaignId: string | null;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createNPCSlice: StateCreator<NPCDeps, [], [], NPCSlice> = (set) => ({
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
        return { npcLedger: newLedger };
    }),
    archiveNPC: (id, turn, reason) => set((s) => {
        const newLedger = s.npcLedger.map(n =>
            n.id === id ? { ...n, archived: true, archivedAtTurn: turn, archivedReason: reason } : n
        );
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    restoreNPC: (id) => set((s) => {
        const newLedger = s.npcLedger.map(n =>
            n.id === id ? { ...n, archived: false, archivedAtTurn: undefined, archivedReason: undefined } : n
        );
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),

    onStageNpcIds: [],
    setOnStageNpcIds: (ids) => set({ onStageNpcIds: ids }),
});
