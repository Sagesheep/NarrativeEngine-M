/**
 * @refactor RF-010 (real extraction — W5)
 * @waves W5
 * @see architecture/POSTMORTEM_W4.md
 *
 * Settings lifecycle service — owns load/save logic for app settings.
 *
 * EXTRACTED from settingsSlice.ts. The slice previously contained this logic
 * and imported infrastructure services directly (state→domain violation).
 * Now the slice only holds state; this service does the work.
 */

import type { AppSettings, AIPreset, LLMProvider } from '../types';
import { migrateSettings } from '../utils/settingsMigration';
import { encryptSettingsProviders, decryptSettingsProviders, decryptSettingsPresets } from './infrastructure';
import { applyTheme, watchSystemTheme, applyUIScale } from './infrastructure/themeService';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { notificationPort } from '../ports';

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced save — encrypts providers, writes to idb-keyval. */
export function debouncedSaveSettings(settings: AppSettings, activeCampaignId: string | null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const encryptedProviders = await encryptSettingsProviders(settings.providers);
        const encryptedSettings = { ...settings, providers: encryptedProviders };
        idbSet('nn_settings', { settings: encryptedSettings, activeCampaignId })
            .catch((e: unknown) => {
                console.error(e);
                notificationPort.error('Failed to save settings to browser storage');
            });
    }, 500);
}

/** Load settings from idb-keyval, decrypt, migrate, and apply theme/UI scale. */
export async function loadSettingsFromPersistence(): Promise<{ settings: AppSettings; loaded: true } | { settings: null; loaded: false }> {
    try {
        const localSettings = await idbGet('nn_settings');
        if (localSettings && (localSettings as { settings?: unknown }).settings) {
            const raw = localSettings as { settings?: { presets?: unknown[]; providers?: unknown[]; [k: string]: unknown } };
            const presetsPlain = await decryptSettingsPresets(raw.settings?.presets as AIPreset[] ?? []);
            const providersPlain = await decryptSettingsProviders(raw.settings?.providers as LLMProvider[] ?? []);

            const migrated = migrateSettings({
                settings: {
                    ...(raw.settings || {}),
                    presets: presetsPlain,
                    providers: providersPlain,
                },
            });

            applyTheme(migrated.theme ?? 'system');
            watchSystemTheme();
            applyUIScale(migrated.uiScale ?? 1.0);

            return {
                settings: {
                    ...migrated,
                    theme: migrated.theme ?? 'system',
                    uiScale: migrated.uiScale ?? 1.0,
                    debugMode: migrated.debugMode ?? false,
                    showReasoning: migrated.showReasoning ?? true,
                    ttsEnabled: migrated.ttsEnabled ?? false,
                    ttsRate: migrated.ttsRate ?? 1,
                },
                loaded: true,
            };
        }
    } catch (e) {
        console.warn('Failed to load settings, using defaults', e);
        notificationPort.warning('Could not load saved settings — using defaults');
    }
    return { settings: null, loaded: false };
}

/** Apply theme/UI scale changes from a settings patch. */
export function applySettingsVisuals(patch: Partial<AppSettings>): void {
    if (patch.theme !== undefined) applyTheme(patch.theme);
    if (patch.uiScale !== undefined) applyUIScale(patch.uiScale);
}
