import type { AppSettings, AIPreset, LLMProvider, ApiFormat } from '../types';
import { uid } from '../utils/uid';

export const defaultProvider: LLMProvider = {
    id: uid(),
    label: 'Default',
    endpoint: 'http://localhost:11434/v1',
    apiKey: '',
    modelName: 'llama3',
    apiFormat: 'openai',
    streamingEnabled: true,
};

export const defaultPreset: AIPreset = {
    id: uid(),
    name: 'Default Setting',
    storyAIProviderId: defaultProvider.id,
    summarizerAIProviderId: defaultProvider.id,
    utilityAIProviderId: '',
    auxiliaryAIProviderId: '',
};

export const defaultSettings: AppSettings = {
    presets: [defaultPreset],
    activePresetId: defaultPreset.id,
    providers: [defaultProvider],
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
    matureMode: false,
    ttsEnabled: false,
    ttsRate: 1,
};

function normalizeProviderConfig(config: any): LLMProvider | null {
    if (!config || typeof config !== 'object') return null;
    const endpoint = (config.endpoint ?? '').trim();
    if (!endpoint) return null;
    return {
        id: config.id || uid(),
        label: config.label || (config.modelName || 'Provider'),
        endpoint,
        apiKey: config.apiKey ?? '',
        modelName: (config.modelName ?? '').trim() || 'model',
        streamingEnabled: config.streamingEnabled ?? true,
        apiFormat: config.apiFormat || 'openai',
        thinkingEffort: config.thinkingEffort,
    };
}

function providerKey(p: LLMProvider): string {
    return `${p.endpoint}|${p.modelName}|${p.apiKey}|${p.apiFormat || 'openai'}`;
}

export function migrateSettings(data: Record<string, unknown>): AppSettings {
    const raw = (data.settings || {}) as Record<string, unknown>;

    const providers: LLMProvider[] = [];
    const providerIdMap = new Map<string, string>();

    function getOrAddProvider(config: any): string {
        if (!config || typeof config !== 'object') return '';
        const endpoint = (config.endpoint ?? '').trim();
        if (!endpoint) return '';

        const normalized = normalizeProviderConfig(config)!;
        const key = providerKey(normalized);
        const existingId = providerIdMap.get(key);
        if (existingId) return existingId;

        const provider: LLMProvider = {
            ...normalized,
            id: config.id || uid(),
        };
        providers.push(provider);
        providerIdMap.set(key, provider.id);
        return provider.id;
    }

    function getOrAddProvidersFromRawList(rawProviders: any[]): void {
        for (const p of rawProviders) {
            if (!p || typeof p !== 'object') continue;
            const endpoint = (p.endpoint ?? '').trim();
            if (!endpoint) continue;
            const normalized = normalizeProviderConfig(p)!;
            const key = providerKey(normalized);
            if (providerIdMap.has(key)) continue;
            const provider: LLMProvider = { ...normalized, id: p.id || uid() };
            providers.push(provider);
            providerIdMap.set(key, provider.id);
        }
    }

    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
        getOrAddProvidersFromRawList(raw.providers as any[]);
    }

    let presets: AIPreset[];

    if (Array.isArray(raw.presets) && (raw.presets as any[]).length > 0) {
        presets = (raw.presets as any[]).map((p: any) => {
            const { enemyAI: _e, neutralAI: _n, allyAI: _a, ...rest } = p;

            let storyAIProviderId = p.storyAIProviderId || getOrAddProvider(p.storyAI);
            if (!storyAIProviderId && providers.length > 0) storyAIProviderId = providers[0].id;

            const summarizerAIProviderId = p.summarizerAIProviderId || getOrAddProvider(p.summarizerAI) || '';
            const utilityAIProviderId = p.utilityAIProviderId || getOrAddProvider(p.utilityAI) || '';
            const auxiliaryAIProviderId = p.auxiliaryAIProviderId || getOrAddProvider(p.auxiliaryAI) || '';
            const imageAIProviderId = p.imageAIProviderId || getOrAddProvider(p.imageAI) || '';

            const { storyAI: _s, summarizerAI: _sm, utilityAI: _u, auxiliaryAI: _ax, imageAI: _img, ...presetRest } = rest;
            return {
                ...presetRest,
                storyAIProviderId,
                summarizerAIProviderId,
                utilityAIProviderId,
                auxiliaryAIProviderId,
                imageAIProviderId,
            } as AIPreset;
        });
    } else {
        let storyProvider: LLMProvider;
        if (Array.isArray(raw.providers) && (raw.providers as any[]).length > 0) {
            const oldActive = (raw.providers as any[]).find((p: any) => p.id === raw.activeProviderId) || (raw.providers as any[])[0];
            storyProvider = normalizeProviderConfig(oldActive) || { ...defaultProvider, id: uid() };
        } else {
            storyProvider = {
                id: uid(),
                label: 'Default',
                endpoint: (raw.endpoint as string) || defaultProvider.endpoint,
                apiKey: (raw.apiKey as string) || '',
                modelName: (raw.modelName as string) || defaultProvider.modelName,
                apiFormat: (raw.apiFormat as ApiFormat) || 'openai',
                streamingEnabled: true,
            };
        }

        const key = providerKey(storyProvider);
        let providerId = providerIdMap.get(key);
        if (!providerId) {
            providers.push(storyProvider);
            providerIdMap.set(key, storyProvider.id);
            providerId = storyProvider.id;
        }

        const migratedPresetId = uid();
        presets = [{
            id: migratedPresetId,
            name: 'Default Preset',
            storyAIProviderId: providerId,
            summarizerAIProviderId: providerId,
            utilityAIProviderId: '',
            auxiliaryAIProviderId: '',
        }];
    }

    if (providers.length === 0) {
        const fallback: LLMProvider = { ...defaultProvider, id: uid() };
        providers.push(fallback);
    }

    if (presets.length === 0) {
        presets = [{ ...defaultPreset, id: uid(), storyAIProviderId: providers[0].id, summarizerAIProviderId: providers[0].id }];
    }

    for (const preset of presets) {
        if (!preset.storyAIProviderId && providers.length > 0) {
            preset.storyAIProviderId = providers[0].id;
        }
    }

    return {
        presets,
        activePresetId: (raw.activePresetId as string) || presets[0].id,
        providers,
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
        autoArchiveStaleNPCsTurns: (raw.autoArchiveStaleNPCsTurns as number) ?? 15,
        rulesBudgetPct: (raw.rulesBudgetPct as number) ?? 0.10,
        autoGenerateRuleKeywords: (raw.autoGenerateRuleKeywords as boolean) ?? true,
        embeddingModel: (raw.embeddingModel as 'standard' | 'high') ?? 'standard',
        utilityTimeoutSeconds: (raw.utilityTimeoutSeconds as number) ?? 45,
        verboseUtilityLogging: (raw.verboseUtilityLogging as boolean) ?? false,
        aiTier: (raw.aiTier as AppSettings['aiTier']) ?? 'pro',
        matureMode: (raw.matureMode as boolean) ?? false,
        imageStylePrompt: (raw.imageStylePrompt as string) ?? '',
        imageNegativePrompt: (raw.imageNegativePrompt as string) ?? '',
        imageTagRewriteEnabled: (raw.imageTagRewriteEnabled as boolean) ?? false,
        ttsEnabled: (raw.ttsEnabled as boolean) ?? false,
        ttsRate: (raw.ttsRate as number) ?? 1,
    };
}

