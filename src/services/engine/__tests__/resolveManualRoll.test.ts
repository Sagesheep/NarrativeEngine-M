import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveManualRoll } from '../engineRolls';
import type { DiceConfig } from '../../../types';

// Default thresholds (mirror diceTier.ts DEFAULT_DICE_CONFIG):
// catastrophe<=2, failure<=6, success<=15, triumph<=19, else Narrative Boon.
const CFG: DiceConfig = { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 };

// Math.random() returns [0,1); roll = floor(r*20)+1. To force face F, use r = (F-1)/20.
function face(f: number): number { return (f - 1) / 20; }

afterEach(() => vi.restoreAllMocks());

describe('resolveManualRoll', () => {
    it('1d20 rolls one die and maps via diceConfig', () => {
        vi.spyOn(Math, 'random').mockReturnValueOnce(face(17)); // 17 → Triumph (16-19)
        const r = resolveManualRoll('1d20', CFG);
        expect(r.rolls).toEqual([17]);
        expect(r.faceValue).toBe(17);
        expect(r.detail).toBe('Roll');
        expect(r.tier).toBe('Triumph');
    });

    it('advantage rolls 2d20 and keeps the HIGHER', () => {
        vi.spyOn(Math, 'random')
            .mockReturnValueOnce(face(4))   // 4 → would be Failure
            .mockReturnValueOnce(face(18)); // 18 → Triumph
        const r = resolveManualRoll('adv', CFG);
        expect(r.rolls).toEqual([4, 18]);
        expect(r.faceValue).toBe(18);       // kept the higher
        expect(r.detail).toBe('Advantage');
        expect(r.tier).toBe('Triumph');
    });

    it('disadvantage rolls 2d20 and keeps the LOWER', () => {
        vi.spyOn(Math, 'random')
            .mockReturnValueOnce(face(19))  // 19 → Triumph
            .mockReturnValueOnce(face(3));  // 3 → Failure
        const r = resolveManualRoll('disadv', CFG);
        expect(r.rolls).toEqual([19, 3]);
        expect(r.faceValue).toBe(3);        // kept the lower
        expect(r.detail).toBe('Disadvantage');
        expect(r.tier).toBe('Failure');
    });

    it('maps tier boundaries correctly (catastrophe / boon)', () => {
        vi.spyOn(Math, 'random').mockReturnValueOnce(face(1));
        expect(resolveManualRoll('1d20', CFG).tier).toBe('Catastrophe'); // 1 <= 2
        vi.restoreAllMocks();
        vi.spyOn(Math, 'random').mockReturnValueOnce(face(20));
        expect(resolveManualRoll('1d20', CFG).tier).toBe('Narrative Boon'); // 20 > 19
    });

    it('falls back to default thresholds when no diceConfig given', () => {
        vi.spyOn(Math, 'random').mockReturnValueOnce(face(10)); // 10 → Success
        expect(resolveManualRoll('1d20').tier).toBe('Success');
    });

    it('every face value (1-20) yields a valid tier for all modes', () => {
        const tiers = new Set(['Catastrophe', 'Failure', 'Success', 'Triumph', 'Narrative Boon']);
        for (const mode of ['1d20', 'adv', 'disadv'] as const) {
            for (let i = 0; i < 200; i++) {
                const r = resolveManualRoll(mode, CFG);
                expect(tiers.has(r.tier)).toBe(true);
                expect(r.faceValue).toBeGreaterThanOrEqual(1);
                expect(r.faceValue).toBeLessThanOrEqual(20);
                expect(r.rolls.length).toBe(mode === '1d20' ? 1 : 2);
            }
        }
    });
});
