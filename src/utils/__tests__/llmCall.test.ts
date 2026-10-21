import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false },
    CapacitorHttp: { post: vi.fn() },
}));
vi.mock('../../services/llm/modelCatalog', () => ({
    ensureModelCatalog: vi.fn(async () => {}),
    ensureOpenRouterServiceTiers: vi.fn(async () => {}),
}));
vi.mock('../../services/llm/llmRequestQueue', () => ({
    getQueueForEndpoint: () => ({
        acquireSlot: async () => {},
        releaseSlot: () => {},
        onRateLimitHit: () => {},
    }),
}));
vi.mock('../llmApiHelper', () => ({
    getApiFormat: () => 'openai',
    getChatUrl: () => 'https://example.test/v1/chat/completions',
    buildChatHeaders: () => ({}),
    buildChatBody: () => ({}),
    extractContent: (data: any) => data.text,
    thinkingControlFor: () => undefined,
}));

import { llmCall, UtilityTimeoutError } from '../llmCall';

const provider = { endpoint: 'https://example.test', modelName: 'm' } as any;

/** fetch that never answers, but rejects like the real one when its signal aborts. */
function hangingFetch() {
    const signals: AbortSignal[] = [];
    const fn = vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        return new Promise<Response>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
    });
    return { fn, signals };
}

describe('llmCall timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('aborts the request when the deadline passes', async () => {
        const { fn, signals } = hangingFetch();
        vi.stubGlobal('fetch', fn);

        const p = llmCall(provider, 'hi', { trackingLabel: 't', timeoutMs: 1_000 });
        const settled = expect(p).rejects.toBeInstanceOf(UtilityTimeoutError);
        await vi.advanceTimersByTimeAsync(1_001);
        await settled;

        expect(fn).toHaveBeenCalledTimes(1);
        expect(signals[0].aborted).toBe(true);
    });

    it("still aborts on the caller's signal", async () => {
        const { fn, signals } = hangingFetch();
        vi.stubGlobal('fetch', fn);
        const ac = new AbortController();

        const p = llmCall(provider, 'hi', { trackingLabel: 't', timeoutMs: 60_000, signal: ac.signal });
        const settled = expect(p).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        ac.abort();
        await settled;
        expect(signals[0].aborted).toBe(true);
    });

    it('does not send a request whose signal is already aborted', async () => {
        const { fn } = hangingFetch();
        vi.stubGlobal('fetch', fn);
        const ac = new AbortController();
        ac.abort();

        await expect(llmCall(provider, 'hi', { signal: ac.signal })).rejects.toThrow();
        expect(fn).not.toHaveBeenCalled();
    });

    it('returns the answer when it beats the deadline', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200, json: async () => ({ text: 'ok' }),
        })));
        await expect(llmCall(provider, 'hi', { trackingLabel: 't', timeoutMs: 1_000 })).resolves.toBe('ok');
    });
});
