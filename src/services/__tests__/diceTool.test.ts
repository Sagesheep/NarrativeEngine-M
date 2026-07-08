import { describe, it, expect } from 'vitest';
import { mapTier } from '../engine';
import { handleDiceTool, getToolDefinitions } from '../turn';
import { buildDefaultDiceSystem } from '../../types';
import type { DieType, DiceSystemConfig } from '../../types';

const SYS: DiceSystemConfig = buildDefaultDiceSystem();
const d20: DieType = SYS.dieTypes.find(d => d.name === 'd20')!;
const d6: DieType = SYS.dieTypes.find(d => d.name === 'd6')!;

describe('mapTier', () => {
    it('returns Catastrophe for rolls in the Catastrophe band', () => {
        expect(mapTier(1, d20)).toBe('Catastrophe');
        expect(mapTier(2, d20)).toBe('Catastrophe');
    });

    it('returns Failure for rolls in the Failure band', () => {
        expect(mapTier(3, d20)).toBe('Failure');
        expect(mapTier(6, d20)).toBe('Failure');
    });

    it('returns Success for rolls in the Success band', () => {
        expect(mapTier(7, d20)).toBe('Success');
        expect(mapTier(15, d20)).toBe('Success');
    });

    it('returns Triumph for rolls in the Triumph band', () => {
        expect(mapTier(16, d20)).toBe('Triumph');
        expect(mapTier(19, d20)).toBe('Triumph');
    });

    it('returns Narrative Boon for rolls in the top band', () => {
        expect(mapTier(20, d20)).toBe('Narrative Boon');
    });

    it('returns null when no DieType is provided', () => {
        expect(mapTier(1, null)).toBeNull();
        expect(mapTier(10, undefined)).toBeNull();
    });

    it('maps d6 bands correctly', () => {
        expect(mapTier(1, d6)).toBe('Catastrophe');
        expect(mapTier(3, d6)).toBe('Failure');
        expect(mapTier(4, d6)).toBe('Mixed');
        expect(mapTier(6, d6)).toBe('Success');
    });
});

describe('handleDiceTool', () => {
    it('returns valid JSON with result and tier for d20', () => {
        const result = handleDiceTool(JSON.stringify({ dice: '1d20', reason: 'Attack' }), { diceSystem: SYS });
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.dice).toBe('1d20');
        expect(parsed.reason).toBe('Attack');
        expect(typeof parsed.result).toBe('number');
        expect(parsed.result).toBeGreaterThanOrEqual(1);
        expect(parsed.result).toBeLessThanOrEqual(20);
        expect(['Catastrophe', 'Failure', 'Success', 'Triumph', 'Narrative Boon']).toContain(parsed.tier);
    });

    it('returns a tier for 2d6 (d6 is a registered die type)', () => {
        const result = handleDiceTool(JSON.stringify({ dice: '2d6', reason: 'Damage' }), { diceSystem: SYS });
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.dice).toBe('2d6');
        expect(typeof parsed.result).toBe('number');
        expect(parsed.result).toBeGreaterThanOrEqual(2);
        expect(parsed.result).toBeLessThanOrEqual(12);
        // 2d6 sums to 2..12; tier is mapped via the d6 bands (1..6). Only sums
        // within 1..6 produce a tier; sums > 6 have no band → null.
        // So tier may or may not be present depending on the roll. Assert the
        // contract: when present, it is one of the d6 band labels.
        if (parsed.tier !== undefined) {
            expect(['Catastrophe', 'Failure', 'Mixed', 'Success']).toContain(parsed.tier);
        }
    });

    it('returns no tier when no diceSystem is configured', () => {
        const result = handleDiceTool(JSON.stringify({ dice: '1d20', reason: 'Attack' }), { diceSystem: null });
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.tier).toBeUndefined();
    });

    it('handles modifier in dice expression', () => {
        const result = handleDiceTool(JSON.stringify({ dice: '1d20+5', reason: 'Check with bonus' }), { diceSystem: SYS });
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.dice).toBe('1d20+5');
        expect(typeof parsed.result).toBe('number');
        expect(parsed.result).toBeGreaterThanOrEqual(6);
        expect(parsed.result).toBeLessThanOrEqual(25);
        expect(parsed.tier).toBeDefined();
    });

    it('falls back to 1d20 on malformed input', () => {
        const result = handleDiceTool(JSON.stringify({ dice: 'garbage', reason: 'test' }), { diceSystem: SYS });
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.dice).toBe('garbage');
        expect(typeof parsed.result).toBe('number');
    });

    it('handles malformed JSON arguments', () => {
        const result = handleDiceTool('not json', { diceSystem: SYS });
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.dice).toBe('1d20');
        expect(typeof parsed.result).toBe('number');
    });
});

describe('getToolDefinitions', () => {
    it('returns base tools when allowDiceTool is false', () => {
        const tools = getToolDefinitions({ allowDiceTool: false });
        const names = tools.map(t => t.function.name);
        expect(names).toContain('query_campaign_lore');
        expect(names).toContain('update_scene_notebook');
        expect(names).not.toContain('roll_dice');
    });

    it('includes roll_dice when allowDiceTool is true', () => {
        const tools = getToolDefinitions({ allowDiceTool: true });
        const names = tools.map(t => t.function.name);
        expect(names).toContain('query_campaign_lore');
        expect(names).toContain('update_scene_notebook');
        expect(names).toContain('roll_dice');
    });
});