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
    ARC_STANCE_MOD,
    ARC_BAND_RUNG_DELTA,
    ARC_SURFACE_EMIT_MIN,
    ARC_SURFACE_TIER,
} from './arcConstants';

// WO-03 — spawn (+1 LLM). Seam gate removed; now fired manually via the Arc Creator.
export { spawnArc, pickArcSpawnInput } from './arcSpawn';
export type { SpawnArcInput, SpawnArcAnchor } from './arcSpawn';

// Arc Creator — pickable types/tones and the immediate-arc hook directive (+0)
export {
    ARC_TYPE_OPTIONS,
    ARC_TONES,
    ARC_PACE_LABEL,
    arcTypeOption,
    pickSurpriseArc,
    buildArcHookDirective,
} from './arcCatalog';
export type { ArcTypeOption, ArmedArcHook } from './arcCatalog';

// WO-04 — stance scan (+0, deterministic)
export { scanArcStance } from './arcStance';