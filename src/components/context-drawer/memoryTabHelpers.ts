/**
 * MemoryTab helpers — extracted from MemoryTab.tsx (W11).
 * Pure utility functions for divergence display.
 */

import type { DivergenceCategory, DivergenceEntry, NPCEntry } from '../../types';
import { parseKnownByToken, isFactActive, isAlwaysOn } from '../../services/campaign-state';

export const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
    locations: 'text-blue-400', npc_events: 'text-terminal', promises_debts: 'text-amber-400',
    world_state: 'text-ice', party_facts: 'text-emerald-400', rules_lore: 'text-purple-400', misc: 'text-text-muted',
};

export const CATEGORY_DOTS: Record<DivergenceCategory, string> = {
    locations: 'bg-blue-400', npc_events: 'bg-green-400', promises_debts: 'bg-amber-400',
    world_state: 'bg-cyan-400', party_facts: 'bg-emerald-400', rules_lore: 'bg-purple-400', misc: 'bg-gray-400',
};

/** NPC id → name, built once per ledger so per-row labels don't scan the ledger. */
export type NpcNameMap = ReadonlyMap<string, string>;

export function buildNpcNameMap(npcLedger: NPCEntry[]): NpcNameMap {
    return new Map(npcLedger.map(n => [n.id, n.name]));
}

export function knownByTokenLabel(tok: string, npcNames: NpcNameMap): string {
    const parsed = parseKnownByToken(tok);
    if (!parsed) return npcNames.get(tok.trim()) ?? 'unknown';
    if (parsed.kind === 'player') return 'the player';
    if (parsed.kind === 'faction') return `${parsed.name} members`;
    return npcNames.get(parsed.id) ?? 'someone (removed)';
}

export function knownBySummary(knownBy: string[] | undefined, npcNames: NpcNameMap): string {
    if (knownBy === undefined) return 'public';
    if (knownBy.length === 0) return 'secret (player only)';
    return knownBy.map(t => knownByTokenLabel(t, npcNames)).join(', ');
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

export type FactFilter = 'all' | 'state' | 'enabled' | 'disabled' | 'replaced' | 'closed' | 'history' | 'secret';

export const FACT_FILTERS: readonly { id: FactFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'state', label: 'State' },
    { id: 'enabled', label: 'On' },
    { id: 'disabled', label: 'Off' },
    { id: 'replaced', label: 'Replaced' },
    { id: 'closed', label: 'Closed' },
    { id: 'history', label: 'History' },
    { id: 'secret', label: 'Scoped' },
];

/** Status filter + case-insensitive search over text, subject, scene ref and knower names. */
export function matchesFactFilter(
    e: DivergenceEntry,
    filter: FactFilter,
    query: string,
    npcNames: NpcNameMap,
    /** Start of the always-on window (recentWindowStart); 'history' = active but outside it. */
    windowStart?: string,
): boolean {
    if (filter === 'state' && (!e.stateKey || !isFactActive(e))) return false;
    if (filter === 'enabled' && e.enabled === false) return false;
    if (filter === 'disabled' && e.enabled !== false) return false;
    if (filter === 'replaced' && e.status !== 'superseded') return false;
    if (filter === 'closed' && e.status !== 'resolved') return false;
    if (filter === 'history' && (!isFactActive(e) || isAlwaysOn(e, windowStart))) return false;
    if (filter === 'secret' && e.knownBy === undefined) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return e.text.toLowerCase().includes(q)
        || (e.subjectToken?.toLowerCase().includes(q) ?? false)
        || (e.stateKey?.includes(q) ?? false)
        || e.sceneRef.toLowerCase().includes(q)
        || knownBySummary(e.knownBy, npcNames).toLowerCase().includes(q);
}
