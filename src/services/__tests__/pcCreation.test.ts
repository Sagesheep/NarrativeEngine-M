import { describe, it, expect } from 'vitest';
import {
    PC_POINT_BUY,
    STAT_KEYS,
    getPointCost,
    validateAllocation,
    allocateStat,
    ARCHETYPE_PRESETS,
    CREATION_QUESTIONS,
    getPCTier,
    getPCBudget,
    buildCharacterProfileText,
    buildCharacterProfileState,
    DEFAULT_STATS,
} from '../engine/pcCreationScript';
import type { StatBlock } from '../../types';

describe('PC_POINT_BUY', () => {
    it('defines NORMAL budget with 27 points and grunt tier', () => {
        expect(PC_POINT_BUY.NORMAL.totalPoints).toBe(27);
        expect(PC_POINT_BUY.NORMAL.min).toBe(8);
        expect(PC_POINT_BUY.NORMAL.max).toBe(15);
        expect(PC_POINT_BUY.NORMAL.tier).toBe('grunt');
    });

    it('defines OP budget with 37 points and elite tier', () => {
        expect(PC_POINT_BUY.OP.totalPoints).toBe(37);
        expect(PC_POINT_BUY.OP.min).toBe(8);
        expect(PC_POINT_BUY.OP.max).toBe(20);
        expect(PC_POINT_BUY.OP.tier).toBe('elite');
    });
});

describe('getPointCost', () => {
    it('returns D&D 5e standard point costs for NORMAL budget', () => {
        expect(getPointCost(8, 'NORMAL')).toBe(0);
        expect(getPointCost(10, 'NORMAL')).toBe(2);
        expect(getPointCost(13, 'NORMAL')).toBe(5);
        expect(getPointCost(14, 'NORMAL')).toBe(7);
        expect(getPointCost(15, 'NORMAL')).toBe(9);
    });

    it('returns extended point costs for OP budget', () => {
        expect(getPointCost(16, 'OP')).toBe(11);
        expect(getPointCost(17, 'OP')).toBe(13);
        expect(getPointCost(18, 'OP')).toBe(15);
        expect(getPointCost(19, 'OP')).toBe(17);
        expect(getPointCost(20, 'OP')).toBe(19);
    });

    it('returns 99 for out-of-range values', () => {
        expect(getPointCost(7, 'NORMAL')).toBe(99);
        expect(getPointCost(20, 'NORMAL')).toBe(99);
    });
});

describe('validateAllocation', () => {
    it('validates all-8s as valid with 0 points spent (NORMAL)', () => {
        const result = validateAllocation(DEFAULT_STATS, 'NORMAL');
        expect(result.isValid).toBe(true);
        expect(result.pointsSpent).toBe(0);
        expect(result.pointsRemaining).toBe(27);
    });

    it('rejects stats exceeding max', () => {
        const over: StatBlock = { VIT: 16, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 };
        const result = validateAllocation(over, 'NORMAL');
        expect(result.isValid).toBe(false);
    });

    it('accepts stats at 16-18 when OP budget', () => {
        const op: StatBlock = { VIT: 16, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 };
        const result = validateAllocation(op, 'OP');
        expect(result.isValid).toBe(true);
    });

    it('rejects overspend', () => {
        const overspent: StatBlock = { VIT: 15, PWR: 15, RES: 14, FOC: 15, SPD: 8, WIL: 8 };
        const result = validateAllocation(overspent, 'NORMAL');
        expect(result.isValid).toBe(false);
    });

    it('ARCHETYPE_PRESETS are valid for NORMAL budget', () => {
        for (const [archetype, stats] of Object.entries(ARCHETYPE_PRESETS)) {
            const result = validateAllocation(stats, 'NORMAL');
            expect(result.isValid, `Preset ${archetype} should be valid`).toBe(true);
        }
    });

    it('bulwark preset matches expected distribution', () => {
        expect(ARCHETYPE_PRESETS.bulwark).toEqual({ VIT: 15, PWR: 10, RES: 14, FOC: 8, SPD: 8, WIL: 10 });
    });
});

describe('allocateStat', () => {
    it('sets a stat value within bounds', () => {
        const result = allocateStat(DEFAULT_STATS, 'VIT', 14, 'NORMAL');
        expect(result.VIT).toBe(14);
    });

    it('clamps to max', () => {
        const result = allocateStat(DEFAULT_STATS, 'VIT', 20, 'NORMAL');
        expect(result.VIT).toBe(15);
    });

    it('clamps to min', () => {
        const result = allocateStat(DEFAULT_STATS, 'VIT', 3, 'NORMAL');
        expect(result.VIT).toBe(8);
    });

    it('OP budget allows higher max', () => {
        const result = allocateStat(DEFAULT_STATS, 'VIT', 18, 'OP');
        expect(result.VIT).toBe(18);
    });

    it('leaves other stats unchanged', () => {
        const result = allocateStat(DEFAULT_STATS, 'PWR', 12, 'NORMAL');
        expect(result.VIT).toBe(DEFAULT_STATS.VIT);
        expect(result.WIL).toBe(DEFAULT_STATS.WIL);
    });
});

describe('getPCTier / getPCBudget', () => {
    it('NORMAL budget returns grunt tier', () => {
        expect(getPCTier(false)).toBe('grunt');
    });

    it('OP budget returns elite tier', () => {
        expect(getPCTier(true)).toBe('elite');
    });

    it('getPCBudget maps boolean correctly', () => {
        expect(getPCBudget(false)).toBe('NORMAL');
        expect(getPCBudget(true)).toBe('OP');
    });
});

