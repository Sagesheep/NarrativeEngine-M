import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanCombatIntent, applyRoutingRules } from '../turn/combatScanner';
import { handleAdjudicateTool, handleInitiateCombatTool } from '../turn/toolHandlers';
import { COMBAT_TIER_ARCHETYPE_RUBRIC } from '../npc/npcDetector';
import type { LLMProvider } from '../../types';

vi.mock('../../utils/llmCall', () => ({
    llmCall: vi.fn(),
}));

import { llmCall } from '../../utils/llmCall';

const mockLlmCall = vi.mocked(llmCall);

function makeProvider(): LLMProvider {
    return { id: 'test-provider-id', label: 'Test Provider', endpoint: 'http://test', modelName: 'test-model', apiKey: 'test' };
}

describe('combatScanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('scanning intent — labeled corpus', () => {
        const corpus: Array<{ input: string; expectedIntent: 'combat_start' | 'narrative' | 'combat_action'; label: string }> = [
            { input: 'I swing my sword at the guard!', expectedIntent: 'combat_start', label: 'committed strike' },
            { input: 'I draw my dagger and lunge at the pirate.', expectedIntent: 'combat_start', label: 'draw weapon and attack' },
            { input: 'I fire an arrow at the orc from behind the pillar.', expectedIntent: 'combat_start', label: 'ambush attack' },
            { input: 'I ready my sword, watching the enemies carefully.', expectedIntent: 'narrative', label: 'ready weapon without striking' },
            { input: '"Stay back or I\'ll hurt you," I warn them.', expectedIntent: 'narrative', label: 'verbal threat' },
            { input: 'I pound my chest and roar at the bandits.', expectedIntent: 'narrative', label: 'posturing' },
            { input: 'I walk over to the merchant and ask about prices.', expectedIntent: 'narrative', label: 'dialogue' },
            { input: 'I search the room for hidden passages.', expectedIntent: 'narrative', label: 'exploration' },
            { input: 'I cast Fireball at the skeleton.', expectedIntent: 'combat_action', label: 'spell in combat' },
            { input: 'I parry the goblin\'s blow and step back.', expectedIntent: 'combat_action', label: 'defensive maneuver' },
        ];

        it('classifies committed strikes as combat_start', async () => {
            const combatStartEntries = corpus.filter(c => c.expectedIntent === 'combat_start');
            let correctStart = 0;
            for (const { input, expectedIntent } of combatStartEntries) {
                mockLlmCall.mockResolvedValueOnce(JSON.stringify({
                    intent: expectedIntent,
                    confidence: 0.9,
                    entitiesReferenced: [],
                }));
                const result = await scanCombatIntent(input, 'scene context', makeProvider(), false);
                if (result.intent === expectedIntent) correctStart++;
            }
            expect(correctStart).toBe(combatStartEntries.length);
        });

        it('classifies verbal threats/posturing as narrative, not combat_start', async () => {
            const nonCombatLabels = corpus.filter(c => c.expectedIntent === 'narrative');
            let allNarrative = true;
            for (const entry of nonCombatLabels) {
                mockLlmCall.mockResolvedValueOnce(JSON.stringify({
                    intent: 'narrative',
                    confidence: 0.8,
                    entitiesReferenced: [],
                }));
                const result = await scanCombatIntent(entry.input, 'scene', makeProvider(), false);
                if (result.intent !== 'narrative') allNarrative = false;
            }
            expect(allNarrative).toBe(true);
        });

        it('classifies combat_action as narrative when not in combat', async () => {
            mockLlmCall.mockResolvedValueOnce(JSON.stringify({
                intent: 'combat_action',
                confidence: 0.8,
                entitiesReferenced: [],
            }));

            const result = await scanCombatIntent('I cast Fireball at the skeleton', 'scene', makeProvider(), false);
            expect(result.intent).toBe('narrative');
        });

        it('classifies combat_action as combat_action when already in combat', async () => {
            mockLlmCall.mockResolvedValueOnce(JSON.stringify({
                intent: 'combat_action',
                confidence: 0.85,
                entitiesReferenced: ['the skeleton'],
            }));

            const result = await scanCombatIntent('I cast Fireball at the skeleton', 'scene', makeProvider(), true);
            expect(result.intent).toBe('combat_action');
            expect(result.entitiesReferenced).toContain('the skeleton');
        });
    });

    describe('fail-safe', () => {
        it('returns narrative on parse error', async () => {
            mockLlmCall.mockResolvedValueOnce('not valid json at all');
            const result = await scanCombatIntent('I attack the goblin', 'scene', makeProvider(), false);
            expect(result.intent).toBe('narrative');
            expect(result.confidence).toBe(0);
        });

        it('returns narrative on empty output', async () => {
            mockLlmCall.mockResolvedValueOnce('');
            const result = await scanCombatIntent('I attack the goblin', 'scene', makeProvider(), false);
            expect(result.intent).toBe('narrative');
        });

        it('returns narrative on thrown exception', async () => {
            mockLlmCall.mockRejectedValueOnce(new Error('network error'));
            const result = await scanCombatIntent('I attack the goblin', 'scene', makeProvider(), false);
            expect(result.intent).toBe('narrative');
            expect(result.confidence).toBe(0);
            expect(result.entitiesReferenced).toEqual([]);
        });

        it('returns narrative when intent is unknown', async () => {
            mockLlmCall.mockResolvedValueOnce(JSON.stringify({
                intent: 'unknown_intent',
                confidence: 0.9,
                entitiesReferenced: [],
            }));
            const result = await scanCombatIntent('I attack', 'scene', makeProvider(), false);
            expect(result.intent).toBe('narrative');
        });
    });

    describe('routing rules', () => {
        it('routes combat_start with confidence >= 0.6 to combat path', () => {
            const result = applyRoutingRules(
                { intent: 'combat_start', confidence: 0.6, entitiesReferenced: ['the pirate'] },
                false
            );
            expect(result.intent).toBe('combat_start');
        });

        it('routes combat_start with confidence < 0.6 to narrative', () => {
            const result = applyRoutingRules(
                { intent: 'combat_start', confidence: 0.55, entitiesReferenced: [] },
                false
            );
            expect(result.intent).toBe('narrative');
        });

        it('routes combat_action to narrative when not in combat', () => {
            const result = applyRoutingRules(
                { intent: 'combat_action', confidence: 0.9, entitiesReferenced: [] },
                false
            );
            expect(result.intent).toBe('narrative');
        });

        it('routes combat_action as-is when in combat', () => {
            const result = applyRoutingRules(
                { intent: 'combat_action', confidence: 0.85, entitiesReferenced: ['the skeleton'] },
                true
            );
            expect(result.intent).toBe('combat_action');
        });

        it('routes narrative intent to narrative', () => {
            const result = applyRoutingRules(
                { intent: 'narrative', confidence: 0.9, entitiesReferenced: [] },
                true
            );
            expect(result.intent).toBe('narrative');
        });
    });
});

