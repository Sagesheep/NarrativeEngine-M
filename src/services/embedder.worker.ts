/// <reference lib="webworker" />

import { pipeline, env } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.localModelPath = '/models/';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const SINGLE_PASS_LIMIT = 1500;
const WINDOW_SIZE = 1000;
const WINDOW_STRIDE = 700;

type EmbedderPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

let embedder: EmbedderPipeline | null = null;
let loading: Promise<EmbedderPipeline> | null = null;
let ready = false;

async function ensureWarm(): Promise<EmbedderPipeline> {
    if (ready && embedder) return embedder;
    if (loading) return loading;

    loading = (async () => {
        try {
            const p = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
            embedder = p;
            ready = true;
            return p;
        } catch (e) {
            loading = null;
            throw e;
        }
    })();

    return loading;
}

async function embedSingle(text: string): Promise<number[] | null> {
    try {
        const model = await ensureWarm();

        if (text.length <= SINGLE_PASS_LIMIT) {
            const output = await model(text, { pooling: 'mean', normalize: true });
            return Array.from(output.data as Float32Array);
        }

        const windows: string[] = [];
        let i = 0;
        while (i < text.length) {
            windows.push(text.slice(i, i + WINDOW_SIZE));
            if (i + WINDOW_SIZE >= text.length) break;
            i += WINDOW_STRIDE;
        }

        const vectors: number[][] = [];
        for (const window of windows) {
            const output = await model(window, { pooling: 'mean', normalize: true });
            vectors.push(Array.from(output.data as Float32Array));
        }

        const dim = vectors[0].length;
        const pooled = new Array(dim).fill(0);
        for (const vec of vectors) {
            for (let j = 0; j < dim; j++) {
                pooled[j] += vec[j];
            }
        }
        for (let j = 0; j < dim; j++) {
            pooled[j] /= vectors.length;
        }

        let norm = 0;
        for (let j = 0; j < dim; j++) {
            norm += pooled[j] * pooled[j];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
            for (let j = 0; j < dim; j++) {
                pooled[j] /= norm;
            }
        }

        return pooled;
    } catch {
        return null;
    }
}

type WorkerInMessage =
    | { type: 'warmup'; id: string }
    | { type: 'embed'; id: string; text: string }
    | { type: 'embedBatch'; id: string; texts: string[] };

self.onmessage = async (e: MessageEvent<WorkerInMessage>) => {
    const msg = e.data;

    try {
        switch (msg.type) {
            case 'warmup':
                await ensureWarm();
                self.postMessage({ type: 'ready', id: msg.id });
                break;

            case 'embed': {
                const vector = await embedSingle(msg.text);
                self.postMessage({ type: 'result', id: msg.id, vector });
                break;
            }

            case 'embedBatch': {
                const vectors: (number[] | null)[] = [];
                for (const text of msg.texts) {
                    vectors.push(await embedSingle(text));
                }
                self.postMessage({ type: 'batchResult', id: msg.id, vectors });
                break;
            }
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: msg.id, message: String(err) });
    }
};
