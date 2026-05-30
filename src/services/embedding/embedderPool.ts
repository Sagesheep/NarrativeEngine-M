import { getCurrentModelId, embedText as primaryEmbedText } from './embedder';

const CALL_TIMEOUT_MS = 60_000;

type WorkerResponse =
    | { type: 'ready'; id: string }
    | { type: 'result'; id: string; vector: number[] | null }
    | { type: 'error'; id: string; message: string };

type PendingEntry = {
    resolve: (v: Float32Array | null) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

interface PoolWorker {
    worker: Worker;
    pending: Map<string, PendingEntry>;
    initialized: boolean;
    dead: boolean;
}

let pool: PoolWorker[] = [];

function getForegroundPoolSize(): number {
    const hc = navigator.hardwareConcurrency || 4;
    let n = Math.floor(hc * 0.75);
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (typeof mem === 'number') {
        if (mem <= 2) n = Math.min(n, 1);
        else if (mem <= 4) n = Math.min(n, 2);
    }
    return Math.max(1, Math.min(6, n));
}

function leastBusyWorker(): PoolWorker | null {
    let best: PoolWorker | null = null;
    let bestCount = Infinity;
    for (const pw of pool) {
        if (pw.dead || !pw.initialized) continue;
        if (pw.pending.size < bestCount) {
            bestCount = pw.pending.size;
            best = pw;
        }
    }
    return best;
}

function initPoolWorker(pw: PoolWorker): Promise<boolean> {
    const modelId = getCurrentModelId();
    const allowRemote = modelId !== 'Xenova/all-MiniLM-L6-v2';
    return new Promise<boolean>((resolve) => {
        const id = `pool-init-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => {
            pw.pending.delete(id);
            pw.dead = true;
            resolve(false);
        }, CALL_TIMEOUT_MS);

        pw.pending.set(id, {
            resolve: () => {
                pw.pending.delete(id);
                clearTimeout(timer);
                pw.initialized = true;
                resolve(true);
            },
            reject: () => {
                pw.pending.delete(id);
                clearTimeout(timer);
                pw.dead = true;
                resolve(false);
            },
            timer,
        });

        pw.worker.postMessage({
            type: 'init',
            id,
            modelId,
            allowRemote,
        });
    });
}

function createPoolWorker(): PoolWorker | null {
    try {
        const worker = new Worker(
            new URL('./embedder.worker.ts', import.meta.url),
            { type: 'module' }
        );
        const pw: PoolWorker = { worker, pending: new Map(), initialized: false, dead: false };

        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
            const { id, type } = e.data;
            const entry = pw.pending.get(id);
            if (!entry) return;
            pw.pending.delete(id);
            clearTimeout(entry.timer);

            if (type === 'error') {
                entry.reject(new Error(e.data.message));
            } else if (type === 'result') {
                entry.resolve(e.data.vector ? new Float32Array(e.data.vector) : null);
            } else if (type === 'ready') {
                entry.resolve(null);
            }
        };

        worker.onerror = () => {
            pw.dead = true;
            const err = new Error('[PoolWorker] Worker error');
            for (const [, entry] of pw.pending) {
                clearTimeout(entry.timer);
                entry.reject(err);
            }
            pw.pending.clear();
        };

        return pw;
    } catch {
        return null;
    }
}

async function ensurePool(): Promise<void> {
    if (pool.length > 0) return;
    const targetSize = getForegroundPoolSize();
    for (let i = 0; i < targetSize; i++) {
        const pw = createPoolWorker();
        if (!pw) break;
        pool.push(pw);
        const ok = await initPoolWorker(pw);
        if (!ok) {
            pool = pool.filter(p => p !== pw);
        }
    }
}

function resizePool(n: number): void {
    n = Math.max(1, Math.min(6, n));
    while (pool.length < n) {
        const pw = createPoolWorker();
        if (pw) pool.push(pw);
        else break;
    }
}

async function poolEmbed(
    text: string,
    signal?: AbortSignal
): Promise<Float32Array | null> {
    await ensurePool();

    if (signal?.aborted) return null;

    const pw = leastBusyWorker();
    if (!pw || pw.dead) {
        return primaryEmbedText(text);
    }

    const id = `pool-embed-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise<Float32Array | null>((resolve) => {
        const timer = setTimeout(() => {
            pw.pending.delete(id);
            resolve(null);
        }, CALL_TIMEOUT_MS);

        if (signal?.aborted) {
            clearTimeout(timer);
            resolve(null);
            return;
        }

        const onAbort = () => {
            clearTimeout(timer);
            pw.pending.delete(id);
            resolve(null);
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        pw.pending.set(id, {
            resolve: (v) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                pw.pending.delete(id);
                resolve(v);
            },
            reject: () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                pw.pending.delete(id);
                resolve(null);
            },
            timer,
        });

        pw.worker.postMessage({ type: 'embed', id, text });
    }).catch(() => {
        return primaryEmbedText(text);
    });
}

function terminatePool(): void {
    for (const pw of pool) {
        pw.dead = true;
        for (const [, entry] of pw.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('[PoolWorker] Pool terminated'));
        }
        pw.pending.clear();
        pw.worker.terminate();
    }
    pool = [];
}

function getActivePoolSize(): number {
    return pool.filter(pw => !pw.dead && pw.initialized).length;
}

export {
    getForegroundPoolSize,
    resizePool,
    terminatePool,
    getActivePoolSize,
    poolEmbed,
    ensurePool,
    CALL_TIMEOUT_MS,
};