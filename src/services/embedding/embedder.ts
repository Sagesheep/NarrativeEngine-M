const MODEL_DIMS: Record<string, number> = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/bge-base-en-v1.5': 768,
};

const DEFAULT_DIMS = 384;
const STANDARD_MODEL = 'Xenova/all-MiniLM-L6-v2';
const HIGH_MODEL = 'Xenova/bge-base-en-v1.5';

const CALL_TIMEOUT_MS = 60_000;
const BATCH_CALL_TIMEOUT_MS = 30_000;

export type DownloadProgress = {
    file: string;
    loaded: number;
    total: number;
    aggregateLoaded: number;
    aggregateTotal: number;
};

type WorkerResponse =
    | { type: 'ready'; id: string }
    | { type: 'result'; id: string; vector: number[] | null }
    | { type: 'batchResult'; id: string; vectors: (number[] | null)[] }
    | { type: 'progress'; id: string; file: string; loaded: number; total: number }
    | { type: 'error'; id: string; message: string };

type PendingEntry = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

let worker: Worker | null = null;
let ready = false;
let lastInitError: Error | null = null;
let currentModelId = STANDARD_MODEL;
let currentDims = DEFAULT_DIMS;
const pending = new Map<string, PendingEntry>();

let onProgressCallback: ((progress: DownloadProgress) => void) | null = null;
const fileProgress = new Map<string, { loaded: number; total: number }>();

function computeAggregate(): { aggregateLoaded: number; aggregateTotal: number } {
    let aggregateLoaded = 0;
    let aggregateTotal = 0;
    for (const p of fileProgress.values()) {
        aggregateLoaded += p.loaded;
        aggregateTotal += p.total;
    }
    return { aggregateLoaded, aggregateTotal };
}

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL('./embedder.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
            const { id, type } = e.data;

            if (type === 'progress' && id === 'model-download') {
                fileProgress.set(e.data.file, { loaded: e.data.loaded, total: e.data.total });
                const { aggregateLoaded, aggregateTotal } = computeAggregate();
                onProgressCallback?.({
                    file: e.data.file,
                    loaded: e.data.loaded,
                    total: e.data.total,
                    aggregateLoaded,
                    aggregateTotal,
                });
                return;
            }

            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            clearTimeout(entry.timer);

            if (type === 'ready') {
                ready = true;
                entry.resolve(undefined);
            } else if (type === 'error') {
                entry.reject(new Error(e.data.message));
            } else if (type === 'result') {
                entry.resolve(e.data.vector ? new Float32Array(e.data.vector) : null);
            } else if (type === 'batchResult') {
                entry.resolve(e.data.vectors.map(v => v ? new Float32Array(v) : null));
            }
        };
    }
    return worker;
}

function request<T>(msg: { type: string; id: string } & Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(msg.id);
            reject(new Error(`[Embedder] Call timed out (${msg.type})`));
        }, timeoutMs ?? CALL_TIMEOUT_MS);
        pending.set(msg.id, { resolve: resolve as (v: unknown) => void, reject, timer });
        getWorker().postMessage(msg);
    });
}

function drainPending(error: Error): void {
    for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
    }
    pending.clear();
}

function modelIdFromSetting(setting: 'standard' | 'high'): string {
    return setting === 'high' ? HIGH_MODEL : STANDARD_MODEL;
}

function dimsFromModelId(modelId: string): number {
    return MODEL_DIMS[modelId] ?? DEFAULT_DIMS;
}

function allowRemoteForModel(modelId: string): boolean {
    return modelId !== STANDARD_MODEL;
}

export async function warmupEmbedder(): Promise<void> {
    if (ready && worker) return;
    let modelId: string;
    let allowRemote: boolean;
    try {
        const { useAppStore } = await import('../../store/useAppStore');
        const setting = useAppStore.getState().settings.embeddingModel ?? 'standard';
        modelId = modelIdFromSetting(setting);
        allowRemote = allowRemoteForModel(modelId);
    } catch {
        modelId = STANDARD_MODEL;
        allowRemote = false;
    }
    try {
        await request<void>({ type: 'init', id: `init-${Date.now()}`, modelId, allowRemote });
        currentModelId = modelId;
        currentDims = dimsFromModelId(modelId);
        lastInitError = null;
    } catch (e) {
        console.warn('[Embedder] Warmup with settings failed, falling back:', e);
        currentModelId = STANDARD_MODEL;
        currentDims = DEFAULT_DIMS;
        try {
            await request<void>({ type: 'init', id: `init-fallback-${Date.now()}`, modelId: STANDARD_MODEL, allowRemote: false });
            lastInitError = null;
        } catch (e2) {
            console.warn('[Embedder] Fallback warmup also failed:', e2);
            lastInitError = e2 instanceof Error ? e2 : new Error(String(e2));
        }
    }
}

export function getLastInitError(): Error | null {
    return lastInitError;
}

export async function switchEmbeddingModel(
    modelSetting: 'standard' | 'high',
    onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
    import('./embeddingScheduler').then(({ abortForModelSwitch }) => abortForModelSwitch()).catch(() => {});

    const modelId = modelIdFromSetting(modelSetting);
    const allowRemote = allowRemoteForModel(modelId);

    const prevModelId = currentModelId;
    const prevDims = currentDims;

    if (worker) {
        worker.terminate();
        worker = null;
    }
    ready = false;
    drainPending(new Error('[Embedder] Model switch — pending calls cancelled'));
    fileProgress.clear();
    onProgressCallback = onProgress ?? null;

    try {
        await request<void>({ type: 'init', id: `switch-${Date.now()}`, modelId, allowRemote });
        currentModelId = modelId;
        currentDims = dimsFromModelId(modelId);
    } catch (e) {
        currentModelId = prevModelId;
        currentDims = prevDims;
        onProgressCallback = null;
        throw e;
    }
    onProgressCallback = null;
}

export async function embedText(text: string): Promise<Float32Array | null> {
    try {
        return await request<Float32Array | null>({ type: 'embed', id: `embed-${Date.now()}-${Math.random().toString(36).slice(2)}`, text });
    } catch (e) {
        console.warn('[Embedder] embedText failed:', e);
        return null;
    }
}

export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
    try {
        return await request<(Float32Array | null)[]>({ type: 'embedBatch', id: `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`, texts }, BATCH_CALL_TIMEOUT_MS);
    } catch (e) {
        console.warn('[Embedder] embedBatch failed:', e);
        return texts.map(() => null);
    }
}

export function isEmbedderReady(): boolean {
    return ready;
}

export function getEmbedDims(): number {
    return currentDims;
}

export function getCurrentModelId(): string {
    return currentModelId;
}