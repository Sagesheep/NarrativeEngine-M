/**
 * NPC validator — extracted from npcGeneration.ts (W10).
 * Personality hex validation, trait filtering, constants.
 */

import type { HexAxis, PersonalityHex } from '../../types';
import { TRAIT_VOCAB, TRAIT_NAMES } from './agencyPools';

export const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
export const MATURE_TRAITS = new Set(TRAIT_VOCAB.filter(t => t.tier === 'mature').map(t => t.text));
export const KNOWN_TRAITS = new Set(TRAIT_NAMES);

export const HEX_AXIS_LEGEND = `PERSONALITY AXES — rate each as an INTEGER from -3 to +3 (0 = average/neutral):
- drive: -3 listless … +3 relentlessly driven
- diligence: -3 negligent … +3 exacting
- boldness: -3 timid … +3 reckless
- warmth: -3 frigid … +3 effusive
- empathy: -3 callous … +3 selfless
- composure: -3 volatile … +3 unflappable`;

export function clampHexValue(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-3, Math.min(3, Math.round(n)));
}

export function validatePersonalityHex(raw: unknown): PersonalityHex {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const hex = {} as PersonalityHex;
    for (const axis of HEX_AXES) hex[axis] = clampHexValue(obj[axis]);
    return hex;
}

export function validateTraits(raw: unknown, matureMode: boolean): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
        const t = String(item).toLowerCase().trim();
        if (!KNOWN_TRAITS.has(t)) continue;
        if (!matureMode && MATURE_TRAITS.has(t)) continue;
        if (out.includes(t)) continue;
        out.push(t);
        if (out.length >= 5) break;
    }
    return out;
}

export function offeredTraitNames(matureMode: boolean): string[] {
    return TRAIT_VOCAB.filter(t => matureMode || t.tier !== 'mature').map(t => t.text);
}

export function defaultLongWant(faction: string): string {
    const f = (faction && faction.trim() && faction !== 'Unknown') ? faction.trim() : 'a name of their own';
    return `rise to a position of lasting power within ${f}`;
}
