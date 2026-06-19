// Arc Engine (System 2 / Oracle Function) — barrel.
// Files mirror the npc/ agency split: one concern each.
// Built out incrementally across WO-02 → WO-05.

// WO-02 — pure helpers (+0, immutable)
export {
    rollArcTick,
    rollArcOutcome,
    advanceRung,
} from './arcDice';
export { arcSurfaceLine } from './arcSurface';
export {
    ARC_TICK_DC,
    LADDER_MIN,
    LADDER_MAX,
    MAX_ACTIVE_ARCS,
    TYPE_COOLDOWN_SEAMS,
    ARC_LIVE_RECENCY,
    ARC_STANCE_MOD,
    ARC_BAND_RUNG_DELTA,
    ARC_SURFACE_EMIT_MIN,
    ARC_SURFACE_TIER,
    ARC_LIVE_PRESSURE_THRESHOLD,
} from './arcConstants';

// WO-03 — spawn (+1 LLM). Seam gate removed; now fired manually via the Arc Injector.
export { spawnArc, pickArcSpawnInput } from './arcSpawn';
export type { SpawnArcInput, SpawnArcAnchor } from './arcSpawn';

// WO-04 — stance scan (+0, deterministic)
export { scanArcStance } from './arcStance';

// WO-05 — world-state read-model (+0, pure)
export { arcWorldState } from './arcWorldState';