import { describe, it, expect } from 'vitest';
import { buildStablePreamble } from '../payloadStableContent';
import type { AppSettings, PayloadTrace } from '../../../types';

const baseSettings: AppSettings = {
    presets: [{ id: 'p1', name: 'Test', storyAIProviderId: 'prov1' }],
    activePresetId: 'p1',
    contextLimit: 8192,
    autoCondenseEnabled: false,
    providers: [{ id: 'prov1', label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'gpt-4' }],
};

const noTrace = (_t: PayloadTrace) => {};

describe('buildStablePreamble — NPC knowledge boundary', () => {
    it('output contains [NPC KNOWLEDGE BOUNDARY]', () => {
        const result = buildStablePreamble({
            settings: baseSettings,
            context: { rulesRaw: 'Some rules text', starterActive: false, continuePromptActive: false, diceFairnessActive: true },
            budgetMap: { stable: 2000, summary: 800, world: 4000, rules: 2000, volatile: 1000, npc: 400 },
            addTrace: noTrace,
        });
        expect(result.stableContent).toContain('[NPC KNOWLEDGE BOUNDARY]');
        expect(result.stableContent).toContain('[END NPC KNOWLEDGE BOUNDARY]');
    });
});

describe('buildStablePreamble — SCENE_STAKES rubric', () => {
    it('output contains SCENE_STAKES rubric', () => {
        const result = buildStablePreamble({
            settings: baseSettings,
            context: { rulesRaw: 'Some rules text', starterActive: false, continuePromptActive: false, diceFairnessActive: true },
            budgetMap: { stable: 2000, summary: 800, world: 4000, rules: 2000, volatile: 1000, npc: 400 },
            addTrace: noTrace,
        });
        expect(result.stableContent).toContain('[[SCENE_STAKES:');
        expect(result.stableContent).toContain('calm|tense|dangerous');
    });
});

describe('buildStablePreamble — Action Resolution preservation', () => {
    const customRules = '### Action Resolution\n\nRoll 2d6. 7 is mixed, 12 is crit, 2 is fumble.';

    it('tool-mode (diceFairnessActive false) preserves user Action Resolution rules — no swap', () => {
        const result = buildStablePreamble({
            settings: baseSettings,
            context: { rulesRaw: customRules, starterActive: false, continuePromptActive: false, diceFairnessActive: false },
            budgetMap: { stable: 2000, summary: 800, world: 4000, rules: 2000, volatile: 1000, npc: 400 },
            addTrace: noTrace,
        });
        expect(result.stableContent).toContain('Roll 2d6');
        expect(result.stableContent).toContain('7 is mixed');
        // Must NOT contain the old hardcoded tool-mode template text
        expect(result.stableContent).not.toContain('CALL the `roll_dice` tool BEFORE narrating');
    });

    it('default (pool) mode preserves user Action Resolution rules too', () => {
        const result = buildStablePreamble({
            settings: baseSettings,
            context: { rulesRaw: customRules, starterActive: false, continuePromptActive: false, diceFairnessActive: true },
            budgetMap: { stable: 2000, summary: 800, world: 4000, rules: 2000, volatile: 1000, npc: 400 },
            addTrace: noTrace,
        });
        expect(result.stableContent).toContain('Roll 2d6');
        expect(result.stableContent).toContain('7 is mixed');
        expect(result.stableContent).not.toContain('CALL the `roll_dice` tool BEFORE narrating');
    });
});