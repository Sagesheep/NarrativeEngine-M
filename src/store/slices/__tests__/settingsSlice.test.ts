import { describe, it, expect } from 'vitest';
import { migrateSettings, resolveTheme, defaultSettings } from '../settingsSlice';

describe('resolveTheme', () => {
    it('returns light for light', () => {
        expect(resolveTheme('light')).toBe('light');
    });
    it('returns dark for dark', () => {
        expect(resolveTheme('dark')).toBe('dark');
    });
    it('returns system preference for system', () => {
        const result = resolveTheme('system');
        expect(result === 'light' || result === 'dark').toBe(true);
    });
});

describe('defaultSettings', () => {
    it('has at least one preset', () => {
        expect(defaultSettings.presets.length).toBeGreaterThan(0);
    });
    it('has contextLimit > 0', () => {
        expect(defaultSettings.contextLimit).toBeGreaterThan(0);
    });
    it('debugMode defaults to false', () => {
        expect(defaultSettings.debugMode).toBe(false);
    });
});

describe('migrateSettings', () => {
    it('passes through already-migrated settings', () => {
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' }, summarizerAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' } }],
                activePresetId: 'p1',
                contextLimit: 8192,
                autoCondenseEnabled: true,
                condenseAggressiveness: 'balanced',
                debugMode: false,
                theme: 'dark',
                showReasoning: true,
                enableDeepArchiveSearch: false,
            },
        };
        const result = migrateSettings(existing);
        expect(result.presets).toHaveLength(1);
        expect(result.presets[0].id).toBe('p1');
        expect(result.contextLimit).toBe(8192);
        expect(result.theme).toBe('dark');
    });

    it('migrates legacy single-provider settings', () => {
        const legacy: Record<string, unknown> = {
            settings: {
                endpoint: 'http://localhost:11434/v1',
                apiKey: 'test-key',
                modelName: 'llama3',
                apiFormat: 'openai',
                contextLimit: 4096,
                theme: 'light',
            },
        };
        const result = migrateSettings(legacy);
        expect(result.presets).toHaveLength(1);
        expect(result.presets[0].storyAI.endpoint).toBe('http://localhost:11434/v1');
        expect(result.presets[0].storyAI.apiKey).toBe('test-key');
        expect(result.presets[0].storyAI.modelName).toBe('llama3');
    });

    it('migrates legacy multi-provider settings', () => {
        const legacy: Record<string, unknown> = {
            settings: {
                providers: [
                    { id: 'old-1', endpoint: 'http://old-endpoint', apiKey: 'old-key', modelName: 'old-model', apiFormat: 'openai' },
                ],
                activeProviderId: 'old-1',
                contextLimit: 16384,
            },
        };
        const result = migrateSettings(legacy);
        expect(result.presets).toHaveLength(1);
        expect(result.presets[0].storyAI.endpoint).toBe('http://old-endpoint');
        expect(result.contextLimit).toBe(16384);
    });

    it('uses defaults for missing fields', () => {
        const partial: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'x', name: 'P', storyAI: { endpoint: '', apiKey: '', modelName: '' }, summarizerAI: { endpoint: '', apiKey: '', modelName: '' } }],
                activePresetId: 'x',
            },
        };
        const result = migrateSettings(partial);
        expect(result.contextLimit).toBe(4096);
        expect(result.autoCondenseEnabled).toBe(true);
        expect(result.condenseAggressiveness).toBe('balanced');
        expect(result.debugMode).toBe(false);
        expect(result.theme).toBe('system');
        expect(result.showReasoning).toBe(true);
    });

    it('handles empty settings object', () => {
        const result = migrateSettings({});
        expect(result.presets).toHaveLength(1);
        expect(result.contextLimit).toBe(4096);
    });

    it('aiTier defaults to pro on already-migrated settings without aiTier', () => {
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' }, summarizerAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' } }],
                activePresetId: 'p1',
            },
        };
        const result = migrateSettings(existing);
        expect(result.aiTier).toBe('pro');
    });

    it('aiTier defaults to pro on legacy migration without aiTier', () => {
        const legacy: Record<string, unknown> = {
            settings: {
                endpoint: 'http://localhost:11434/v1',
                apiKey: '',
                modelName: 'llama3',
            },
        };
        const result = migrateSettings(legacy);
        expect(result.aiTier).toBe('pro');
    });

    it('preserves explicit aiTier through migration', () => {
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' }, summarizerAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' } }],
                activePresetId: 'p1',
                aiTier: 'lite',
            },
        };
        const result = migrateSettings(existing);
        expect(result.aiTier).toBe('lite');
    });
});

describe('defaultSettings aiTier', () => {
    it('defaults to pro', () => {
        expect(defaultSettings.aiTier).toBe('pro');
    });
});