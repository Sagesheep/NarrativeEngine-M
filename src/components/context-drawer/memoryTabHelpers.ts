/**
 * MemoryTab helpers — extracted from MemoryTab.tsx (W11).
 * Pure utility functions for divergence display.
 */

import type { DivergenceCategory, NPCEntry } from '../../types';
import { parseKnownByToken } from '../../services/campaign-state';

export const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
    locations: 'text-blue-400', npc_events: 'text-terminal', promises_debts: 'text-amber-400',
    world_state: 'text-ice', party_facts: 'text-emerald-400', rules_lore: 'text-purple-400', misc: 'text-text-muted',
};

export const CATEGORY_DOTS: Record<DivergenceCategory, string> = {
    locations: 'bg-blue-400', npc_events: 'bg-green-400', promises_debts: 'bg-amber-400',
    world_state: 'bg-cyan-400', party_facts: 'bg-emerald-400', rules_lore: 'bg-purple-400', misc: 'bg-gray-400',
};

export function knownByTokenLabel(tok: string, npcLedger: NPCEntry[]): string {
    const parsed = parseKnownByToken(tok);
    if (!parsed) { const npc = npcLedger.find(n => n.id === tok.trim()); return npc ? npc.name : 'unknown'; }
    if (parsed.kind === 'player') return 'the player';
    if (parsed.kind === 'faction') return `${parsed.name} members`;
    const npc = npcLedger.find(n => n.id === parsed.id);
    return npc ? npc.name : 'someone (removed)';
}

export function knownBySummary(knownBy: string[] | undefined, npcLedger: NPCEntry[]): string {
    if (knownBy === undefined) return 'public';
    if (knownBy.length === 0) return 'secret (player only)';
    return knownBy.map(t => knownByTokenLabel(t, npcLedger)).join(', ');
}

export function knownByChipClass(knownBy: string[] | undefined): string {
    if (knownBy === undefined) return 'text-emerald-400';
    if (knownBy.length === 0) return 'text-red-400';
    return 'text-amber-400';
}

export function subjectLabel(token: string): string {
    const parts = token.split(/[._]/).filter(Boolean);
    if (parts.length === 0) return token;
    const pretty = parts.map(p => p.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    if (pretty.length >= 2) { const attr = pretty.pop(); return `${pretty.join(' ')} · ${attr}`; }
    return pretty.join(' ');
}
