import { describe, it, expect, vi, beforeEach } from 'vitest';

// The worker handles messages concurrently. A search query (urgent) must not wait
// behind every window of a long scene being archived (background): background work
// yields before each model pass while an urgent embed is waiting.

type Pass = { text: string; finish: () => void };

const h = vi.hoisted(() => ({
    passes: [] as { text: string; finish: () => void }[],
    order: [] as string[],
}));

vi.mock('@huggingface/transformers', () => ({
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => (text: string) => new Promise(resolve => {
        h.order.push(text);
        h.passes.push({ text, finish: () => resolve({ data: new Float32Array([1, 0]) }) });
    }),
}));

const posted: { type: string; id: string }[] = [];
(self as unknown as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => {
    posted.push(m as { type: string; id: string });
};

await import('../embedder.worker');

const send = (data: unknown) =>
    (self.onmessage as (e: MessageEvent) => Promise<void>)({ data } as MessageEvent);

/** Let pending promise chains run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Finish the oldest unfinished model pass, then let the worker react. */
async function finishNext(): Promise<Pass> {
    const pass = h.passes.shift()!;
    pass.finish();
    await flush();
    return pass;
}

beforeEach(() => {
    h.passes.length = 0;
    h.order.length = 0;
    posted.length = 0;
});

describe('embedder worker — urgent query embeds', () => {
    it('a query runs before the remaining windows of a scene already being embedded', async () => {
        // > 1500 chars → 1000-char windows at a 700 stride: 4 passes.
        const scene = 'S'.repeat(2600);
        const bg = send({ type: 'embed', id: 'scene', text: scene });
        await flush();
        expect(h.order).toHaveLength(1);           // first scene window in flight

        const q = send({ type: 'embed', id: 'query', text: 'who is at the gate', urgent: true });
        await flush();
        expect(h.order[1]).toBe('who is at the gate'); // query starts without waiting

        await finishNext();                         // scene window 1 completes
        expect(h.order).toHaveLength(2);           // scene waits while the query is pending

        await finishNext();                         // query completes
        expect(posted.find(m => m.id === 'query')?.type).toBe('result');
        expect(h.order).toHaveLength(3);           // scene resumes

        while (h.passes.length) await finishNext();
        await Promise.all([bg, q]);
        expect(posted.find(m => m.id === 'scene')?.type).toBe('result');
    });

    it('background embeds run normally when no query is waiting', async () => {
        const p = send({ type: 'embed', id: 'npc', text: 'Wen Huang, archivist' });
        await flush();
        expect(h.order).toEqual(['Wen Huang, archivist']);
        await finishNext();
        await p;
        expect(posted.find(m => m.id === 'npc')?.type).toBe('result');
    });
});
