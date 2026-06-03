import type { StateCreator } from 'zustand';
import type { AppSettings, LLMProvider, AIPreset } from '../../types';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { encryptSettingsProviders, decryptSettingsProviders, decryptSettingsPresets } from '../../services/infrastructure';
import { toast } from '../../components/Toast';
import {
    applyTheme,
    watchSystemTheme,
    applyUIScale
} from '../../services/infrastructure/themeService';
import {
    defaultSettings,
    migrateSettings
} from '../settingsMigration';


export const DEFAULT_SURPRISE_TYPES = [
    "STREET_DRAMA", "FOUND_OBJECT", "OVERHEARD_GOSSIP", "ANIMAL_INCIDENT",
    "VENDOR_DISPUTE", "STRANGER_MOMENT", "MINOR_MISHAP", "CROWD_REACTION",
    "WEATHER_SHIFT", "UNEXPECTED_KINDNESS"
];

export const DEFAULT_SURPRISE_TONES = [
    "MUNDANE", "AMUSING", "AWKWARD", "CURIOUS",
    "TENSE", "HEARTWARMING", "CHAOTIC", "BITTERSWEET"
];

export const DEFAULT_ENCOUNTER_TYPES = [
    "HOSTILE_PRESENCE", "TERRITORIAL_THREAT", "PATROL_CONFRONTATION",
    "AMBUSH_LAID", "DESPERATE_ATTACKER", "SCAVENGING_PREDATOR",
    "RIVAL_CLAIM", "CORNERED_ENTITY", "ENVIRONMENTAL_THREAT", "TRAP_TRIGGERED"
];

export const DEFAULT_ENCOUNTER_TONES = [
    "TENSE", "DESPERATE", "SUDDEN", "CALCULATED",
    "CHAOTIC", "PREDATORY", "TERRITORIAL", "GRIM"
];

export const DEFAULT_WORLD_WHO = [
    "a passing merchant", "a frightened local", "a travelling soldier",
    "an inn regular", "a desperate farmer", "a wandering scout",
    "a shady fence", "an old hermit", "a wounded survivor", "a child from the outskirts"
];

export const DEFAULT_WORLD_WHERE = [
    "on the northern road", "near the old ruins", "at the edge of town",
    "along the main trade route", "in the nearby wilderness", "at a river crossing",
    "close to an abandoned structure", "at a well-known crossroads", "in the hills nearby", "at the border outpost"
];

export const DEFAULT_WORLD_WHY = [
    "and a reward is being offered", "and locals are too frightened to investigate",
    "suggesting treasure or valuables are involved", "hinting at danger ahead for travellers",
    "and no one who went to look has returned", "drawing unwanted attention from authorities",
    "and the full story isn't clear yet", "causing unrest among the local population"
];

export const DEFAULT_WORLD_WHAT = [
    "spotted raiders near", "claims something valuable was found at",
    "says a person went missing from", "heard screaming coming from",
    "found fresh tracks leading to", "saw lights moving around",
    "says a body was found near", "reports strange activity at",
    "is paying for an escort to", "overheard a deal being made involving"
];

export const DEFAULT_COMBAT_CONFIG = {
    mookJitterRange: 0.1,
    defaultWeaponDie: 6,
    recoveryBands: {
        healthy: 100,
        wounded: 50,
        critical: 25,
    },
    combatAutoDetect: false,
    autoEnterThreshold: 0.75,
    askThreshold: 0.45,
    confirmOnBorderline: true,
};

export const DEFAULT_STAT_LABEL_MAP = {
    VIT: 'Vitality',
    PWR: 'Power',
    RES: 'Resilience',
    FOC: 'Focus',
    SPD: 'Speed',
    WIL: 'Willpower'
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveSettings(settings: AppSettings, activeCampaignId: string | null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const encryptedProviders = await encryptSettingsProviders(settings.providers);
        const encryptedSettings = { ...settings, providers: encryptedProviders };

        idbSet('nn_settings', { settings: encryptedSettings, activeCampaignId })
            .catch((e) => { console.error(e); toast.error('Failed to save settings to browser storage'); });
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

                set({
                    settings: {
                        presets: migrated.presets,
                        activePresetId: migrated.activePresetId,
                        providers: migrated.providers,
                        contextLimit: migrated.contextLimit,
                        autoCondenseEnabled: migrated.autoCondenseEnabled,
                        condenseAggressiveness: migrated.condenseAggressiveness,
                        enableDeepArchiveSearch: migrated.enableDeepArchiveSearch,
                        autoExtractDivergences: migrated.autoExtractDivergences,
                        divergenceTokenBudget: migrated.divergenceTokenBudget,
                        divergenceScanBudget: migrated.divergenceScanBudget,
                        autoArchiveStaleNPCsTurns: migrated.autoArchiveStaleNPCsTurns,
                        rulesBudgetPct: migrated.rulesBudgetPct,
                        autoGenerateRuleKeywords: migrated.autoGenerateRuleKeywords,
                        embeddingModel: migrated.embeddingModel,
                        utilityTimeoutSeconds: migrated.utilityTimeoutSeconds,
                        verboseUtilityLogging: migrated.verboseUtilityLogging,
                        aiTier: migrated.aiTier,
                        theme: migrated.theme ?? 'system',
                        uiScale: migrated.uiScale ?? 1.0,
                        debugMode: migrated.debugMode ?? false,
                        showReasoning: migrated.showReasoning ?? true,
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
            toast.warning('Could not load saved settings — using defaults');
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
                let updated = { ...preset };
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