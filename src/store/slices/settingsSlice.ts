import type { StateCreator } from 'zustand';
import type { AppSettings, LLMProvider, AIPreset } from '../../types';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { encryptSettingsPresets, decryptSettingsPresets } from '../../services/infrastructure';
import { uid } from '../../utils/uid';
import { toast } from '../../components/Toast';

// ── DEFAULT constants ──────────────────────────────────────────────────

// Surprise Engine — mundane world-flavor events. Genre-agnostic archetypes;
// the GM AI fills in world-appropriate specifics from context.
export const DEFAULT_SURPRISE_TYPES = [
    "STREET_DRAMA", "FOUND_OBJECT", "OVERHEARD_GOSSIP", "ANIMAL_INCIDENT",
    "VENDOR_DISPUTE", "STRANGER_MOMENT", "MINOR_MISHAP", "CROWD_REACTION",
    "WEATHER_SHIFT", "UNEXPECTED_KINDNESS"
];

export const DEFAULT_SURPRISE_TONES = [
    "MUNDANE", "AMUSING", "AWKWARD", "CURIOUS",
    "TENSE", "HEARTWARMING", "CHAOTIC", "BITTERSWEET"
];

// Encounter Engine — threat SITUATIONS, not specific enemies. The GM AI
// resolves what the threat actually is based on the current location.
export const DEFAULT_ENCOUNTER_TYPES = [
    "HOSTILE_PRESENCE", "TERRITORIAL_THREAT", "PATROL_CONFRONTATION",
    "AMBUSH_LAID", "DESPERATE_ATTACKER", "SCAVENGING_PREDATOR",
    "RIVAL_CLAIM", "CORNERED_ENTITY", "ENVIRONMENTAL_THREAT", "TRAP_TRIGGERED"
];

export const DEFAULT_ENCOUNTER_TONES = [
    "TENSE", "DESPERATE", "SUDDEN", "CALCULATED",
    "CHAOTIC", "PREDATORY", "TERRITORIAL", "GRIM"
];

// World Rumour Engine — quest hooks and local hearsay. NOT canon-changing
// world events. WHO heard/spread it, WHAT happened, WHERE locally, WHY it matters.
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

// ── Internal helpers ───────────────────────────────────────────────────

export const defaultPreset: AIPreset = {
    id: uid(),
    name: 'Default Setting',
    storyAI: {
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        modelName: 'llama3',
        apiFormat: 'openai',
    },
    summarizerAI: {
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        modelName: 'llama3',
        apiFormat: 'openai',
    },
    utilityAI: { endpoint: '', apiKey: '', modelName: '' },
    auxiliaryAI: { endpoint: '', apiKey: '', modelName: '' },
};

export const defaultSettings: AppSettings = {
    presets: [defaultPreset],
    activePresetId: defaultPreset.id,
    contextLimit: 4096,
    autoCondenseEnabled: true,
    condenseAggressiveness: 'balanced',
    debugMode: false,
    theme: 'system',
    showReasoning: true,
    uiScale: 1.0,
    enableDeepArchiveSearch: false,
    autoExtractDivergences: true,
    divergenceTokenBudget: 2000,
    autoArchiveStaleNPCsTurns: 15,
    divergenceScanBudget: 0,
    rulesBudgetPct: 0.10,
    autoGenerateRuleKeywords: true,
    embeddingModel: 'standard' as const,
    utilityTimeoutSeconds: 45,
    verboseUtilityLogging: false,
    aiTier: 'pro' as const,
};

export function resolveTheme(theme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
    if (theme !== 'system') return theme;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}

export function applyTheme(theme: 'light' | 'dark' | 'system') {
    activeThemeSetting = theme;
    document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}

let activeThemeSetting: 'light' | 'dark' | 'system' = 'light';
let systemThemeUnsubscribe: (() => void) | null = null;

export function watchSystemTheme() {
    systemThemeUnsubscribe?.();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
        if (activeThemeSetting === 'system') applyTheme('system');
    };
    mq.addEventListener('change', handler);
    systemThemeUnsubscribe = () => mq.removeEventListener('change', handler);
}

