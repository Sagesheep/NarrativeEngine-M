import { useSyncExternalStore } from 'react';
import type { LootDropResult, ResolveLootOpts } from '../../types';

/**
 * Loot drop telemetry — mirrors the `utilityCallTracker` + `cacheTelemetry`
 * pattern: an in-memory store published via `useSyncExternalStore` so debug
 * surfaces (DebugPanel + context-bank diagnostics) re-render on new drops
 * without threading state through the Zustand app store.
 *
 * Records the LAST resolved drop (items + walker trace + the opts that armed
 * it). Kept shallow: full history would bloat a debug surface; the orchestrator
 * only pushes one entry per armed send.
 */

export type LootDropRecord = {
    /** Epoch ms — when the orchestrator resolved this drop. */
    resolvedAt: number;
    /** How many items were requested (armedLoot.rolls). */
    rolls: number;
    /** Root-node reweight applied this pull (unchecked modal options → 0). */
    reweight?: Record<string, Record<string, number>>;
    /** The composed items + bare appendToInput tag from the walker. */
    items: LootDropResult['items'];
    appendToInput: string;
    /** Per-item walker trace (node ids + draws + rolls). */
    trace: string[];
    /** True when the tree resolved zero items (e.g. all root options reweighted to 0). */
    empty: boolean;
};

const MAX_HISTORY = 10;

let history: LootDropRecord[] = [];
const listeners = new Set<() => void>();

function emit() {
    snapshotRef = { history };
    for (const l of listeners) l();
}

/** Record a resolved loot drop. Called from turnOrchestrator at send time. */
export function recordLootDrop(
    result: LootDropResult,
    opts: ResolveLootOpts,
): void {
    const reweight = opts.profile?.reweight;
    const record: LootDropRecord = {
        resolvedAt: Date.now(),
        rolls: opts.rolls ?? 1,
        reweight: reweight ? JSON.parse(JSON.stringify(reweight)) : undefined,
        items: result.items,
        appendToInput: result.appendToInput,
        trace: result.trace,
        empty: result.items.length === 0,
    };
    history = [record, ...history].slice(0, MAX_HISTORY);
    emit();
}

export function clearLootDropHistory(): void {
    history = [];
    emit();
}

export function getLootDropHistory(): LootDropRecord[] {
    return history;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let snapshotRef: { history: LootDropRecord[] } = { history };

export function useLootDropHistory(): LootDropRecord[] {
    const snap = useSyncExternalStore(
        subscribe,
        () => snapshotRef,
        () => snapshotRef,
    );
    return snap.history;
}