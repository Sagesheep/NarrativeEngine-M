import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const isLanguageSupported = vi.fn();

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor-community/text-to-speech', () => ({
    TextToSpeech: { isLanguageSupported: (...a: unknown[]) => isLanguageSupported(...a) },
    QueueStrategy: { Flush: 0, Add: 1 },
}));

// The WebView on Android has no Web Speech, so the native probe decides.
const hadSpeech = 'speechSynthesis' in window;

async function freshModule() {
    vi.resetModules();
    return import('../speech');
}

describe('native TTS probe', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        isLanguageSupported.mockReset();
        if (hadSpeech) delete (window as unknown as Record<string, unknown>).speechSynthesis;
    });
    afterEach(() => vi.useRealTimers());

    it('keeps the speaker button when the engine is not bound at boot', async () => {
        isLanguageSupported
            .mockRejectedValueOnce(new Error('not initialized'))
            .mockResolvedValueOnce({ supported: false })
            .mockResolvedValue({ supported: true });
        const speech = await freshModule();

        speech.initVoices();
        expect(speech.speechSupported()).toBe(true);
        await vi.advanceTimersByTimeAsync(3000);

        expect(isLanguageSupported).toHaveBeenCalledTimes(3);
        expect(speech.speechSupported()).toBe(true);
    });

    it('hides it only after every retry fails', async () => {
        isLanguageSupported.mockRejectedValue(new Error('no engine'));
        const speech = await freshModule();

        speech.initVoices();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(isLanguageSupported).toHaveBeenCalledTimes(6);
        expect(speech.speechSupported()).toBe(false);
    });
});
