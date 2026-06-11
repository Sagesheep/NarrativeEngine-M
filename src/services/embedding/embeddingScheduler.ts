import { poolEmbed, terminatePool, getForegroundPoolSize } from './embedderPool';
import { embeddingStorage } from '../storage/embeddingStorage';
import type { ReindexState } from '../../store/slices/uiSlice';

type ChunkType = 'lore' | 'rule';

export type ProgressiveChunk = {
    id: string;
    content: string;
    modes: ('vector' | 'keyword' | 'always')[];
    priority: number;
};

type QueueEntry = {
    campaignId: string;
    type: ChunkType;
    id: string;
    content: string;
    priority: number;
};

let queue: QueueEntry[] = [];
let totalQueued = 0;
let doneCount = 0;
let draining = false;

let abortController: AbortController | null = null;

let streamUnsubscribe: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
let listenersInstalled = false;

type StoreLike = {
    getState: () => { isStreaming: boolean; embeddingsReindexing: ReindexState; setEmbeddingsReindexing: (s: ReindexState) => void };
    subscribe: (listener: (state: any) => any) => () => void;
};

let storeRef: StoreLike | null = null;

/**
 * Wire the live zustand store into the scheduler. Called once from
 * `useAppStore.ts` right after the store is created. This replaces the old
 * `require('../../store/useAppStore')` hack — which threw in Vite browser
 * bundles (no runtime `require`), silently disabling the progress chip,
 * the AI-streaming pause, and the stream-end resume listener.
 *
 * Keeping the wiring as a setter also means the dependency is one-way
 * (store → scheduler), so there is no longer a circular import to dodge.
 */
export function registerStore(store: StoreLike): void {
    storeRef = store;
}

function getStore(): StoreLike | null {
    return storeRef;
}

function setReindexProgress(state: ReindexState): void {
    const store = getStore();
    if (!store) return;
    const current = store.getState().embeddingsReindexing;
    if (state.active && current.active && current.reason && current.reason !== 'progressive') {
        return;
    }
    store.getState().setEmbeddingsReindexing(state);
}

function checkIsStreaming(): boolean {
    const store = getStore();
    if (!store) return false;
    return store.getState().isStreaming;
}

function installListeners(): void {
    if (listenersInstalled) return;
    listenersInstalled = true;

    const store = getStore();
    if (store && store.subscribe) {
        streamUnsubscribe = store.subscribe((state: any) => {
            if (state && state.isStreaming === false && !draining && queue.length > 0) {
                drainQueue();
            }
        });
    }

    if (typeof document !== 'undefined') {
        visibilityHandler = () => {
            if (!document.hidden && !draining && queue.length > 0) {
                drainQueue();
            }
        };
        document.addEventListener('visibilitychange', visibilityHandler);
    }
}

function removeListeners(): void {
    if (streamUnsubscribe) {
        streamUnsubscribe();
        streamUnsubscribe = null;
    }
    if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
    }
    listenersInstalled = false;
}

async function drainQueue(): Promise<void> {
    if (draining) return;
    draining = true;

    try {
        while (queue.length > 0) {
            if (checkIsStreaming()) {
                draining = false;
                return;
            }
            if (typeof document !== 'undefined' && document.hidden) {
                draining = false;
                return;
            }

            if (abortController?.signal.aborted) {
                break;
            }

            const batchSize = Math.min(getForegroundPoolSize(), queue.length);
            const batch = queue.splice(0, batchSize);

            const results = await Promise.all(
                batch.map((entry) =>
                    poolEmbed(entry.content, abortController?.signal)
                        .then((vec) => ({ entry, vec }))
                        .catch(() => ({ entry, vec: null as Float32Array | null }))
                )
            );

            for (const { entry, vec } of results) {
                if (abortController?.signal.aborted) break;
                if (vec) {
                    try {
                        await embeddingStorage.store(
                            entry.campaignId,
                            entry.id,
                            Array.from(vec),
                            entry.type,
                            undefined
                        );
                    } catch (err) {
                        // Survivable: the chunk is retried on next app start via
                        // enqueueProgressiveWithExistingCheck's storage diff. But
                        // warn so a persistent stall is diagnosable (ISSUE-5).
                        console.warn(
                            `[embeddingScheduler] failed to store embedding for ${entry.type}:${entry.id}`,
                            err
                        );
                    }
                }
                doneCount++;
            }

            setReindexProgress({
                active: true,
                total: totalQueued,
                done: doneCount,
                reason: 'progressive',
            });
        }
    } catch {
    }

    if (queue.length === 0 || abortController?.signal.aborted) {
        setReindexProgress({ active: false, total: 0, done: 0, reason: null });
        terminatePool();
        removeListeners();
        abortController = null;
        draining = false;
        // Reset counters so the next upload starts from 0 rather than
        // accumulating onto this drain's totals (ISSUE-3).
        totalQueued = 0;
        doneCount = 0;
    } else {
        draining = false;
    }
}

export function enqueueProgressive(params: {
    campaignId: string;
    type: ChunkType;
    chunks: ProgressiveChunk[];
}): void {
    const { campaignId, type, chunks } = params;

    const vectorChunks = chunks.filter(
        (c) => c.modes.includes('vector')
    );

    if (vectorChunks.length === 0) return;

    const dedupeKey = (t: ChunkType, id: string) => `${t}:${id}`;
    const existingKeys = new Set(queue.map((e) => dedupeKey(e.type, e.id)));

    const newEntries: QueueEntry[] = vectorChunks
        .filter((c) => !existingKeys.has(dedupeKey(type, c.id)))
        .map((c) => ({
            campaignId,
            type,
            id: c.id,
            content: c.content,
            priority: c.priority,
        }));

    if (newEntries.length === 0) return;

    queue.push(...newEntries);
    queue.sort((a, b) => b.priority - a.priority);

    totalQueued += newEntries.length;

    setReindexProgress({
        active: true,
        total: totalQueued,
        done: doneCount,
        reason: 'progressive',
    });

    installListeners();

    abortController = abortController ?? new AbortController();

    if (!draining) {
        drainQueue();
    }
}

export async function enqueueProgressiveWithExistingCheck(params: {
    campaignId: string;
    type: ChunkType;
    chunks: ProgressiveChunk[];
}): Promise<void> {
    const { campaignId, type, chunks } = params;

    const vectorChunks = chunks.filter(
        (c) => c.modes.includes('vector')
    );
    if (vectorChunks.length === 0) return;

    const allStored = await embeddingStorage.getAll(campaignId, type);
    const storedIds = new Set(allStored.map((e) => e.id));

    const toEmbed = vectorChunks.filter((c) => !storedIds.has(c.id));

    if (toEmbed.length === 0) return;

    enqueueProgressive({ campaignId, type, chunks: toEmbed });
}

export function abortForCampaignSwitch(): void {
    if (abortController) {
        abortController.abort();
        abortController = null;
    }
    queue = [];
    totalQueued = 0;
    doneCount = 0;
    draining = false;
    terminatePool();
    removeListeners();
    setReindexProgress({ active: false, total: 0, done: 0, reason: null });
}

export function abortForModelSwitch(): void {
    abortForCampaignSwitch();
}

export function getQueueStats(): { total: number; done: number; queueLength: number } {
    return { total: totalQueued, done: doneCount, queueLength: queue.length };
}

export function _resetForTesting(): void {
    queue = [];
    totalQueued = 0;
    doneCount = 0;
    draining = false;
    abortController = null;
    listenersInstalled = false;
    storeRef = null;
}

export function _setStoreRefForTesting(store: StoreLike): void {
    storeRef = store;
}