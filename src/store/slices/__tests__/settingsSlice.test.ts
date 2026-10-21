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
    it('has at least one provider', () => {
        expect(defaultSettings.providers.length).toBeGreaterThan(0);
    });
    it('preset references a provider', () => {
        const preset = defaultSettings.presets[0];
        expect(defaultSettings.providers.find(p => p.id === preset.storyAIProviderId)).toBeDefined();
    });
});

describe('migrateSettings', () => {
    it('preserves custom AI timeouts and supplies defaults for older settings', () => {
        expect(migrateSettings({ settings: {} })).toMatchObject({ storyTimeoutSeconds: 120, utilityTimeoutSeconds: 45 });
        expect(migrateSettings({ settings: { storyTimeoutSeconds: 1200, utilityTimeoutSeconds: 900 } }))
            .toMatchObject({ storyTimeoutSeconds: 1200, utilityTimeoutSeconds: 900 });
    });

    it('normalizes invalid or out-of-range saved timeout values', () => {
        expect(migrateSettings({ settings: { storyTimeoutSeconds: Number.NaN, utilityTimeoutSeconds: -1 } }))
            .toMatchObject({ storyTimeoutSeconds: 120, utilityTimeoutSeconds: 10 });
        expect(migrateSettings({ settings: { storyTimeoutSeconds: 99999, utilityTimeoutSeconds: '600' } }))
            .toMatchObject({ storyTimeoutSeconds: 3600, utilityTimeoutSeconds: 45 });
    });

    it('passes through already-migrated settings with providers', () => {
        const providerId = 'prov-1';
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAIProviderId: providerId }],
                providers: [{ id: providerId, label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' }],
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
        expect(result.presets[0].storyAIProviderId).toBe(providerId);
        expect(result.providers).toHaveLength(1);
        expect(result.contextLimit).toBe(8192);
        expect(result.theme).toBe('dark');
    });

    it('migrates legacy inline-config presets to id-based presets with providers', () => {
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm', apiFormat: 'openai' }, summarizerAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm', apiFormat: 'openai' } }],
                activePresetId: 'p1',
                contextLimit: 4096,
            },
        };
        const result = migrateSettings(existing);
        expect(result.presets).toHaveLength(1);
        expect(result.presets[0].storyAIProviderId).toBeTruthy();
        expect(result.presets[0].summarizerAIProviderId).toBeTruthy();
        expect(result.presets[0].storyAI).toBeUndefined();
        expect(result.presets[0].summarizerAI).toBeUndefined();
        expect(result.providers).toHaveLength(1);
    });

    it('deduplicates identical role configs into a single provider', () => {
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' }, summarizerAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' } }],
                activePresetId: 'p1',
            },
        };
        const result = migrateSettings(existing);
        expect(result.providers).toHaveLength(1);
        expect(result.presets[0].storyAIProviderId).toBe(result.presets[0].summarizerAIProviderId);
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
        expect(result.providers).toHaveLength(1);
        expect(result.providers[0].endpoint).toBe('http://localhost:11434/v1');
        expect(result.providers[0].apiKey).toBe('test-key');
        expect(result.providers[0].modelName).toBe('llama3');
        expect(result.presets[0].storyAIProviderId).toBe(result.providers[0].id);
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
        expect(result.providers).toHaveLength(1);
        expect(result.providers[0].endpoint).toBe('http://old-endpoint');
        expect(result.contextLimit).toBe(16384);
    });

    it('uses defaults for missing fields', () => {
        const partial: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'x', name: 'P', storyAIProviderId: '' }],
                providers: [{ id: 'prov-x', label: 'P', endpoint: 'http://e', apiKey: '', modelName: 'm' }],
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
        expect(result.providers).toHaveLength(1);
        expect(result.contextLimit).toBe(4096);
    });

    it('aiTier defaults to pro on already-migrated settings without aiTier', () => {
        const providerId = 'prov-1';
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAIProviderId: providerId }],
                providers: [{ id: providerId, label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' }],
                activePresetId: 'p1',
            },
        };
        const result = migrateSettings(existing);
        expect(result.aiTier).toBe('pro');
    });

    it('preserves explicit aiTier through migration', () => {
        const providerId = 'prov-1';
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{ id: 'p1', name: 'Test', storyAIProviderId: providerId }],
                providers: [{ id: providerId, label: 'Test', endpoint: 'http://test', apiKey: 'k', modelName: 'm' }],
                activePresetId: 'p1',
                aiTier: 'lite',
            },
        };
        const result = migrateSettings(existing);
        expect(result.aiTier).toBe('lite');
    });

    it('strips legacy inline providers from presets', () => {
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{
                    id: 'p1',
                    name: 'Test',
                    storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' },
                    summarizerAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' },
                    utilityAI: { endpoint: '', apiKey: '', modelName: '' },
                    auxiliaryAI: { endpoint: '', apiKey: '', modelName: '' },
                }],
                activePresetId: 'p1',
            },
        };
        const result = migrateSettings(existing);
        expect(result.presets[0].storyAI).toBeUndefined();
        expect(result.presets[0].summarizerAI).toBeUndefined();
        expect(result.presets[0].utilityAI).toBeUndefined();
        expect(result.presets[0].auxiliaryAI).toBeUndefined();
    });

    it('preserves sampling config through migration', () => {
        const existing: Record<string, unknown> = {
            settings: {
                presets: [{
                    id: 'p1',
                    name: 'Test',
                    storyAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' },
                    summarizerAI: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' },
                    sampling: { temperature: 0.7, top_p: 0.9 },
                }],
                activePresetId: 'p1',
            },
        };
        const result = migrateSettings(existing);
        expect(result.presets[0].sampling).toEqual({ temperature: 0.7, top_p: 0.9 });
    });
});

describe('defaultSettings aiTier', () => {
    it('defaults to pro', () => {
        expect(defaultSettings.aiTier).toBe('pro');
    });
});
