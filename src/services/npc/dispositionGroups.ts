import type { HexAxis } from '../../types';

// NPC Generation Refit (Phase 1) — archetype envelope tables.
//
// An envelope describes where a SOCIAL/disposition archetype usually lands on each of the 6
// personality axes: a `center` (where the axis usually lands, -3..+3) and a `spread`
// ('tight'|'normal'|'wide') controlling how often it strays. The roll helper
// (hexRoll.ts rollWeightedAxis) keeps the FULL -3..+3 reachable at every spread — weighted
// toward center, never clipped — so the rare "lazy fraud scholar" (-3 diligence) stays
// possible. See Upgrade/OpusPlans/NPC_Generation_Refit/00_SPEC.md §3.3 (weight, never wall).
//
// These are setting-agnostic personality templates, NOT jobs: 'scholar' = nerdy/bookish
// whether the world is medieval or cyberpunk. World-appropriateness comes from the proposal
// step (which groups plausibly appear in this scene), not from this table.

export type AxisSpread = 'tight' | 'normal' | 'wide';

export type AxisEnvelope = { center: number; spread: AxisSpread };

export type GroupEnvelope = Record<HexAxis, AxisEnvelope>;

export const ENVELOPES: Record<string, GroupEnvelope> = {
    scholar: {
        drive:     { center: 1,  spread: 'normal' },
        diligence: { center: 2,  spread: 'normal' },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: 0,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: 1,  spread: 'normal' },
    },
    brute: {
        drive:     { center: 1,  spread: 'normal' },
        diligence: { center: -1, spread: 'wide'   },
        boldness:  { center: 2,  spread: 'normal' },
        warmth:    { center: -1, spread: 'wide'   },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: -1, spread: 'wide'   },
    },
    fool: {
        drive:     { center: 0,  spread: 'wide'   },
        diligence: { center: -2, spread: 'normal' },
        boldness:  { center: 2,  spread: 'wide'   },
        warmth:    { center: 1,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: -2, spread: 'normal' },
    },
    zealot: {
        drive:     { center: 3,  spread: 'tight'  },
        diligence: { center: 1,  spread: 'normal' },
        boldness:  { center: 1,  spread: 'wide'   },
        warmth:    { center: -1, spread: 'wide'   },
        empathy:   { center: -2, spread: 'normal' },
        composure: { center: -1, spread: 'wide'   },
    },
    merchant: {
        drive:     { center: 1,  spread: 'normal' },
        diligence: { center: 1,  spread: 'normal' },
        boldness:  { center: 0,  spread: 'wide'   },
        warmth:    { center: 1,  spread: 'normal' },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: 1,  spread: 'normal' },
    },
    survivor: {
        drive:     { center: 1,  spread: 'normal' },
        diligence: { center: 1,  spread: 'wide'   },
        boldness:  { center: -1, spread: 'normal' },
        warmth:    { center: -2, spread: 'normal' },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: 1,  spread: 'normal' },
    },
    caretaker: {
        drive:     { center: 0,  spread: 'wide'   },
        diligence: { center: 1,  spread: 'normal' },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: 2,  spread: 'normal' },
        empathy:   { center: 2,  spread: 'tight'  },
        composure: { center: 1,  spread: 'normal' },
    },
    schemer: {
        drive:     { center: 2,  spread: 'normal' },
        diligence: { center: 1,  spread: 'normal' },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: -1, spread: 'wide'   },
        empathy:   { center: -2, spread: 'normal' },
        composure: { center: 2,  spread: 'tight'  },
    },
    drifter: {
        drive:     { center: -2, spread: 'tight'  },
        diligence: { center: -1, spread: 'wide'   },
        boldness:  { center: 0,  spread: 'wide'   },
        warmth:    { center: 0,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: 0,  spread: 'wide'   },
    },
    leader: {
        drive:     { center: 2,  spread: 'normal' },
        diligence: { center: 1,  spread: 'normal' },
        boldness:  { center: 2,  spread: 'tight'  },
        warmth:    { center: 1,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: 1,  spread: 'normal' },
    },
    artisan: {
        drive:     { center: 1,  spread: 'normal' },
        diligence: { center: 2,  spread: 'tight'  },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: 0,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: 1,  spread: 'normal' },
    },
    hedonist: {
        drive:     { center: -1, spread: 'wide'   },
        diligence: { center: -2, spread: 'normal' },
        boldness:  { center: 1,  spread: 'wide'   },
        warmth:    { center: 1,  spread: 'normal' },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: -1, spread: 'wide'   },
    },
    ascetic: {
        drive:     { center: 1,  spread: 'normal' },
        diligence: { center: 2,  spread: 'normal' },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: -2, spread: 'normal' },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: 2,  spread: 'tight'  },
    },
    trickster: {
        drive:     { center: 1,  spread: 'wide'   },
        diligence: { center: -1, spread: 'wide'   },
        boldness:  { center: 1,  spread: 'normal' },
        warmth:    { center: 1,  spread: 'wide'   },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: 1,  spread: 'normal' },
    },
    innocent: {
        drive:     { center: 0,  spread: 'wide'   },
        diligence: { center: 0,  spread: 'wide'   },
        boldness:  { center: -2, spread: 'normal' },
        warmth:    { center: 2,  spread: 'normal' },
        empathy:   { center: 2,  spread: 'tight'  },
        composure: { center: -1, spread: 'wide'   },
    },
    cynic: {
        drive:     { center: -1, spread: 'normal' },
        diligence: { center: 0,  spread: 'wide'   },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: -2, spread: 'normal' },
        empathy:   { center: -2, spread: 'tight'  },
        composure: { center: 0,  spread: 'wide'   },
    },
    thrillseeker: {
        drive:     { center: 2,  spread: 'normal' },
        diligence: { center: 0,  spread: 'wide'   },
        boldness:  { center: 3,  spread: 'tight'  },
        warmth:    { center: 0,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: -2, spread: 'normal' },
    },
    hermit: {
        drive:     { center: -1, spread: 'wide'   },
        diligence: { center: 0,  spread: 'wide'   },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: -3, spread: 'tight'  },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: 2,  spread: 'normal' },
    },
    busybody: {
        drive:     { center: 1,  spread: 'wide'   },
        diligence: { center: -1, spread: 'wide'   },
        boldness:  { center: 1,  spread: 'wide'   },
        warmth:    { center: 2,  spread: 'normal' },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: -2, spread: 'normal' },
    },
    peacemaker: {
        drive:     { center: 0,  spread: 'wide'   },
        diligence: { center: 1,  spread: 'wide'   },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: 1,  spread: 'wide'   },
        empathy:   { center: 2,  spread: 'normal' },
        composure: { center: 2,  spread: 'tight'  },
    },
    parasite: {
        drive:     { center: -2, spread: 'normal' },
        diligence: { center: -2, spread: 'normal' },
        boldness:  { center: -1, spread: 'wide'   },
        warmth:    { center: 0,  spread: 'wide'   },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: 0,  spread: 'wide'   },
    },
    dreamer: {
        drive:     { center: 2,  spread: 'normal' },
        diligence: { center: -2, spread: 'tight'  },
        boldness:  { center: 0,  spread: 'wide'   },
        warmth:    { center: 1,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: -1, spread: 'wide'   },
    },
    lackey: {
        drive:     { center: -1, spread: 'wide'   },
        diligence: { center: 2,  spread: 'normal' },
        boldness:  { center: -2, spread: 'normal' },
        warmth:    { center: 0,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: 1,  spread: 'wide'   },
    },
    rebel: {
        drive:     { center: 1,  spread: 'wide'   },
        diligence: { center: -1, spread: 'wide'   },
        boldness:  { center: 2,  spread: 'normal' },
        warmth:    { center: -1, spread: 'wide'   },
        empathy:   { center: -1, spread: 'wide'   },
        composure: { center: -2, spread: 'normal' },
    },
    martyr: {
        drive:     { center: 2,  spread: 'normal' },
        diligence: { center: 1,  spread: 'wide'   },
        boldness:  { center: 1,  spread: 'wide'   },
        warmth:    { center: 1,  spread: 'wide'   },
        empathy:   { center: 3,  spread: 'tight'  },
        composure: { center: -1, spread: 'wide'   },
    },
    coward: {
        drive:     { center: -1, spread: 'wide'   },
        diligence: { center: -1, spread: 'wide'   },
        boldness:  { center: -3, spread: 'tight'  },
        warmth:    { center: 0,  spread: 'wide'   },
        empathy:   { center: 0,  spread: 'wide'   },
        composure: { center: -2, spread: 'normal' },
    },
    cultist: {
        drive:     { center: 2,  spread: 'normal' },
        diligence: { center: 1,  spread: 'wide'   },
        boldness:  { center: 1,  spread: 'wide'   },
        warmth:    { center: 2,  spread: 'normal' },
        empathy:   { center: -2, spread: 'normal' },
        composure: { center: -2, spread: 'tight'  },
    },
};

// 00_SPEC §8 specifies a separate MODIFIERS[secondaryGroup] table (per-axis centerDelta +
// widen). That approach is SUPERSEDED: the secondary-group effect is now DERIVED at roll
// time from the two groups' own envelopes (pull the primary envelope's center ~40% toward
// the secondary group's own envelope center per axis; widen spread one step where the two
// centers diverge). See hexRoll.ts `applySecondaryEnvelope`. This table is kept as an
// empty structural placeholder for type-level compatibility with the WO-2 contract; FLASH
// does NOT author it. The derivation is the source of truth.
export type AxisModifier = { centerDelta?: number; widen?: boolean };
export type GroupModifiers = Partial<Record<HexAxis, AxisModifier>>;
export const MODIFIERS: Record<string, GroupModifiers> = {
    // Intentionally empty — derivation in hexRoll.ts supersedes (see comment above).
};

export const GROUP_KEYS: readonly string[] = Object.keys(ENVELOPES);