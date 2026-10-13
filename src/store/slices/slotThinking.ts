import type { AIPreset, AppSettings, LLMProvider, SlotThinking, ThinkingSlot } from '../../types';

// ── Per-slot thinking (port of mainApp's slotThinking.ts, PR #47) ────────
//
// Thinking used to live on the provider, so one provider serving the story slot
// and the utility slot had to think the same amount for both. It now lives on
// the preset slot (`AIPreset.slotThinking`); the provider is just the
// connection. The role getters hand callers a copy of the provider whose
// `thinkingEffort` is the slot's level, so `buildChatBody` / `llmCall` keep
// reading `provider.thinkingEffort` unchanged.
//
// Precedence: per-call `thinkingEffort` > slot level > provider's legacy value.
// 'default' sends nothing, so the model decides.

export const THINKING_SLOTS: readonly ThinkingSlot[] = ['story', 'summarizer', 'utility', 'auxiliary'];

export const SLOT_THINKING_CHOICES: readonly { value: SlotThinking; label: string }[] = [
    { value: 'default', label: 'Model default' },
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
];

/** Levels seeded on a preset without any: the story keeps the model's own default, helpers run without thinking. */
export const DEFAULT_SLOT_THINKING: Readonly<Record<ThinkingSlot, SlotThinking>> = {
    story: 'default', summarizer: 'off', utility: 'off', auxiliary: 'off',
};

// Copies are cached per stored provider object, so a getter returns the same
// reference until the provider (or the slot's level) changes. Zustand selectors
// over a getter depend on that: a fresh object on every call re-renders forever.
const slotCopies = new WeakMap<object, Map<SlotThinking, LLMProvider>>();

/**
 * Returns `provider` as it should be used for `slot`'s job: a copy carrying the
 * slot's thinking level, or the provider itself when the slot has no level.
 * Never mutates the stored provider.
 */
export function applySlotThinking<T extends LLMProvider | undefined>(
    provider: T,
    preset: AIPreset | undefined,
    slot: ThinkingSlot,
): T {
    if (!provider) return provider;
    const level = preset?.slotThinking?.[slot];
    if (!level) return provider;
    let byLevel = slotCopies.get(provider);
    if (!byLevel) {
        byLevel = new Map();
        slotCopies.set(provider, byLevel);
    }
    let copy = byLevel.get(level);
    if (!copy) {
        copy = { ...provider, thinkingEffort: level === 'default' ? undefined : level };
        byLevel.set(level, copy);
    }
    return copy as T;
}

/** `applySlotThinking` against the active preset of a settings snapshot. */
export function applyActiveSlotThinking<T extends LLMProvider | undefined>(
    settings: AppSettings | undefined,
    slot: ThinkingSlot,
    provider: T,
): T {
    const preset = settings?.presets?.find(p => p.id === settings.activePresetId) ?? settings?.presets?.[0];
    return applySlotThinking(provider, preset, slot);
}

/**
 * Seeds `slotThinking` on presets that predate it; never overwrites a level
 * already set. The story slot takes the story provider's legacy level, or
 * 'default' when it had none (it sent nothing, which is what 'default' does).
 * Every other slot gets 'off'. Returns the same preset when nothing changed.
 */
export function migratePresetSlotThinking(preset: AIPreset, providers: readonly LLMProvider[]): AIPreset {
    const current = preset.slotThinking ?? {};
    const next: Partial<Record<ThinkingSlot, SlotThinking>> = { ...current };
    let changed = false;
    for (const slot of THINKING_SLOTS) {
        if (current[slot]) continue;
        next[slot] = slot === 'story'
            ? providers.find(p => p.id === preset.storyAIProviderId)?.thinkingEffort ?? DEFAULT_SLOT_THINKING.story
            : DEFAULT_SLOT_THINKING[slot];
        changed = true;
    }
    return changed ? { ...preset, slotThinking: next } : preset;
}
