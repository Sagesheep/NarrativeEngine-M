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
    // NOTE: STUB VALUES — FLASH authors the real envelopes (see 02_FLASH_TABLES.md).
    // These three groups exist so the table compiles and the roll engine + pipeline can be
    // built and tested against them. FLASH replaces/extends the set (~12–16 archetypes).
    scholar: {
        drive:     { center: 0, spread: 'normal' },
        diligence: { center: 0, spread: 'normal' },
        boldness:  { center: 0, spread: 'normal' },
        warmth:    { center: 0, spread: 'normal' },
        empathy:   { center: 0, spread: 'normal' },
        composure: { center: 0, spread: 'normal' },
    },
    brute: {
        drive:     { center: 0, spread: 'normal' },
        diligence: { center: 0, spread: 'normal' },
        boldness:  { center: 0, spread: 'normal' },
        warmth:    { center: 0, spread: 'normal' },
        empathy:   { center: 0, spread: 'normal' },
        composure: { center: 0, spread: 'normal' },
    },
    fool: {
        drive:     { center: 0, spread: 'normal' },
        diligence: { center: 0, spread: 'normal' },
        boldness:  { center: 0, spread: 'normal' },
        warmth:    { center: 0, spread: 'normal' },
        empathy:   { center: 0, spread: 'normal' },
        composure: { center: 0, spread: 'normal' },
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