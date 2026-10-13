import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { migrateSettings } from '../../settingsMigration';
import { applyActiveSlotThinking, applySlotThinking, migratePresetSlotThinking } from '../slotThinking';
import { useAppStore } from '../../useAppStore';
import { buildChatBody } from '../../../utils/llmApiHelper';
import { isThinkingEnabled } from '../../../services/payload/payloadStableContent';
import { PresetsPanel } from '../../../components/settings/PresetsPanel';
import type { AIPreset, LLMProvider } from '../../../types';

const flash: LLMProvider = {
    id: 'flash', label: 'DS v4 Flash', endpoint: 'https://api.deepseek.com/v1',
    apiKey: 'k', modelName: 'deepseek-v4-flash', apiFormat: 'openai', thinkingEffort: 'medium',
};

function preset(over: Partial<AIPreset> = {}): AIPreset {
    return {
        id: 'pr', name: 'P',
        storyAIProviderId: 'flash', summarizerAIProviderId: 'flash',
        utilityAIProviderId: 'flash', auxiliaryAIProviderId: 'flash',
        imageAIProviderId: '',
        ...over,
    };
}

const MSGS = [{ role: 'user', content: 'hi' }];

describe('slot thinking — migration', () => {
    it('story slot inherits the story provider level; every other slot starts at off', () => {
        const out = migrateSettings({ settings: { providers: [flash], presets: [preset()], activePresetId: 'pr' } });
        expect(out.presets[0].slotThinking).toEqual({ story: 'medium', summarizer: 'off', utility: 'off', auxiliary: 'off' });
        // The deprecated provider value is kept, not deleted.
        expect(out.providers[0].thinkingEffort).toBe('medium');
    });

    it('a provider with no level gives the story slot Model default (it sent nothing before too)', () => {
        const unset = { ...flash, thinkingEffort: undefined };
        expect(migratePresetSlotThinking(preset(), [unset]).slotThinking?.story).toBe('default');
    });

    it('never overwrites a level already set, and running it again changes nothing', () => {
        const existing = preset({ slotThinking: { story: 'low', utility: 'high' } });
        const once = migratePresetSlotThinking(existing, [flash]);
        expect(once.slotThinking).toEqual({ story: 'low', utility: 'high', summarizer: 'off', auxiliary: 'off' });
        expect(migratePresetSlotThinking(once, [flash])).toBe(once);

        const reloaded = migrateSettings({ settings: { providers: [flash], presets: [once], activePresetId: 'pr' } });
        expect(reloaded.presets[0].slotThinking).toEqual(once.slotThinking);
    });
});

describe('slot thinking — resolution', () => {
    beforeEach(() => {
        const settings = migrateSettings({
            settings: { providers: [flash], presets: [preset({ slotThinking: { story: 'high', utility: 'off', summarizer: 'low', auxiliary: 'default' } })], activePresetId: 'pr' },
        });
        useAppStore.setState({ settings });
    });

    it('one provider in several slots resolves to each slot\'s level without touching the stored provider', () => {
        const s = useAppStore.getState();
        const stored = s.settings.providers[0];
        const before = { ...stored };
        expect(s.getActiveStoryEndpoint()?.thinkingEffort).toBe('high');
        expect(s.getActiveUtilityEndpoint()?.thinkingEffort).toBe('off');
        expect(s.getActiveSummarizerEndpoint()?.thinkingEffort).toBe('low');
        expect(s.getActiveAuxiliaryEndpoint()?.thinkingEffort).toBeUndefined();
        expect(s.getActiveStoryEndpoint()).not.toBe(stored);
        expect(stored).toEqual(before);
    });

    it('returns a stable reference across calls (zustand selectors depend on it)', () => {
        const s = useAppStore.getState();
        expect(s.getActiveStoryEndpoint()).toBe(s.getActiveStoryEndpoint());
    });

    it('a slot with no level falls back to the provider legacy value', () => {
        const p = preset({ slotThinking: {} });
        expect(applySlotThinking(flash, p, 'story')).toBe(flash);
    });

    it('a story fallback doing another slot\'s job takes that slot\'s level', () => {
        const settings = useAppStore.getState().settings;
        const story = useAppStore.getState().getActiveStoryEndpoint();
        expect(applyActiveSlotThinking(settings, 'summarizer', story)?.thinkingEffort).toBe('low');
        expect(applyActiveSlotThinking(settings, 'story', story)?.thinkingEffort).toBe('high');
    });

    it('the writer reasoning framework follows the Story slot, not the provider', () => {
        const settings = useAppStore.getState().settings;
        expect(isThinkingEnabled(settings)).toBe(true);
        const withStory = (story: 'off' | 'default') => ({
            ...settings,
            presets: [{ ...settings.presets[0], slotThinking: { ...settings.presets[0].slotThinking, story } }],
        });
        expect(isThinkingEnabled(withStory('off'))).toBe(false);
        expect(isThinkingEnabled(withStory('default'))).toBe(false);
    });
});

describe('slot thinking — precedence through buildChatBody', () => {
    it('slot level beats the provider legacy value; Model default sends nothing', () => {
        const offSlot = applySlotThinking(flash, preset({ slotThinking: { utility: 'off' } }), 'utility')!;
        expect(buildChatBody(offSlot, MSGS).thinking).toEqual({ type: 'disabled' });
        const defaultSlot = applySlotThinking(flash, preset({ slotThinking: { story: 'default' } }), 'story')!;
        expect(buildChatBody(defaultSlot, MSGS).thinking).toBeUndefined();
        expect(buildChatBody(flash, MSGS).thinking).toEqual({ type: 'enabled' });
    });

    it('an explicit per-call off still wins over a slot set to high', () => {
        const highSlot = applySlotThinking(flash, preset({ slotThinking: { story: 'high' } }), 'story')!;
        expect(buildChatBody(highSlot, MSGS, { thinkingEffort: 'off' }).thinking).toEqual({ type: 'disabled' });
        expect(buildChatBody(highSlot, MSGS).reasoning_effort).toBe('high');
    });
});

describe('slot thinking — presets screen', () => {
    beforeEach(() => {
        const settings = migrateSettings({ settings: { providers: [flash], presets: [preset()], activePresetId: 'pr' } });
        useAppStore.setState({ settings });
    });

    it('shows a thinking picker for each text slot and saves the choice on the preset', () => {
        render(<PresetsPanel />);
        for (const slot of ['story', 'summarizer', 'utility', 'auxiliary']) {
            expect(screen.getByTestId(`slot-thinking-${slot}`)).toBeInTheDocument();
        }
        expect(screen.queryByTestId('slot-thinking-image')).toBeNull();
        expect((screen.getByTestId('slot-thinking-story') as HTMLSelectElement).value).toBe('medium');

        fireEvent.change(screen.getByTestId('slot-thinking-story'), { target: { value: 'default' } });
        fireEvent.change(screen.getByTestId('slot-thinking-utility'), { target: { value: 'low' } });
        const saved = useAppStore.getState().settings.presets[0].slotThinking;
        expect(saved).toEqual({ story: 'default', summarizer: 'off', utility: 'low', auxiliary: 'off' });
    });
});
