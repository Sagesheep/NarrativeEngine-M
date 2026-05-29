import type { StateCreator } from 'zustand';
import type { LoreChunk } from '../../types';

// ── Slice type ─────────────────────────────────────────────────────────

export type LoreSlice = {
    loreChunks: LoreChunk[];
    setLoreChunks: (chunks: LoreChunk[]) => void;
    updateLoreChunk: (id: string, patch: Partial<LoreChunk>) => void;
};

// ── Cross-slice deps (reads activeCampaignId for inline persistence) ────

type LoreDeps = LoreSlice & {
    activeCampaignId: string | null;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createLoreSlice: StateCreator<LoreDeps, [], [], LoreSlice> = (set) => ({
    loreChunks: [],
    setLoreChunks: (chunks) => set({ loreChunks: chunks }),
    updateLoreChunk: (id, patch) => set((s) => {
        const newChunks = s.loreChunks.map(c => c.id === id ? { ...c, ...patch } : c);
        if (s.activeCampaignId) {
            import('../../store/campaignStore').then(mod => mod.saveLoreChunks(s.activeCampaignId!, newChunks));
        }
        return { loreChunks: newChunks };
    }),
});
