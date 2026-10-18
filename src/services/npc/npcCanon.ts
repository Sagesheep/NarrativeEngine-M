/**
 * Canon NPCs — characters from the setting's source material (the world lore file's
 * CHARACTERS section, or ones the generator recognised as a known figure).
 *
 * Canon protects WHO the character is, not WHAT happens to them:
 *   - Locked against the LLM updater: personality, voice, disposition, example output,
 *     traits, hard boundaries, primary social group.
 *   - Personality hex anchored: every axis stays within ±CANON_HEX_SLACK of `canonHex`.
 *   - Free to evolve: relation to the PC, wants/goals, region, status, faction, kit,
 *     soft boundaries, trajectory group, appearance.
 *
 * `canon === false` is the player's explicit opt-out; nothing here ever flips it back.
 */

import type { NPCEntry, PersonalityHex, HexAxis } from '../../types';

export const CANON_HEX_SLACK = 1;

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

/** Identity fields the LLM updater may never rewrite on a canon NPC. */
export const CANON_LOCKED_FIELDS = [
    'personality', 'voice', 'disposition', 'exampleOutput', 'traits', 'hardBoundaries', 'primaryGroup',
] as const satisfies readonly (keyof NPCEntry)[];

/**
 * Identity fields a lore re-import refreshes on an existing canon entry (when the lore
 * value is non-empty). Everything else — relation, meter, wants, goals, rung, region,
 * status, faction, kit, id — is play state and survives the re-import.
 */
const LORE_REFRESH_FIELDS = [
    ...CANON_LOCKED_FIELDS, 'aliases', 'appearance', 'storyRelevance', 'personalityHex',
    'softBoundaries', 'behavioralTriggers',
] as const satisfies readonly (keyof NPCEntry)[];

export function isCanon(npc: Pick<NPCEntry, 'canon'>): boolean {
    return npc.canon === true;
}

/** Clamp a hex so no axis strays more than CANON_HEX_SLACK from the NPC's canon baseline.
 *  Non-canon NPCs, or canon NPCs without a baseline yet, pass through unchanged. */
export function anchorCanonHex(npc: Pick<NPCEntry, 'canon' | 'canonHex'>, hex: PersonalityHex): PersonalityHex {
    const base = npc.canonHex;
    if (!isCanon(npc) || !base) return hex;
    const out = { ...hex };
    for (const axis of HEX_AXES) {
        const b = base[axis] ?? 0;
        out[axis] = Math.max(b - CANON_HEX_SLACK, Math.min(b + CANON_HEX_SLACK, out[axis]));
    }
    return out;
}

/** Removes the locked identity fields from an LLM-proposed change set for a canon NPC. */
export function stripCanonLockedFields(npc: Pick<NPCEntry, 'canon'>, changes: Partial<NPCEntry>): Partial<NPCEntry> {
    if (!isCanon(npc)) return changes;
    const out = { ...changes };
    for (const f of CANON_LOCKED_FIELDS) delete out[f];
    return out;
}

function nameKeys(npc: Pick<NPCEntry, 'name' | 'aliases'>): string[] {
    const aliases = (npc.aliases || '').split(',');
    return [npc.name, ...aliases].map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** The lore NPC whose name or aliases match this entry's name or aliases, if any. */
export function findLoreMatch<T extends Pick<NPCEntry, 'name' | 'aliases'>>(npc: Pick<NPCEntry, 'name' | 'aliases'>, loreNpcs: T[]): T | undefined {
    const keys = new Set(nameKeys(npc));
    if (keys.size === 0) return undefined;
    return loreNpcs.find(l => nameKeys(l).some(k => keys.has(k)));
}

/**
 * Save migration: tag ledger entries that match a lore character as canon and backfill
 * their hex baseline. Only touches entries whose `canon` is still undefined (never
 * overrides the player's opt-out) plus canon entries missing a baseline. Returns the
 * same array reference when nothing changed.
 */
export function markCanonFromLore(ledger: NPCEntry[], loreNpcs: NPCEntry[]): NPCEntry[] {
    let changed = false;
    const out = ledger.map(npc => {
        if (npc.isPC || npc.canon === false) return npc;
        if (npc.canon === true) {
            if (npc.canonHex || !npc.personalityHex) return npc;
            changed = true;
            return { ...npc, canonHex: { ...npc.personalityHex } };
        }
        const match = findLoreMatch(npc, loreNpcs);
        if (!match) return npc;
        changed = true;
        const baseline = match.personalityHex ?? npc.personalityHex;
        return { ...npc, canon: true, ...(baseline ? { canonHex: { ...baseline } } : {}) };
    });
    return changed ? out : ledger;
}

function hasValue(v: unknown): boolean {
    if (v === undefined || v === null) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return true;
}

/**
 * Lore import/re-import: merge freshly parsed lore NPCs into the ledger. A lore NPC that
 * matches an existing entry refreshes only the identity fields (and the hex baseline);
 * the existing entry's id and play state are kept. Unmatched lore NPCs are appended.
 * An entry the player marked `canon: false` keeps that flag.
 */
export function mergeLoreNPCs(existing: NPCEntry[], loreNpcs: NPCEntry[]): NPCEntry[] {
    const out = [...existing];
    for (const lore of loreNpcs) {
        const idx = out.findIndex(n => !n.isPC && findLoreMatch(n, [lore]));
        if (idx === -1) {
            out.push(lore);
            continue;
        }
        const cur = out[idx];
        const refreshed: NPCEntry = { ...cur };
        const writable = refreshed as unknown as Record<string, unknown>;
        for (const f of LORE_REFRESH_FIELDS) {
            if (hasValue(lore[f])) writable[f] = lore[f];
        }
        refreshed.canon = cur.canon === false ? false : true;
        const baseline = lore.personalityHex ?? cur.canonHex ?? cur.personalityHex;
        if (baseline) refreshed.canonHex = { ...baseline };
        out[idx] = refreshed;
    }
    return out;
}
