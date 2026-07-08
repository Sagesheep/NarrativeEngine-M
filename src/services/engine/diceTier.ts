import type { DieType, OutcomeBand } from '../../types';

/**
 * Map a roll result to its outcome band label using the DieType's bands.
 * Returns the band label, or `null` if no band covers the value (shouldn't
 * happen if bands are validated to tile 1..faces).
 */
export function mapTier(rollResult: number, dieType?: DieType | null): string | null {
    if (!dieType || !dieType.bands || dieType.bands.length === 0) return null;
    const band = dieType.bands.find((b: OutcomeBand) => rollResult >= b.min && rollResult <= b.max);
    return band ? band.label : null;
}

/**
 * Validate that outcome bands tile 1..faces with no gaps or overlaps.
 * Returns { valid, error } — error is a human-readable message.
 */
export function validateBands(bands: OutcomeBand[], faces: number): { valid: boolean; error?: string } {
    if (bands.length === 0) return { valid: false, error: 'No outcome bands defined.' };
    const sorted = [...bands].sort((a, b) => a.min - b.min);
    if (sorted[0].min !== 1) return { valid: false, error: `First band must start at 1 (starts at ${sorted[0].min}).` };
    for (let i = 0; i < sorted.length; i++) {
        const b = sorted[i];
        if (b.min < 1 || b.max > faces) return { valid: false, error: `Band "${b.label}" exceeds 1..${faces}.` };
        if (b.min > b.max) return { valid: false, error: `Band "${b.label}" has min > max.` };
        if (i > 0) {
            const prev = sorted[i - 1];
            if (b.min !== prev.max + 1) {
                if (b.min <= prev.max) return { valid: false, error: `Band "${b.label}" overlaps "${prev.label}".` };
                return { valid: false, error: `Gap between "${prev.label}" (ends ${prev.max}) and "${b.label}" (starts ${b.min}).` };
            }
        }
    }
    const last = sorted[sorted.length - 1];
    if (last.max !== faces) return { valid: false, error: `Last band must end at ${faces} (ends at ${last.max}).` };
    return { valid: true };
}

// ── Legacy compat ─────────────────────────────────────────────────────
// Old callers may pass a DiceConfig-shaped object. We keep a thin shim
// that converts it to a DieType for mapTier. New code should pass DieType.
export type LegacyDiceConfig = {
    catastrophe: number; failure: number; success: number; triumph: number; crit: number;
};

export function mapTierLegacy(rollResult: number, cfg?: LegacyDiceConfig | null): string | null {
    if (!cfg) return null;
    const dieType: DieType = {
        id: 'legacy',
        name: 'd20',
        faces: 20,
        bands: [
            { id: 'l1', label: 'Catastrophe', min: 1, max: cfg.catastrophe },
            { id: 'l2', label: 'Failure', min: cfg.catastrophe + 1, max: cfg.failure },
            { id: 'l3', label: 'Success', min: cfg.failure + 1, max: cfg.success },
            { id: 'l4', label: 'Triumph', min: cfg.success + 1, max: cfg.triumph },
            { id: 'l5', label: 'Narrative Boon', min: cfg.triumph + 1, max: cfg.crit },
        ],
    };
    return mapTier(rollResult, dieType);
}