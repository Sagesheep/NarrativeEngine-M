import { pipeline } from '@huggingface/transformers';

type EmbedderPipeline = Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;
const MAX_TEXT_LEN = 500;

let embedder: EmbedderPipeline | null = null;
let loading: Promise<EmbedderPipeline> | null = null;
let ready = false;

export async function warmupEmbedder(): Promise<void> {
    if (ready && embedder) return;
    if (loading) {
        await loading;
        return;
    }
    loading = (async () => {
        try {
            const p = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
            embedder = p;
            ready = true;
            return p;
        } catch (e) {
            console.warn('[Embedder] Failed to load model:', e);
            loading = null;
            throw e;
        }
    })();
    await loading;
}

export async function embedText(text: string): Promise<Float32Array | null> {
    if (!embedder) {
        if (!loading) return null;
        try { await loading; } catch { return null; }
        if (!embedder) return null;
    }
    try {
        const truncated = text.slice(0, MAX_TEXT_LEN);
        const output = await embedder(truncated, { pooling: 'mean', normalize: true });
        return output.data as Float32Array;
    } catch (e) {
        console.warn('[Embedder] embedText failed:', e);
        return null;
    }
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    const results: (Float32Array | null)[] = [];
    for (const text of texts) {
        results.push(await embedText(text));
    }
    return results;
}

export function isEmbedderReady(): boolean {
    return ready && embedder !== null;
}

export function getEmbedDims(): number {
    return DIMS;
}
