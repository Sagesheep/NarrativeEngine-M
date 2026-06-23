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