/** Migrate old single-provider/multi-provider settings to presets format */
export function migrateSettings(data: Record<string, unknown>): AppSettings {
    const raw = (data.settings || {}) as Record<string, unknown>;

    // Already migrated -- has presets array
    if (Array.isArray(raw.presets) && raw.presets.length > 0) {
        const cleanedPresets = (raw.presets as any[]).map(p => {
            const { enemyAI: _e, neutralAI: _n, allyAI: _a, ...rest } = p;
            return rest as AIPreset;
        });
        return {
            presets: cleanedPresets,
            activePresetId: (raw.activePresetId as string) || cleanedPresets[0].id,
            contextLimit: (raw.contextLimit as number) ?? 4096,
            autoCondenseEnabled: (raw.autoCondenseEnabled as boolean) ?? true,
            condenseAggressiveness: (raw.condenseAggressiveness as AppSettings['condenseAggressiveness']) ?? 'balanced',
            debugMode: (raw.debugMode as boolean) ?? false,
            theme: (raw.theme as 'light' | 'dark' | 'system') ?? 'system',
            showReasoning: (raw.showReasoning as boolean) ?? true,
            uiScale: (raw.uiScale as number) ?? 1.0,
            enableDeepArchiveSearch: (raw.enableDeepArchiveSearch as boolean) ?? false,
            autoExtractDivergences: (raw.autoExtractDivergences as boolean) ?? true,
            divergenceTokenBudget: (raw.divergenceTokenBudget as number) ?? 2000,
            divergenceScanBudget: (raw.divergenceScanBudget as number) ?? 0,
            rulesBudgetPct: (raw.rulesBudgetPct as number) ?? 0.10,
            autoGenerateRuleKeywords: (raw.autoGenerateRuleKeywords as boolean) ?? true,
            embeddingModel: (raw.embeddingModel as 'standard' | 'high') ?? 'standard',
            utilityTimeoutSeconds: (raw.utilityTimeoutSeconds as number) ?? 45,
            verboseUtilityLogging: (raw.verboseUtilityLogging as boolean) ?? false,
            aiTier: (raw.aiTier as AppSettings['aiTier']) ?? 'pro',
        };
    }

    // Migration from old provider structure
    let migratedStoryProvider: LLMProvider = { ...defaultPreset.storyAI };

    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
        const oldActive = (raw.providers as LLMProvider[]).find(p => p.id === raw.activeProviderId) || (raw.providers as LLMProvider[])[0];
        migratedStoryProvider = {
            endpoint: oldActive.endpoint || defaultPreset.storyAI.endpoint,
            apiKey: oldActive.apiKey || '',
            modelName: oldActive.modelName || defaultPreset.storyAI.modelName,
            apiFormat: oldActive.apiFormat || 'openai',
        };
    } else {
        migratedStoryProvider = {
            endpoint: (raw.endpoint as string) || defaultPreset.storyAI.endpoint,
            apiKey: (raw.apiKey as string) || '',
            modelName: (raw.modelName as string) || defaultPreset.storyAI.modelName,
            apiFormat: (raw.apiFormat as 'openai' | 'ollama') || 'openai',
        };
    }

    const legacyId = uid();
    const migratedPreset: AIPreset = {
        id: legacyId,
        name: 'Default Preset',
        storyAI: migratedStoryProvider,
        summarizerAI: { ...migratedStoryProvider },
        utilityAI: { endpoint: '', apiKey: '', modelName: '' },
        auxiliaryAI: { endpoint: '', apiKey: '', modelName: '' },
    };

    return {
        presets: [migratedPreset],
        activePresetId: legacyId,
        contextLimit: (raw.contextLimit as number) ?? 4096,
        autoCondenseEnabled: (raw.autoCondenseEnabled as boolean) ?? true,
        condenseAggressiveness: (raw.condenseAggressiveness as AppSettings['condenseAggressiveness']) ?? 'balanced',
        debugMode: (raw.debugMode as boolean) ?? false,
        theme: (raw.theme as 'light' | 'dark' | 'system') ?? 'system',
        showReasoning: (raw.showReasoning as boolean) ?? true,
        enableDeepArchiveSearch: (raw.enableDeepArchiveSearch as boolean) ?? false,
        autoExtractDivergences: (raw.autoExtractDivergences as boolean) ?? true,
        divergenceTokenBudget: (raw.divergenceTokenBudget as number) ?? 2000,
        divergenceScanBudget: (raw.divergenceScanBudget as number) ?? 0,
        rulesBudgetPct: (raw.rulesBudgetPct as number) ?? 0.10,
        autoGenerateRuleKeywords: (raw.autoGenerateRuleKeywords as boolean) ?? true,
        embeddingModel: (raw.embeddingModel as 'standard' | 'high') ?? 'standard',
        utilityTimeoutSeconds: (raw.utilityTimeoutSeconds as number) ?? 45,
        verboseUtilityLogging: (raw.verboseUtilityLogging as boolean) ?? false,
        aiTier: (raw.aiTier as AppSettings['aiTier']) ?? 'pro',
    };
}

// Debounced save to avoid hammering the API on rapid changes
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveSettings(settings: AppSettings, activeCampaignId: string | null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const encryptedPresets = await encryptSettingsPresets(settings.presets);
        const encryptedSettings = { ...settings, presets: encryptedPresets };

        idbSet('nn_settings', { settings: encryptedSettings, activeCampaignId })
            .catch((e) => { console.error(e); toast.error('Failed to save settings to browser storage'); });
    }, 500);
}

// ── Slice type ─────────────────────────────────────────────────────────

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
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createSettingsSlice: StateCreator<SettingsSlice & { activeCampaignId: string | null }, [], [], SettingsSlice> = (set, get) => ({
    settings: { ...defaultSettings },
    settingsLoaded: false,

    loadSettings: async () => {
        try {
            const localSettings = await idbGet('nn_settings');
            if (localSettings && localSettings.settings) {
                const migrated = migrateSettings(localSettings);
                const decryptedPresets = await decryptSettingsPresets(migrated.presets);
                const decrypted = { ...migrated, presets: decryptedPresets };
                set({
                    settings: decrypted,
                    settingsLoaded: true,
                } as Partial<SettingsSlice>);
                applyTheme(decrypted.theme ?? 'system');
                watchSystemTheme();
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
            const newSettings = { ...s.settings, ...patch };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            if (patch.theme) {
                applyTheme(patch.theme);
            }
            if (patch.uiScale !== undefined) {
                const html = document.documentElement;
                html.style.setProperty('--ui-scale', String(patch.uiScale));
                
                const root = document.getElementById('root');
                if (root) {
                    root.style.width = '';
                    root.style.height = '';
                    root.style.transform = '';
                    root.style.transformOrigin = '';
                    root.style.zoom = '';
                }
                html.style.zoom = patch.uiScale !== 1 ? String(patch.uiScale) : '';
            }
            return { settings: newSettings };
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
        const preset = get().getActivePreset();
        return preset?.storyAI;
    },

    getActiveSummarizerEndpoint: () => {
        const preset = get().getActivePreset();
        return preset?.summarizerAI;
    },

    getActiveUtilityEndpoint: () => {
        const preset = get().getActivePreset();
        return preset?.utilityAI;
    },

    getActiveAuxiliaryEndpoint: () => {
        const preset = get().getActivePreset();
        return preset?.auxiliaryAI;
    },
});
