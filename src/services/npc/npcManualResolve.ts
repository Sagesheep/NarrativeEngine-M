import type { NPCEntry } from '../../types';
import TITLES from '../../data/titles.json';

const TITLES_SET = new Set(TITLES.map(t => t.toLowerCase()));
const LEADING_ARTICLES = new Set(['the', 'a', 'an']);

/**
 * Outcome of resolving a player's highlighted text against the ledger.
 * - `empty`     — nothing usable in the selection.
 * - `create`    — no ledger match; a new NPC should be generated for `name`.
 * - `update`    — exactly one ledger match; that NPC should be updated.
 * - `ambiguous` — the selection (e.g. a shared family name like "Masamune")
 *                 matches 2+ ledger entries. No change is made; the caller
 *                 tells the user to highlight a fuller name.
 */
export type NpcResolution =
    | { kind: 'empty' }
    | { kind: 'create'; name: string }
    | { kind: 'update'; name: string; npc: NPCEntry }
    | { kind: 'ambiguous'; name: string; matches: NPCEntry[] };

/**
 * Clean a raw highlight into a candidate name: collapse whitespace, drop
 * surrounding quotes/brackets/punctuation, strip a trailing possessive and a
 * leading article, then peel leading titles ("Captain Hikaru" -> "Hikaru").
 */
export function normalizeSelection(raw: string): string {
    if (!raw) return '';
    let s = raw.replace(/\s+/g, ' ').trim();
    // strip surrounding quotes / brackets / parens / trailing sentence punctuation
    s = s.replace(/^[\s"'“”‘’[(]+/, '').replace(/[\s"'“”‘’\]).,;:!?]+$/, '');
    // strip possessive ('s or ’s)
    s = s.replace(/['’]s$/i, '');
    s = s.trim();
    let parts = s.split(' ').filter(Boolean);
    // drop a single leading article
    if (parts.length > 1 && LEADING_ARTICLES.has(parts[0].toLowerCase())) {
        parts = parts.slice(1);
    }
    // peel leading titles (Captain, Lady, Lord, ...), keep at least one token
    while (parts.length > 1 && TITLES_SET.has(parts[0].toLowerCase())) {
        parts = parts.slice(1);
    }
    return parts.join(' ').trim();
}

/**
 * Symmetric word-boundary match — mirrors classifyNPCNames so manual and
 * automatic resolution agree. Matches whole tokens only: "Hikaru" matches
 * "Hikaru Masamune", but "Ren" does NOT match "Renji".
 */
function namesMatch(ledgerName: string, search: string): boolean {
    const lower = ledgerName.toLowerCase();
    const q = search.toLowerCase();
    return lower === q
        || lower.startsWith(q + ' ') || lower.endsWith(' ' + q)
        || q.startsWith(lower + ' ') || q.endsWith(' ' + lower);
}

/** All ledger entries whose name or any alias matches `name`. */
export function findLedgerMatches(name: string, ledger: NPCEntry[]): NPCEntry[] {
    if (!name) return [];
    return ledger.filter(npc => {
        if (!npc.name) return false;
        const allNames = [npc.name, ...(npc.aliases || '').split(',').map(a => a.trim())].filter(Boolean);
        return allNames.some(n => namesMatch(n, name));
    });
}

/** Resolve a raw highlighted selection against the ledger. */
export function resolveNpcSelection(raw: string, ledger: NPCEntry[]): NpcResolution {
    const name = normalizeSelection(raw);
    if (!name) return { kind: 'empty' };

    const matches = findLedgerMatches(name, ledger);
    if (matches.length === 0) return { kind: 'create', name };
    if (matches.length === 1) return { kind: 'update', name, npc: matches[0] };
    return { kind: 'ambiguous', name, matches };
}