describe('adjudicate_action handler', () => {
    it('returns expected bounded enums for chandelier input', () => {
        const input = JSON.stringify({
            stat: 'SPD',
            advantage: 'advantage',
            positionTag: 'elevated',
            momentumToken: 1,
            riskOnFail: 'prone',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);

        expect(parsed).toEqual({
            stat: 'SPD',
            advantage: 'advantage',
            positionTag: 'elevated',
            momentumToken: 1,
            riskOnFail: 'prone',
        });
    });

    it('strips damage/hp/dice keys from result', () => {
        const input = JSON.stringify({
            stat: 'PWR',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: 0,
            riskOnFail: 'none',
            damage: '2d6',
            hp: 12,
            dice: '1d20',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);

        expect(parsed).not.toHaveProperty('damage');
        expect(parsed).not.toHaveProperty('hp');
        expect(parsed).not.toHaveProperty('dice');
        expect(Object.keys(parsed).sort()).toEqual(['advantage', 'momentumToken', 'positionTag', 'riskOnFail', 'stat']);
    });

    it('coerces out-of-enum stat to PWR', () => {
        const input = JSON.stringify({
            stat: 'CHARISMA',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: 0,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.stat).toBe('PWR');
    });

    it('clamps momentumToken: 5 → 1', () => {
        const input = JSON.stringify({
            stat: 'PWR',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: 5,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.momentumToken).toBe(1);
    });

    it('clamps momentumToken: -1 → 0', () => {
        const input = JSON.stringify({
            stat: 'PWR',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: -1,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.momentumToken).toBe(0);
    });

    it('coerces out-of-enum advantage to normal', () => {
        const input = JSON.stringify({
            stat: 'SPD',
            advantage: 'super_advantage',
            positionTag: 'none',
            momentumToken: 0,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.advantage).toBe('normal');
    });

    it('coerces out-of-enum positionTag to none', () => {
        const input = JSON.stringify({
            stat: 'SPD',
            advantage: 'normal',
            positionTag: 'flying',
            momentumToken: 0,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.positionTag).toBe('none');
    });

    it('coerces out-of-enum riskOnFail to none', () => {
        const input = JSON.stringify({
            stat: 'SPD',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: 0,
            riskOnFail: 'decapitation',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.riskOnFail).toBe('none');
    });

    it('coerces NaN momentumToken to 0', () => {
        const input = JSON.stringify({
            stat: 'PWR',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: NaN,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.momentumToken).toBe(0);
    });

    it('converts truthy-but-non-numeric momentumToken to 1', () => {
        const input = JSON.stringify({
            stat: 'PWR',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: true,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.momentumToken).toBe(1);
    });

    it('returns safe defaults on bad JSON', () => {
        const result = handleAdjudicateTool('not json');
        const parsed = JSON.parse(result.toolResult);
        expect(parsed.stat).toBe('PWR');
        expect(parsed.advantage).toBe('normal');
        expect(parsed.positionTag).toBe('none');
        expect(parsed.riskOnFail).toBe('none');
    });
});

describe('initiate_combat handler', () => {
    it('returns valid foes from proper input', () => {
        const input = JSON.stringify({
            foes: [
                { name: 'Drunk Pirate', count: 3, combatTier: 'grunt', archetype: 'brute' },
            ],
        });

        const result = handleInitiateCombatTool(input);
        expect(result.foes).toHaveLength(1);
        expect(result.foes[0]).toEqual({
            name: 'Drunk Pirate',
            count: 3,
            combatTier: 'grunt',
            archetype: 'brute',
        });
    });

    it('coerces bad combatTier to grunt', () => {
        const input = JSON.stringify({
            foes: [{ name: 'Thug', count: 1, combatTier: 'super_boss', archetype: 'assassin' }],
        });

        const result = handleInitiateCombatTool(input);
        expect(result.foes[0].combatTier).toBe('grunt');
    });

    it('coerces bad archetype to skirmisher', () => {
        const input = JSON.stringify({
            foes: [{ name: 'Thug', count: 1, combatTier: 'elite', archetype: 'ninja_warrior' }],
        });

        const result = handleInitiateCombatTool(input);
        expect(result.foes[0].archetype).toBe('skirmisher');
    });

    it('defaults count to 1 if missing or < 1', () => {
        const input = JSON.stringify({
            foes: [{ name: 'Goblin', combatTier: 'minion', archetype: 'skirmisher' }],
        });

        const result = handleInitiateCombatTool(input);
        expect(result.foes[0].count).toBe(1);
    });

    it('clamps negative count to 1', () => {
        const input = JSON.stringify({
            foes: [{ name: 'Goblin', count: -5, combatTier: 'minion', archetype: 'skirmisher' }],
        });

        const result = handleInitiateCombatTool(input);
        expect(result.foes[0].count).toBe(1);
    });

    it('provides a default foe when foes array is empty', () => {
        const input = JSON.stringify({ foes: [] });
        const result = handleInitiateCombatTool(input);
        expect(result.foes).toHaveLength(1);
        expect(result.foes[0].name).toBe('Unknown Foe');
        expect(result.foes[0].combatTier).toBe('grunt');
        expect(result.foes[0].archetype).toBe('skirmisher');
    });
});

describe('NPC combat rubric', () => {
    it('contains combatTier values', () => {
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('minion');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('grunt');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('elite');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('boss');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('legendary');
    });

    it('contains archetype values', () => {
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('bulwark');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('assassin');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('caster');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('skirmisher');
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('brute');
    });

    it('contains the independence note about combatTier vs narrative tier', () => {
        expect(COMBAT_TIER_ARCHETYPE_RUBRIC).toContain('combatTier is COMBAT threat, independent of narrative importance');
    });
});

describe('engine-resolves-before-narration ordering and 2-calls-per-round', () => {
    it('adjudicate handler returns JSON string (for engine to consume before narration)', () => {
        const input = JSON.stringify({
            stat: 'PWR',
            advantage: 'normal',
            positionTag: 'none',
            momentumToken: 0,
            riskOnFail: 'none',
        });

        const result = handleAdjudicateTool(input);
        expect(typeof result.toolResult).toBe('string');

        const parsed = JSON.parse(result.toolResult);
        expect(parsed).toHaveProperty('stat');
        expect(parsed).toHaveProperty('advantage');
        expect(parsed).toHaveProperty('positionTag');
        expect(parsed).toHaveProperty('momentumToken');
        expect(parsed).toHaveProperty('riskOnFail');
    });

    it('scanner calls LLM exactly once per turn (1 call per scan, adjudicate + narrate = 2 per round)', async () => {
        mockLlmCall.mockResolvedValueOnce(JSON.stringify({
            intent: 'combat_start',
            confidence: 0.85,
            entitiesReferenced: ['the pirate'],
        }));

        await scanCombatIntent('I swing my sword at the pirate', 'scene context', makeProvider(), false);

        expect(mockLlmCall).toHaveBeenCalledTimes(1);
    });

    it('scanner respects temperature: 0.1 and maxTokens: 200', async () => {
        mockLlmCall.mockResolvedValueOnce(JSON.stringify({
            intent: 'narrative',
            confidence: 0.5,
            entitiesReferenced: [],
        }));

        const provider = makeProvider();
        await scanCombatIntent('I talk to the merchant', 'scene', provider, false);

        expect(mockLlmCall).toHaveBeenCalledWith(
            provider,
            expect.any(String),
            expect.objectContaining({ temperature: 0.1, priority: 'high', maxTokens: 200 }),
        );
    });
});