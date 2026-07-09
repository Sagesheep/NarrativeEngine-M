import { useAppStore } from '../store/useAppStore';
import { registerNPC, type NPCCapability } from '../ports/npc';

export const npcAdapter: NPCCapability = {
    registerNPC:      (n) => useAppStore.getState().addNPC(n),
    registerNPCs:     (ns) => useAppStore.getState().addNPCs(ns),
    updateNPC:        (id, p) => useAppStore.getState().updateNPC(id, p),
    suggestNPCs:      (names, ctx) => useAppStore.getState().addNpcSuggestions(names, ctx),
    dismissSuggestion:(name) => useAppStore.getState().dismissNpcSuggestion(name),
    mergeOrRenameNPC: (from, to, turn) => useAppStore.getState().mergeOrRenameNpc(from, to, turn),
    setOnStageNPCs:   (ids) => useAppStore.getState().setOnStageNpcIds(ids),
    removeNPC:        (id) => useAppStore.getState().removeNPC(id),
    applyPressure:    (id, p) => useAppStore.getState().applyPressurePatch(id, p),
    getNPCLedger:     () => useAppStore.getState().npcLedger,
    getOnStageNPCIds: () => useAppStore.getState().onStageNpcIds,
    getSuggestions:   () => useAppStore.getState().npcSuggestions,
    getPressureMap:   () => useAppStore.getState().npcPressure,
};

export function wireNPC(): void { registerNPC(npcAdapter); }
