/**
 * NPCCapability — state access for NPC ledger + pressure.
 *
 * Services that need to read/write NPCs (image/portrait.ts for
 * updateNPC, pendingCommit for addNPC/setOnStageNpcIds/etc.)
 * used to call useAppStore.getState() directly.
 */

import type { NPCEntry, NPCPressure } from '../types';

/** Suggestion for an NPC name the AI detected but hasn't been confirmed. */
export type NpcSuggestion = { name: string; context?: string; firstSeen: number };

export interface NPCCapability {
    // Commands
    registerNPC(npc: NPCEntry): void;
    registerNPCs(npcs: NPCEntry[]): void;
    updateNPC(id: string, patch: Partial<NPCEntry>): void;
    suggestNPCs(names: string[], context?: string): void;
    dismissSuggestion(name: string): void;
    mergeOrRenameNPC(from: string, to: string, turn: number): 'merged' | 'renamed' | 'none';
    setOnStageNPCs(ids: string[]): void;
    removeNPC(id: string): void;
    applyPressure(npcId: string, pressure: NPCPressure): void;

    // Queries
    getNPCLedger(): readonly NPCEntry[];
    getOnStageNPCIds(): readonly string[];
    getSuggestions(): readonly NpcSuggestion[];
    getPressureMap(): Readonly<Record<string, NPCPressure>>;
}

let _impl: NPCCapability | null = null;

export function registerNPC(impl: NPCCapability): void { _impl = impl; }

function impl(): NPCCapability {
    if (!_impl) throw new Error('NPCCapability not wired. Call registerNPC() from app bootstrap.');
    return _impl;
}

export const npc: NPCCapability = {
    registerNPC:      (n) => impl().registerNPC(n),
    registerNPCs:     (ns) => impl().registerNPCs(ns),
    updateNPC:        (id, p) => impl().updateNPC(id, p),
    suggestNPCs:      (names, ctx) => impl().suggestNPCs(names, ctx),
    dismissSuggestion:(name) => impl().dismissSuggestion(name),
    mergeOrRenameNPC: (from, to, turn) => impl().mergeOrRenameNPC(from, to, turn),
    setOnStageNPCs:   (ids) => impl().setOnStageNPCs(ids),
    removeNPC:        (id) => impl().removeNPC(id),
    applyPressure:    (id, p) => impl().applyPressure(id, p),
    getNPCLedger:     () => impl().getNPCLedger(),
    getOnStageNPCIds: () => impl().getOnStageNPCIds(),
    getSuggestions:   () => impl().getSuggestions(),
    getPressureMap:   () => impl().getPressureMap(),
};