describe('buildCharacterProfileState', () => {
    it('produces a structured profile with identity, stats, and seeded traits', () => {
        const state = buildCharacterProfileState({
            name: 'Test Hero',
            concept: 'A wandering swordsman',
            playstyle: 'Stand firm and protect allies (Bulwark)',
            voice: 'Deep, measured',
            drives: 'To find redemption',
            stats: ARCHETYPE_PRESETS.bulwark,
            archetype: 'bulwark',
            isOP: false,
        });
        expect(state.identity.name).toBe('Test Hero');
        expect(state.identity.archetype).toBe('bulwark');
        expect(state.identity.level).toBe(1);
        expect(state.stats).toEqual(ARCHETYPE_PRESETS.bulwark);
        // Should have seeded traits for concept, voice, drives, archetype
        expect(state.activeTraits.length).toBeGreaterThanOrEqual(3);
        expect(state.activeTraits.some(t => t.text.includes('A wandering swordsman'))).toBe(true);
        expect(state.activeTraits.some(t => t.text.includes('Deep, measured'))).toBe(true);
        expect(state.activeTraits.some(t => t.text.includes('To find redemption'))).toBe(true);
        // All traits should be non-superseded and seeded
        expect(state.activeTraits.every(t => !t.superseded)).toBe(true);
        expect(state.activeTraits.every(t => t.source === 'seed')).toBe(true);
        // Traits should have event tags
        expect(state.activeTraits.every(t => t.eventTags.length > 0)).toBe(true);
    });

    it('omits optional traits when fields are absent', () => {
        const state = buildCharacterProfileState({
            name: 'Minimal',
            stats: DEFAULT_STATS,
            archetype: 'assassin',
            isOP: false,
        });
        expect(state.identity.name).toBe('Minimal');
        expect(state.identity.archetype).toBe('assassin');
        // Only the archetype trait is seeded (concept/voice/drives absent)
        expect(state.activeTraits.length).toBe(1);
        expect(state.activeTraits[0].text).toContain('assassin');
    });
});

describe('buildCharacterProfileText (deprecated flat-string projection)', () => {
    it('produces a flat-string projection of the structured state', () => {
        const text = buildCharacterProfileText({
            name: 'Test Hero',
            concept: 'A wandering swordsman',
            playstyle: 'Stand firm and protect allies (Bulwark)',
            voice: 'Deep, measured',
            drives: 'To find redemption',
            stats: ARCHETYPE_PRESETS.bulwark,
            archetype: 'bulwark',
            isOP: false,
        });
        expect(text).toContain('Test Hero');
        expect(text).toContain('bulwark');
        expect(text).toContain('VIT');
        expect(text).toContain('Concept: A wandering swordsman');
        expect(text).toContain('Voice: Deep, measured');
        expect(text).toContain('Drives: To find redemption');
    });

    it('omits optional fields when absent', () => {
        const text = buildCharacterProfileText({
            name: 'Minimal',
            stats: DEFAULT_STATS,
            archetype: 'assassin',
            isOP: false,
        });
        expect(text).toContain('Minimal');
        expect(text).not.toContain('Concept:');
        expect(text).not.toContain('Voice:');
    });
});

describe('CREATION_QUESTIONS', () => {
    it('contains all required question IDs', () => {
        const ids = CREATION_QUESTIONS.map(q => q.id);
        expect(ids).toContain('name');
        expect(ids).toContain('concept');
        expect(ids).toContain('playstyle');
        expect(ids).toContain('voice');
        expect(ids).toContain('drives');
        expect(ids).toContain('archetype');
    });

    it('archetype question lists all five archetypes', () => {
        const archQ = CREATION_QUESTIONS.find(q => q.id === 'archetype')!;
        expect(archQ.options).toEqual(['bulwark', 'assassin', 'caster', 'skirmisher', 'brute']);
    });

    it('name and archetype are required', () => {
        const nameQ = CREATION_QUESTIONS.find(q => q.id === 'name')!;
        const archQ = CREATION_QUESTIONS.find(q => q.id === 'archetype')!;
        expect(nameQ.required).toBe(true);
        expect(archQ.required).toBe(true);
    });
});

describe('Point-buy merge rule (engine stats override LLM)', () => {
    it('engine point-buy allocation is the authoritative stat source regardless of LLM output', () => {
        const engineStats: StatBlock = { VIT: 15, PWR: 10, RES: 14, FOC: 8, SPD: 8, WIL: 10 };
        const llmStats: StatBlock = { VIT: 12, PWR: 18, RES: 10, FOC: 14, SPD: 16, WIL: 12 };
        const merged = { ...llmStats, ...engineStats };
        expect(merged.VIT).toBe(15);
        expect(merged.PWR).toBe(10);
        expect(merged.RES).toBe(14);
        expect(merged.FOC).toBe(8);
        expect(merged.SPD).toBe(8);
        expect(merged.WIL).toBe(10);
    });

    it('OP combatTier override takes precedence over LLM tier', () => {
        const engineTier = getPCTier(true);
        expect(engineTier).toBe('elite');
    });
});

describe('STAT_KEYS', () => {
    it('contains exactly the six combat stats', () => {
        expect(STAT_KEYS).toEqual(['VIT', 'PWR', 'RES', 'FOC', 'SPD', 'WIL']);
    });
});

describe('Default allocation consistency', () => {
    it('all-8s allocation is valid and costs zero', () => {
        const result = validateAllocation(DEFAULT_STATS, 'NORMAL');
        expect(result.isValid).toBe(true);
        expect(result.pointsSpent).toBe(0);
    });

    it('all-8s allocation is valid for OP too', () => {
        const result = validateAllocation(DEFAULT_STATS, 'OP');
        expect(result.isValid).toBe(true);
        expect(result.pointsSpent).toBe(0);
        expect(result.pointsRemaining).toBe(37);
    });
});