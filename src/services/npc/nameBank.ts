import NAME_BANK_DATA from '../../data/nameBank.json';

/**
 * Engine-shipped name bank (Plan 05, Component A). A static, offline list of
 * given names organised by culture header, generated from the campaign-agnostic
 * asset pipeline (scripts/buildNameBank.mjs).
 *
 * Dual purpose:
 *  1. Draw pool — `drawUnusedName` supplies replacement names for the deterministic
 *     swap and the (future) per-turn name menu.
 *  2. Name → culture self-classifier — `lookupCultures` lets the swap pick a
 *     replacement from the SAME culture the story AI implied by the colliding
 *     name, with ZERO model calls (Component D). A name may belong to several
 *     cultures ("Anna" is english/german/russian/...); we keep every membership.
 *
 * Lookups are O(1) Set/Map membership — no trie needed at this size (~6k names).
 */

export type Gender = 'm' | 'f' | 'u';

type RawEntry = { n: string; c: string; g: string };
type Entry = { n: string; c: string; g: Gender };

const FALLBACK_CULTURE = 'fantasy-neutral';

interface NameInfo {
    display: string;
    cultures: Set<string>;
    genders: Set<Gender>;
}

const asGender = (g: string): Gender => (g === 'm' || g === 'f' ? g : 'u');

// byLower: first-name (lowercased) → membership info. byCulture: culture → entries.
const byLower = new Map<string, NameInfo>();
const byCulture = new Map<string, Entry[]>();

for (const raw of NAME_BANK_DATA as RawEntry[]) {
    const g = asGender(raw.g);
    const key = raw.n.toLowerCase();
    let info = byLower.get(key);
    if (!info) {
        info = { display: raw.n, cultures: new Set(), genders: new Set() };
        byLower.set(key, info);
    }
    info.cultures.add(raw.c);
    info.genders.add(g);

    let bucket = byCulture.get(raw.c);
    if (!bucket) { bucket = []; byCulture.set(raw.c, bucket); }
    bucket.push({ n: raw.n, c: raw.c, g });
}

/** All culture header keys present in the bank. */
export const NAME_CULTURES: string[] = [...byCulture.keys()];

/** True if the given (first) name exists anywhere in the bank. */
export function isKnownName(name: string): boolean {
    return byLower.has(firstNameLower(name));
}

/** Cultures the name belongs to. Empty array if the name is not in the bank. */
export function lookupCultures(name: string): string[] {
    const info = byLower.get(firstNameLower(name));
    return info ? [...info.cultures] : [];
}

/**
 * The name's typical gender. If it appears as both masculine and feminine across
 * cultures (or is tagged unisex), returns 'u'. Undefined if not in the bank.
 */
export function genderOf(name: string): Gender | undefined {
    const info = byLower.get(firstNameLower(name));
    if (!info) return undefined;
    if (info.genders.size === 1) return [...info.genders][0];
    if (info.genders.has('m') && info.genders.has('f')) return 'u';
    // mix of a definite gender + unisex → take the definite one
    return info.genders.has('m') ? 'm' : info.genders.has('f') ? 'f' : 'u';
}

/** A 'u' (unisex) name is acceptable for any requested gender. */
function genderMatches(entryGender: Gender, want?: Gender): boolean {
    if (!want || want === 'u') return true;
    return entryGender === want || entryGender === 'u';
}

/**
 * Draw a random name not already taken.
 *
 * @param cultures Preferred culture(s) to draw from. Falls back to fantasy-neutral,
 *                 then the whole bank, if a preferred pool yields nothing usable.
 * @param gender   Preferred gender; unisex names always qualify. Relaxed before
 *                 widening cultures, so culture-fit is prioritised over gender-fit.
 * @param exclude  Lowercased names already in use (ledger first names, lore headers,
 *                 the colliding name itself). MUST be lowercased by the caller.
 * @param rng      Injectable RNG for deterministic tests (defaults to Math.random).
 * @returns        A display-cased name, or undefined if the entire bank is exhausted.
 */
export function drawUnusedName(opts: {
    cultures?: string[];
    gender?: Gender;
    exclude?: Set<string>;
    rng?: () => number;
}): string | undefined {
    const { gender, exclude = new Set(), rng = Math.random } = opts;
    const cultures = (opts.cultures && opts.cultures.length > 0) ? opts.cultures : undefined;

    // Pool tiers, tried in order: requested cultures (gender-matched) → requested
    // cultures (any gender) → fantasy-neutral → entire bank.
    const requested = cultures ? entriesForCultures(cultures) : entriesForCultures(NAME_CULTURES);
    const tiers: Entry[][] = [
        requested.filter(e => genderMatches(e.g, gender)),
        requested,
        entriesForCultures([FALLBACK_CULTURE]),
        entriesForCultures(NAME_CULTURES),
    ];

    for (const tier of tiers) {
        const usable = tier.filter(e => !exclude.has(e.n.toLowerCase()));
        if (usable.length > 0) {
            return usable[Math.floor(rng() * usable.length)].n;
        }
    }
    return undefined;
}

function entriesForCultures(cultures: string[]): Entry[] {
    const out: Entry[] = [];
    for (const c of cultures) {
        const bucket = byCulture.get(c);
        if (bucket) out.push(...bucket);
    }
    return out;
}

/** First whitespace-delimited token, lowercased. Keys the bank on first names. */
function firstNameLower(name: string): string {
    return name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}
