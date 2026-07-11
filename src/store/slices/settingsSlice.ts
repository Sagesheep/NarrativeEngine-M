import type { StateCreator } from 'zustand';
import type { AppSettings, LLMProvider, AIPreset } from '../../types';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { encryptSettingsProviders, decryptSettingsProviders, decryptSettingsPresets } from '../../services/infrastructure';
import { notify } from '../../services/ports/notify';
import {
    applyTheme,
    watchSystemTheme,
    applyUIScale
} from '../../services/infrastructure/themeService';
import {
    defaultSettings,
    migrateSettings
} from '../settingsMigration';


export {
    DEFAULT_SURPRISE_TYPES,
    DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES,
    DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO,
    DEFAULT_WORLD_WHERE,
    DEFAULT_WORLD_WHY,
    DEFAULT_WORLD_WHAT,
} from '../../services/engine/engineDefaults';

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveSettings(settings: AppSettings, activeCampaignId: string | null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const encryptedProviders = await encryptSettingsProviders(settings.providers);
        const encryptedSettings = { ...settings, providers: encryptedProviders };

        idbSet('nn_settings', { settings: encryptedSettings, activeCampaignId })
            .catch((e) => { console.error(e); notify.error('Failed to save settings to browser storage'); });
    }, 500);
}

export type SettingsSlice = {
    settings: AppSettings;
    settingsLoaded: boolean;
    updateSettings: (patch: Partial<AppSettings>) => void;
    loadSettings: () => Promise<void>;

    addPreset: (preset: AIPreset) => void;
    updatePreset: (id: string, patch: Partial<AIPreset>) => void;
    removePreset: (id: string) => void;
    setActivePreset: (id: string) => void;
    getActivePreset: () => AIPreset | undefined;
    getActiveStoryEndpoint: () => LLMProvider | undefined;
    getActiveSummarizerEndpoint: () => LLMProvider | undefined;
    getActiveUtilityEndpoint: () => LLMProvider | undefined;
    getActiveAuxiliaryEndpoint: () => LLMProvider | undefined;
    getActiveImageEndpoint: () => LLMProvider | undefined;

    addProvider: (provider: LLMProvider) => void;
    updateProvider: (id: string, patch: Partial<LLMProvider>) => void;
    removeProvider: (id: string) => void;
};

