import type { StateCreator } from 'zustand';
import type { NPCPressure } from '../../types';

// ── Debounced pressure save ────────────────────────────────────────────

let pressureTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSavePressure(campaignId: string | null, map: Record<string, NPCPressure>) {
    if (!campaignId) return;
    if (pressureTimer) clearTimeout(pressureTimer);
    pressureTimer = setTimeout(async () => {
        try {
            const { savePressure } = await import('../../store/campaignStore');
            await savePressure(campaignId, map);
        } catch (e) {
            console.error('[PressureSlice] Failed to save pressure map:', e);
        }
    }, 1000);
}

// ── Slice type ─────────────────────────────────────────────────────────

export type PressureSlice = {
    npcPressure: Record<string, NPCPressure>;
    setNpcPressure: (map: Record<string, NPCPressure>) => void;
    applyPressurePatch: (id: string, p: NPCPressure) => void;
    clearNpcPressure: (id: string) => void;
};

type PressureDeps = PressureSlice & {
    activeCampaignId: string | null;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createPressureSlice: StateCreator<PressureDeps, [], [], PressureSlice> = (set, get) => ({
    npcPressure: {},

    setNpcPressure: (map) => set((s) => {
        debouncedSavePressure(s.activeCampaignId, map);
        return { npcPressure: map };
    }),

    applyPressurePatch: (id, p) => set((s) => {
        const newMap = { ...s.npcPressure, [id]: p };
        debouncedSavePressure(s.activeCampaignId, newMap);
        return { npcPressure: newMap };
    }),

    clearNpcPressure: (id) => set((s) => {
        if (!(id in s.npcPressure)) return {};
        const newMap = { ...s.npcPressure };
        delete newMap[id];
        debouncedSavePressure(get().activeCampaignId, newMap);
        return { npcPressure: newMap };
    }),
});
