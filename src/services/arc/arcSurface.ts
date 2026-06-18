// Arc Engine — WO-02 surface line (arcSurface.ts).
// Pure, +0. Maps the current rung of an arc to ONE digest line, tagged by surface
// tier so the GM prompt knows how loud to play it. No raw rung number / tickDC ever
// reaches the payload — only this text. Mirrors the agencyDigest fold convention.
//
// Example output:
//   "[WORLD/ambient] Grain prices keep climbing in the lower districts."
//   "[WORLD/rumor] Shortage; a merchant you know starts rationing."
//   "[WORLD/direct] Bread riots and a district lockdown."
//
// Returns '' when the arc is not active or the current rung's surface is below the
// emit threshold (ARC_SURFACE_EMIT_MIN). Resolved/boiled_over/defused arcs are NOT
// surfaced here — their final rung label is written as a divergence fact by WO-05.

import type { ArcRecord } from '../../types';
import { ARC_SURFACE_TIER, ARC_SURFACE_EMIT_MIN } from './arcConstants';

export function arcSurfaceLine(arc: ArcRecord): string {
    if (arc.status !== 'active') return '';
    if (!arc.ladder || arc.ladder.length === 0) return '';
    const rung = arc.ladder[arc.currentRung];
    if (!rung || !rung.label) return '';

    const tierRank = ARC_SURFACE_TIER[rung.surface] ?? 0;
    const emitRank = ARC_SURFACE_TIER[ARC_SURFACE_EMIT_MIN] ?? 0;
    if (tierRank < emitRank) return '';

    return `[WORLD/${rung.surface}] ${rung.label}`;
}