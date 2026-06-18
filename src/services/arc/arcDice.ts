// Arc Engine — WO-02 pure dice helpers (arcDice.ts).
// Pure, immutable, ZERO LLM calls. Mirrors the agency precedent:
//   - rollArcTick  mirrors rollHeartbeat (fire → reset to initial; miss → reduce/floor).
//   - rollArcOutcome follows rollGoal's d20+mods convention, with stance via ARC_STANCE_MOD.
//   - advanceRung  clamps the rung per ARC_BAND_RUNG_DELTA (floor 0, ceiling ladder.length-1).
// All functions take a default `rng` param so Flash's tests can inject a deterministic rng.

import type { ArcRecord } from '../../types';
import type { Band } from '../npc/agencyConstants';
import { bandFromMargin } from '../npc/agencyDice';
import {
    ARC_TICK_DC,
    ARC_STANCE_MOD,
    ARC_BAND_RUNG_DELTA,
} from './arcConstants';

/**
 * Tempo: does this arc advance this seam? Escalating-DC pity timer. MIRRORS rollHeartbeat:
 * fire → reset to initial; miss → reduce by `reduction`, floored. Same {fired,nextDc} shape.
 */
export function rollArcTick(
    arc: Pick<ArcRecord, 'tickDC'>,
    rng: () => number = Math.random,
): { fired: boolean; nextDc: number } {
    const roll = Math.floor(rng() * 100) + 1;
    if (roll >= arc.tickDC) {
        return { fired: true, nextDc: ARC_TICK_DC.initial };
    }
    return {
        fired: false,
        nextDc: Math.max(ARC_TICK_DC.floor, arc.tickDC - ARC_TICK_DC.reduction),
    };
}

/**
 * Outcome: WHEN a tick fires, which Band? Reuse the agency dice convention (d20 + mods
 * vs a fixed base DC). `stance` supplies extraMods via ARC_STANCE_MOD. Returns a Band.
 *
 * The DC is the agency GOAL_BASE_DC (10) — same fixed base that lets the karma/stance
 * nudges mean something. Stance is the only modifier here (arcs have no failStreak/
 * karma of their own; the stance read IS the karma). Returns { band } only — the
 * caller (advanceRung) reads the delta off ARC_BAND_RUNG_DELTA.
 */
export function rollArcOutcome(
    arc: Pick<ArcRecord, 'stance'>,
    rng: () => number = Math.random,
): { band: Band } {
    const baseDc = 10;  // mirrors agencyDice.rollGoal's GOAL_BASE_DC — fixed base, stance is the nudge
    const extraMods = ARC_STANCE_MOD[arc.stance] ?? 0;
    const nat = Math.floor(rng() * 20) + 1;
    const roll = nat + extraMods;
    const margin = roll - baseDc;
    const band = bandFromMargin(nat, margin);  // reuse the agency band mapper (nat 20/1 override)
    return { band };
}

/**
 * Move the rung. delta = ARC_BAND_RUNG_DELTA[band], CLAMPED to [0, ladder.length-1].
 * Returns a NEW ArcRecord (immutable). Sets status:'boiled_over' if it would pass the
 * top rung, 'defused' is NOT set here (that's a player action in WO-05).
 * lastTickScene is updated by the caller (WO-05), not here.
 */
export function advanceRung(arc: ArcRecord, band: Band): ArcRecord {
    const maxRung = arc.ladder.length - 1;
    if (maxRung < 0) return arc;  // degenerate ladder — defensive, spawn rejects this

    const delta = ARC_BAND_RUNG_DELTA[band] ?? 0;
    const target = arc.currentRung + delta;

    // Boiled-over: a climb that would pass the top rung lands the arc at the top and
    // marks it boiled_over (the crisis arrived). Regression always clamps at 0 — it
    // never sets defused (defused is a player-resolution outcome, WO-05).
    if (target >= maxRung) {
        const atTop = arc.currentRung >= maxRung;
        // Already at top + a climb → boiled_over. A climb arriving at top from below
        // also marks boiled_over (the crisis lands this tick).
        if (delta > 0 || atTop) {
            return { ...arc, currentRung: maxRung, status: 'boiled_over' };
        }
        return { ...arc, currentRung: maxRung };
    }

    const clamped = Math.max(0, target);
    return { ...arc, currentRung: clamped };
}