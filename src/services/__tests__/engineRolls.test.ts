import { describe, it, expect, vi } from 'vitest';
import { rollEngines, rollDiceFairness, mapTier } from '../engine';
import { buildDefaultDiceSystem } from '../../types';
import type { GameContext, DieType } from '../../types';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHAT, DEFAULT_WORLD_WHERE,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHY,
} from '../../store/slices/settingsSlice';

const baseContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: { identity: {}, activeTraits: [] },
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    characterProfileUserDisabled: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceSystem: buildDefaultDiceSystem(),
    surpriseConfig: { initialDC: 95, dcReduction: 3, types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES },
    encounterConfig: { initialDC: 198, dcReduction: 2, types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES },
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: DEFAULT_WORLD_WHO, where: DEFAULT_WORLD_WHERE, why: DEFAULT_WORLD_WHY, what: DEFAULT_WORLD_WHAT },
    notebook: [],
    notebookActive: true,
    inventoryLastScene: 'Never',
    characterProfileLastScene: 'Never',
};

describe('rollEngines', () => {
    it('returns empty appendToInput when all engines are disabled', () => {
        const ctx = { ...baseContext, surpriseEngineActive: false, encounterEngineActive: false, worldEngineActive: false };
        const result = rollEngines(ctx);
        expect(result.appendToInput).toBe('');
    });

    it('returns updated DCs even when no engine triggers', () => {
        const ctx = { ...baseContext, surpriseDC: 95, encounterDC: 198, worldEventDC: 498 };
        const result = rollEngines(ctx);
        expect(result.updatedDCs).toBeDefined();
        expect(typeof result.updatedDCs.surpriseDC).toBe('number');
        expect(typeof result.updatedDCs.encounterDC).toBe('number');
        expect(typeof result.updatedDCs.worldEventDC).toBe('number');
    });

    it('decrements surprise DC when engine is active', () => {
        const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
        const ctx = { ...baseContext, surpriseDC: 95, encounterDC: 9999, worldEventDC: 9999 };
        const result = rollEngines(ctx);
        expect(result.updatedDCs.surpriseDC).toBeLessThan(95);
        spy.mockRestore();
    });

    it('resets DC to initial when engine triggers (very low DC forces trigger)', () => {
        const ctx = { ...baseContext, surpriseDC: 1, encounterDC: 9999, worldEventDC: 9999 };
        const result = rollEngines(ctx);
        expect(result.appendToInput).toContain('SURPRISE');
        expect(result.updatedDCs.surpriseDC).toBeGreaterThanOrEqual(90);
    });

    it('encounter engine triggers with low DC', () => {
        const ctx = { ...baseContext, surpriseDC: 9999, encounterDC: 1, worldEventDC: 9999 };
        const result = rollEngines(ctx);
        expect(result.appendToInput).toContain('ENCOUNTER');
    });

    it('world engine triggers with low DC', () => {
        const ctx = { ...baseContext, surpriseDC: 9999, encounterDC: 9999, worldEventDC: 1 };
        const result = rollEngines(ctx);
        expect(result.appendToInput).toContain('WORLD_RUMOUR');
    });

    it('never reduces DC below 5', () => {
        const ctx = { ...baseContext, surpriseDC: 6, encounterDC: 9999, worldEventDC: 9999 };
        const result = rollEngines(ctx);
        expect(result.updatedDCs.surpriseDC).toBeGreaterThanOrEqual(5);
    });
});

describe('rollDiceFairness — generalized', () => {
    it('returns empty string when dice fairness is disabled', () => {
        const ctx = { ...baseContext, diceFairnessActive: false };
        expect(rollDiceFairness(ctx)).toBe('');
    });

    it('returns DICE OUTCOMES string with category names when enabled', () => {
        const result = rollDiceFairness(baseContext);
        expect(result).toContain('DICE OUTCOMES');
        // Default categories are Combat/Perception/Stealth/Social/Movement/Knowledge
        expect(result).toContain('COMBAT');
        expect(result).toContain('PERCEPTION');
        expect(result).toContain('STEALTH');
        expect(result).toContain('SOCIAL');
        expect(result).toContain('MOVEMENT');
        expect(result).toContain('KNOWLEDGE');
    });

    it('each category emits a (value → tier) pair', () => {
        const result = rollDiceFairness(baseContext);
        // New generalized format: "COMBAT=(N → Tier)"
        expect(result).toMatch(/COMBAT=\(\d+ → \w+/);
    });

    it('falls back to legacy d20 pool when diceSystem is absent', () => {
        const ctx: GameContext = { ...baseContext, diceSystem: undefined, diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 } };
        const result = rollDiceFairness(ctx);
        expect(result).toContain('DICE OUTCOMES');
        expect(result).toContain('MUNDANE');
        // Legacy format includes "Disadvantage:" / "Normal:" / "Advantage:"
        expect(result).toContain('Disadvantage:');
        expect(result).toContain('Normal:');
        expect(result).toContain('Advantage:');
    });
});

describe('mapTier — generalized', () => {
    const d20: DieType = buildDefaultDiceSystem().dieTypes.find(d => d.name === 'd20')!;

    it('maps d20 values to bands consistently', () => {
        expect(mapTier(1, d20)).toBe('Catastrophe');
        expect(mapTier(2, d20)).toBe('Catastrophe');
        expect(mapTier(3, d20)).toBe('Failure');
        expect(mapTier(6, d20)).toBe('Failure');
        expect(mapTier(7, d20)).toBe('Success');
        expect(mapTier(15, d20)).toBe('Success');
        expect(mapTier(16, d20)).toBe('Triumph');
        expect(mapTier(19, d20)).toBe('Triumph');
        expect(mapTier(20, d20)).toBe('Narrative Boon');
    });

    it('returns null when DieType is null/undefined', () => {
        expect(mapTier(10, null)).toBeNull();
        expect(mapTier(10, undefined)).toBeNull();
    });
});