export const createSettingsSlice: StateCreator<SettingsSlice & { activeCampaignId: string | null }, [], [], SettingsSlice> = (set, get) => ({
    settings: { ...defaultSettings },
    settingsLoaded: false,

    loadSettings: async () => {
        try {
            const localSettings = await idbGet('nn_settings');
            if (localSettings && localSettings.settings) {
                const raw = localSettings as any;

                const presetsPlain = await decryptSettingsPresets(raw.settings?.presets ?? []);
                const providersPlain = await decryptSettingsProviders(raw.settings?.providers ?? []);

                const migrated = migrateSettings({
                    settings: {
                        ...(raw.settings || {}),
                        presets: presetsPlain,
                        providers: providersPlain,
                    },
                });

                // migrateSettings already returns a complete AppSettings — spread it
                // wholesale so newly-added fields (e.g. imageStylePrompt) are never
                // silently dropped on reload.
                set({
                    settings: {
                        ...migrated,
                        theme: migrated.theme ?? 'system',
                        uiScale: migrated.uiScale ?? 1.0,
                        debugMode: migrated.debugMode ?? false,
                        showReasoning: migrated.showReasoning ?? true,
                        ttsEnabled: migrated.ttsEnabled ?? false,
                        ttsRate: migrated.ttsRate ?? 1,
                    },
                    settingsLoaded: true,
                });

                applyTheme(migrated.theme ?? 'system');
                watchSystemTheme();
                applyUIScale(migrated.uiScale ?? 1.0);
                return;
            }
        } catch (e) {
            console.warn('Failed to load settings, using defaults', e);
            notify.warning('Could not load saved settings — using defaults');
        }
        set({ settingsLoaded: true });
    },

    updateSettings: (patch) => {
        set((s) => {
            const updated = { ...s.settings, ...patch };
            debouncedSaveSettings(updated, s.activeCampaignId);

            if (patch.theme !== undefined) applyTheme(patch.theme);
            if (patch.uiScale !== undefined) applyUIScale(patch.uiScale);

            return { settings: updated };
        });
    },

    addPreset: (preset) => {
        set((s) => {
            const newSettings = {
                ...s.settings,
                presets: [...s.settings.presets, preset],
            };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    updatePreset: (id, patch) => {
        set((s) => {
            const newPresets = s.settings.presets.map((p) =>
                p.id === id ? { ...p, ...patch } : p
            );
            const newSettings = { ...s.settings, presets: newPresets };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    removePreset: (id) => {
        set((s) => {
            const newPresets = s.settings.presets.filter((p) => p.id !== id);
            if (newPresets.length === 0) return {};
            const newActiveId = s.settings.activePresetId === id
                ? newPresets[0].id
                : s.settings.activePresetId;
            const newSettings = { ...s.settings, presets: newPresets, activePresetId: newActiveId };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    setActivePreset: (id) => {
        set((s) => {
            const newSettings = { ...s.settings, activePresetId: id };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    getActivePreset: () => {
        const s = get();
        return s.settings.presets.find((p) => p.id === s.settings.activePresetId) || s.settings.presets[0];
    },

    getActiveStoryEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset) return undefined;
        return s.settings.providers.find(p => p.id === preset.storyAIProviderId);
    },

    getActiveSummarizerEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset) return undefined;
        if (!preset.summarizerAIProviderId) return undefined;
        return s.settings.providers.find(p => p.id === preset.summarizerAIProviderId);
    },

    getActiveUtilityEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset) return undefined;
        if (!preset.utilityAIProviderId) return undefined;
        return s.settings.providers.find(p => p.id === preset.utilityAIProviderId);
    },

    getActiveAuxiliaryEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset) return undefined;
        if (!preset.auxiliaryAIProviderId) return undefined;
        return s.settings.providers.find(p => p.id === preset.auxiliaryAIProviderId);
    },

    getActiveImageEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset) return undefined;
        if (!preset.imageAIProviderId) return undefined;
        return s.settings.providers.find(p => p.id === preset.imageAIProviderId);
    },

    addProvider: (provider) => {
        set((s) => {
            const newSettings = {
                ...s.settings,
                providers: [...s.settings.providers, provider],
            };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    updateProvider: (id, patch) => {
        set((s) => {
            const newProviders = s.settings.providers.map((p) =>
                p.id === id ? { ...p, ...patch } : p
            );
            const newSettings = { ...s.settings, providers: newProviders };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    removeProvider: (id) => {
        set((s) => {
            if (s.settings.providers.length <= 1) return {};
            const newProviders = s.settings.providers.filter(p => p.id !== id);
            if (newProviders.length === 0) return {};
            const firstProviderId = newProviders[0].id;
            const newPresets = s.settings.presets.map(preset => {
                const updated = { ...preset };
                if (updated.storyAIProviderId === id) {
                    updated.storyAIProviderId = firstProviderId;
                }
                if (updated.summarizerAIProviderId === id) {
                    updated.summarizerAIProviderId = '';
                }
                if (updated.utilityAIProviderId === id) {
                    updated.utilityAIProviderId = '';
                }
                if (updated.auxiliaryAIProviderId === id) {
                    updated.auxiliaryAIProviderId = '';
                }
                if (updated.imageAIProviderId === id) {
                    updated.imageAIProviderId = '';
                }
                return updated;
            });
            const newSettings = { ...s.settings, providers: newProviders, presets: newPresets };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },
});

export { resolveTheme } from '../../services/infrastructure/themeService';
export { migrateSettings, defaultSettings } from '../settingsMigration';