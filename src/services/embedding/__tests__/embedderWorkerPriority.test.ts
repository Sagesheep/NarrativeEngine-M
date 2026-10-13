import { describe, it, expect, vi, beforeEach } from 'vitest';

// The worker handles messages concurrently. A search query (urgent) must not wait
// behind every window of a long scene being archived (background): background work
// yields before each model pass while an urgent embed is waiting.

type Pass = { text: string; finish: () => void };

const h = vi.hoisted(() => ({
    /** instant: a pass resolves through microtasks only, as a real model pass does. */
    instant: true,
    passes: [] as { text: string; finish: () => void }[],
    order: [] as string[],
}));

vi.mock('@huggingface/transformers', () => ({
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => (text: string) => {
        h.order.push(text);
        const out = { data: new Float32Array([1, 0]) };
        if (h.instant) return Promise.resolve(out);
        return new Promise(resolve => {
            h.passes.push({ text, finish: () => resolve(out) });
        });
    },
}));

const posted: { type: string; id: string }[] = [];
(self as unknown as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => {
    posted.push(m as { type: string; id: string });
};

await import('../embedder.worker');

const send = (data: unknown) =>
    (self.onmessage as (e: MessageEvent) => Promise<void>)({ data } as MessageEvent);

/** Let pending tasks and promise chains run. */
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Finish the oldest unfinished model pass, then let the worker react. */
async function finishNext(): Promise<Pass> {
    const pass = h.passes.shift()!;
    pass.finish();
    await flush();
    return pass;
}

// > 1500 chars → 1000-char windows at a 700 stride: 4 passes.
const SCENE = 'S'.repeat(2600);

beforeEach(() => {
    h.instant = true;
    h.passes.length = 0;
    h.order.length = 0;
    posted.length = 0;
});

describe('embedder worker — urgent query embeds', () => {
    it('a query that arrives while a scene is being embedded is received before the scene finishes', async () => {
        const bg = send({ type: 'embed', id: 'scene', text: SCENE });
        // The query arrives as its own message (a separate task), as on the phone.
        const q = new Promise<void>(resolve => setTimeout(() => {
            void send({ type: 'embed', id: 'query', text: 'who is at the gate', urgent: true }).then(resolve);
        }, 0));
        await Promise.all([bg, q]);

        expect(h.order).toHaveLength(5);
        expect(h.order.indexOf('who is at the gate')).toBeLessThanOrEqual(1);
        expect(posted.map(m => m.id).sort()).toEqual(['query', 'scene']);
    });

    it('background windows wait while a query is in flight, then resume', async () => {
        h.instant = false;
        const bg = send({ type: 'embed', id: 'scene', text: SCENE });
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
        await send({ type: 'embed', id: 'npc', text: 'Wen Huang, archivist' });
        expect(h.order).toEqual(['Wen Huang, archivist']);
        expect(posted.find(m => m.id === 'npc')?.type).toBe('result');
    });
});
