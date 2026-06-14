import { embedText as primaryEmbedText } from './embedder';

// The embedder "pool" has been collapsed to a single shared model: every embed
// runs through the primary embedder worker (one model copy in memory). Holding
// parallel pool workers each loaded a full extra 768-dim model — the dominant
// avoidable RAM cost on mobile and a key OOM/lmkd trigger during play. With
// progressive background indexing (see embeddingScheduler), the throughput the
// pool bought isn't worth the memory. The pool's public API is preserved so
// callers (the scheduler) and tests don't need to change.

const CALL_TIMEOUT_MS = 60_000;

/**
 * Background drain concurrency for the scheduler. Pinned to 1 so chunks embed
 * one at a time through the single primary worker — never overlapping work that
 * would queue extra tensors and spike memory.
 */
function getForegroundPoolSize(): number {
    return 1;
}

/**
 * Embed a single text. Routes through the primary embedder so there is only
 * ever one model copy resident. `signal` lets the scheduler abort in-flight
 * work on campaign/model switch.
 */
async function poolEmbed(
    text: string,
    signal?: AbortSignal
): Promise<Float32Array | null> {
    if (signal?.aborted) return null;
    return primaryEmbedText(text);
}

// --- No-op lifecycle hooks retained for API compatibility -------------------
// There is no separate pool to spin up, resize, or tear down anymore; the
// primary embedder owns the single model worker's lifecycle.

async function ensurePool(): Promise<void> {
    return;
}

function resizePool(_n: number): void {
    /* no separate pool to resize */
}

function terminatePool(): void {
    /* no separate pool to terminate */
}

function getActivePoolSize(): number {
    return 0;
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
