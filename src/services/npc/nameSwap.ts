import type { NPCEntry } from '../../types';
import { extractNPCNames } from './npcDetector';
import { lookupCultures, genderOf, drawUnusedName } from './nameBank';

/**
 * Deterministic NPC name-swap backstop (Plan 05, Components D/F/I).
 *
 * The shipped prompt guard ("don't reuse these names") depends on model
 * compliance; weak models — and even strong ones at high context — leak. This
 * module is the deterministic catch: after the story AI emits prose, it detects
 * a newly-introduced name that collides with the ledger and, when the engine can
 * PROVE the model couldn't have meant the existing character, mechanically
 * rewrites the prose with an unused, culture- and gender-matched replacement —
 * before display, archive, and detection commit (the single rewrite point lives
 * in turnOrchestrator).
 *
 * Design guarantees:
 *  - Collision keys on FIRST NAMES ONLY, so "John Ashwood" alongside "Rick
 *    Ashwood" (shared clan surname) never collides — the relation exception is
 *    automatic.
 *  - Every 'swap' verdict requires positive evidence the model couldn't mean the
 *    existing NPC. Ambiguity → 'flag', never a blind swap (a wrong swap corrupts
 *    canon and is strictly worse than a duplicate).
 *  - Replacement culture comes from the colliding name itself (Component D), so
 *    no model call and no campaign-culture cage: a Japanese mint is replaced from
 *    Japanese names even in a western campaign.
 */

export type SwapVerdict = 'swap' | 'leave' | 'flag';

export interface SwapResult {
    text: string;
    swaps: { from: string; to: string; npcId: string }[];
    /** Collisions the engine couldn't resolve deterministically — for the (future) one-tap UX. */
    flags: { name: string; npcId: string }[];
}

export interface SwapContext {
    ledger: NPCEntry[];
    /** NPC ids physically on-stage this turn (hard veto — a mention is a reference). */
    onStageNpcIds?: string[];
    /** NPC ids whose profile was included in this turn's payload. When undefined the
     *  "not in payload" signal is unknown, so we never CONFIDENTLY swap (bias to flag). */
    activeNpcIds?: string[];
    /** Lore [CHUNK] header names a replacement must never collide with. */
    loreHeaders?: string[];
    /** Injectable RNG for deterministic tests. */
    rng?: () => number;
}

/** First whitespace token, lowercased — the collision key. */
function firstName(name: string): string {
    return (name ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

function npcFirstNames(npc: NPCEntry): string[] {
    const names = [npc.name, ...(npc.aliases || '').split(',')];
    return names.map(firstName).filter(Boolean);
}

export interface Collision { introduced: string; npc: NPCEntry; }

/**
 * Pair each introduced name with an existing ledger NPC sharing its FIRST name.
 * First match wins per introduced name. PCs are never collision targets here.
 */
export function detectCollisions(introducedNames: string[], ledger: NPCEntry[]): Collision[] {
    const out: Collision[] = [];
    for (const introduced of introducedNames) {
        const key = firstName(introduced);
        if (!key) continue;
        const npc = ledger.find(n => npcFirstNames(n).includes(key));
        if (npc) out.push({ introduced, npc });
    }
    return out;
}

function isDead(npc: NPCEntry): boolean {
    if (npc.condition === 'dead') return true;
    return /\b(dead|deceased|killed|slain)\b/i.test(npc.status || '');
}

/**
 * The decision table (Component F). Given a collision, decide whether the
 * introduced name is a duplicate to swap, a legitimate reference to leave, or an
 * ambiguous case to flag.
 */
export function decideSwap(opts: { npc: NPCEntry; onStage: boolean; inPayload: boolean }): SwapVerdict {
    const { npc, onStage, inPayload } = opts;
    if (npc.isPC) return 'leave';        // never rename the player character
    if (onStage) return 'leave';         // row 1 — physically present → it's a reference (hard veto)
    if (isDead(npc)) return 'swap';      // row 3 — a new same-name character can't be them
    if (!inPayload) return 'swap';       // row 2 — model never saw them this turn; coincidence mint
    return 'flag';                       // rows 4/5/6 — in payload, off-stage: gray zone → flag, don't guess
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace every whole-word occurrence of a first name (incl. possessive
 * "Voss's" — \b sits between the name and the apostrophe). Pure string op.
 */
export function applySwap(text: string, fromFirstName: string, to: string): string {
    if (!fromFirstName) return text;
    // Case-insensitive: the collision key is lowercased but prose (and the bank)
    // capitalize names. Replacement keeps its own (capitalized) casing.
    const re = new RegExp(`\\b${escapeRegex(fromFirstName)}\\b`, 'gi');
    return text.replace(re, to);
}

/**
 * The single public entry point, called at the turn's canonical rewrite point.
 * Detects collisions in `text`, applies confident swaps, and returns the
 * rewritten text plus a record of swaps and unresolved flags.
 */
export function swapDuplicateNames(text: string, ctx: SwapContext): SwapResult {
    const result: SwapResult = { text, swaps: [], flags: [] };
    if (!text || ctx.ledger.length === 0) return result;

    const introduced = extractNPCNames(text);
    if (introduced.length === 0) return result;

    const collisions = detectCollisions(introduced, ctx.ledger);
    if (collisions.length === 0) return result;

    const onStage = new Set(ctx.onStageNpcIds ?? []);
    // activeNpcIds undefined → signal unavailable → assume "in payload" so we
    // never confidently swap on a guess (decideSwap then yields 'flag').
    const activeKnown = ctx.activeNpcIds !== undefined;
    const inPayloadSet = new Set(ctx.activeNpcIds ?? []);

    // Names a replacement must avoid: every ledger first name + lore headers +
    // names we assign during this pass (so two swaps don't pick the same name).
    const exclude = new Set<string>();
    for (const n of ctx.ledger) for (const fn of npcFirstNames(n)) exclude.add(fn);
    for (const h of ctx.loreHeaders ?? []) exclude.add(firstName(h));

    const seen = new Set<string>();
    for (const { introduced: name, npc } of collisions) {
        const key = firstName(name);
        if (seen.has(key)) continue; // collapse duplicate introductions of the same name
        seen.add(key);

        const verdict = decideSwap({
            npc,
            onStage: onStage.has(npc.id),
            inPayload: activeKnown ? inPayloadSet.has(npc.id) : true,
        });

        if (verdict === 'flag') {
            result.flags.push({ name, npcId: npc.id });
            continue;
        }
        if (verdict === 'leave') continue;

        const replacement = drawUnusedName({
            cultures: lookupCultures(key),
            gender: genderOf(key),
            exclude,
            rng: ctx.rng,
        });
        if (!replacement) {
            // Pool exhausted — safer to flag than to leave a known duplicate silently.
            result.flags.push({ name, npcId: npc.id });
            continue;
        }
        exclude.add(replacement.toLowerCase());
        result.text = applySwap(result.text, key, replacement);
        result.swaps.push({ from: name, to: replacement, npcId: npc.id });
    }

    return result;
}
