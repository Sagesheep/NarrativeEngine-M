import { describe, it, expect, vi } from 'vitest';
import { rollEngines, rollDiceFairness, mapTier } from '../engine';
import type { GameContext } from '../../types';
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
    diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
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

describe('rollDiceFairness', () => {
    it('returns empty string when dice fairness is disabled', () => {
        const ctx = { ...baseContext, diceFairnessActive: false };
        expect(rollDiceFairness(ctx)).toBe('');
    });

    it('returns dice outcome string when enabled', () => {
        const result = rollDiceFairness(baseContext);
        expect(result).toContain('DICE OUTCOMES');
        expect(result).toContain('COMBAT');
        expect(result).toContain('PERCEPTION');
        expect(result).toContain('STEALTH');
        expect(result).toContain('SOCIAL');
        expect(result).toContain('MOVEMENT');
        expect(result).toContain('KNOWLEDGE');
        expect(result).toContain('MUNDANE');
    });

    it('uses mapTier thresholds consistently', () => {
        const config = { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 };
        expect(mapTier(1, config)).toBe('Catastrophe');
        expect(mapTier(2, config)).toBe('Catastrophe');
        expect(mapTier(3, config)).toBe('Failure');
        expect(mapTier(6, config)).toBe('Failure');
        expect(mapTier(7, config)).toBe('Success');
        expect(mapTier(15, config)).toBe('Success');
        expect(mapTier(16, config)).toBe('Triumph');
        expect(mapTier(19, config)).toBe('Triumph');
        expect(mapTier(20, config)).toBe('Narrative Boon');
    });
});