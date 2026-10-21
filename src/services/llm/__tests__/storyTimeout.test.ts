import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { sendMessage } from '../llmService';
import { getActiveCalls, getCallHistory } from '../utilityCallTracker';
import type { LLMProvider } from '../../../types';

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: vi.fn(() => false) },
    CapacitorHttp: { post: vi.fn() },
}));
vi.mock('../modelCatalog', () => ({
    ensureModelCatalog: vi.fn(async () => {}),
    ensureOpenRouterServiceTiers: vi.fn(async () => {}),
    lookupServiceTiers: () => undefined,
}));

const provider: LLMProvider = { id: 'test', label: 'Test', endpoint: 'https://example.test/v1', apiKey: '', modelName: 'slow-model', streamingEnabled: false };
const reply = { choices: [{ message: { content: 'The gate opens.' } }] };

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

function delayedFetch(delay: number) {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
        const signal = init.signal!;
        signals.push(signal);
        const timer = setTimeout(() => resolve(new Response(JSON.stringify(reply), { status: 200 })), delay);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    })));
    return signals;
}

describe('configurable story timeout', () => {
    it('allows a slow reply past 180 seconds and stops waiting at the configured deadline', async () => {
        const signals = delayedFetch(700_000);
        const onError = vi.fn();
        const pending = sendMessage(provider, [], vi.fn(), vi.fn(), onError, undefined, undefined, undefined, 600);
        await vi.advanceTimersByTimeAsync(180_001);
        expect(signals[0].aborted).toBe(false);
        expect(getActiveCalls().find(c => c.label === 'story-generation')?.initialTimeoutMs).toBe(600_000);
        await vi.advanceTimersByTimeAsync(420_000);
        await pending;
        expect(signals[0].aborted).toBe(true);
        expect(onError).toHaveBeenCalledWith('__ABORT__');
        expect(getCallHistory()[0].status).toBe('timeout');
    });

    it('accepts a completed reply after four minutes when configured for ten', async () => {
        delayedFetch(240_000);
        const onDone = vi.fn();
        const onError = vi.fn();
        const pending = sendMessage(provider, [], vi.fn(), onDone, onError, undefined, undefined, undefined, 600);
        await vi.advanceTimersByTimeAsync(240_001);
        await pending;
        expect(onDone).toHaveBeenCalledWith('The gate opens.', undefined, undefined);
        expect(onError).not.toHaveBeenCalled();
    });

    it('preserves the old initial deadline when settings do not specify one', async () => {
        const signals = delayedFetch(240_000);
        const pending = sendMessage(provider, [], vi.fn(), vi.fn(), vi.fn());
        await vi.advanceTimersByTimeAsync(120_001);
        await pending;
        expect(signals[0].aborted).toBe(true);
    });

    it('extends a ten-minute streaming deadline while story text keeps arriving', async () => {
        const encoder = new TextEncoder();
        const controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
            start(stream) {
                const timers = [240_000, 590_000, 620_000, 650_000].map(delay => setTimeout(() => {
                    stream.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"rain "}}]}\n\n'));
                }, delay));
                timers.push(setTimeout(() => stream.close(), 680_000));
                controller.signal.addEventListener('abort', () => {
                    timers.forEach(clearTimeout);
                    stream.error(new DOMException('Aborted', 'AbortError'));
                });
            },
        }))));
        const onDone = vi.fn();
        const onError = vi.fn();
        const pending = sendMessage({ ...provider, streamingEnabled: true }, [], vi.fn(), onDone, onError, undefined, controller, undefined, 600);
        await vi.advanceTimersByTimeAsync(680_001);
        await pending;
        expect(controller.signal.aborted).toBe(false);
        expect(onDone).toHaveBeenCalledWith('rain rain rain rain ', undefined, undefined);
        expect(onError).not.toHaveBeenCalled();
    });

    it('still honors Stop before the longer deadline', async () => {
        const signals = delayedFetch(240_000);
        const controller = new AbortController();
        const pending = sendMessage(provider, [], vi.fn(), vi.fn(), vi.fn(), undefined, controller, undefined, 600);
        await vi.advanceTimersByTimeAsync(1);
        controller.abort();
        await pending;
        expect(signals[0].aborted).toBe(true);
    });

    it('applies the configured limit to the native HTTP transport', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        vi.mocked(CapacitorHttp.post).mockResolvedValueOnce({ status: 200, data: reply, headers: {}, url: '' });
        await sendMessage(provider, [], vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, 1200);
        expect(CapacitorHttp.post).toHaveBeenCalledWith(expect.objectContaining({ readTimeout: 1_200_000 }));
    });

    it('keeps the configured limit when native streaming falls back to buffered HTTP', async () => {
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
        vi.mocked(CapacitorHttp.post).mockResolvedValueOnce({ status: 200, data: reply, headers: {}, url: '' });
        await sendMessage({ ...provider, streamingEnabled: true }, [], vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, 1200);
        expect(CapacitorHttp.post).toHaveBeenCalledWith(expect.objectContaining({ readTimeout: 1_200_000 }));
    });
});
