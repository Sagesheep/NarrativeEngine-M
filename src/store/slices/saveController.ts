/**
 * saveController — neutral landing zone for the campaign-state debounce
 * timer and its state-getter registration.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * Before this file, `debouncedSaveCampaignState` lived in campaignSlice.ts
 * and chatSlice.ts imported it from there. Meanwhile campaignSlice imports
 * a type from chatSlice for slice composition. The two arrows formed a
 * cycle:
 *
 *     campaignSlice ──type──→  chatSlice
 *     chatSlice     ──value──→  campaignSlice
 *
 * Hoisting the save helper out to a neutral module breaks the value
 * arrow without touching the type arrow. Now:
 *
 *     campaignSlice ──type──→  chatSlice        (kept; type-only, safe)
 *     chatSlice     ──value──→  saveController  (this file)
 *     campaignSlice ──value──→  saveController  (this file)
 *
 * No cycle.
 *
 * ── Layer rule ──────────────────────────────────────────────────────────
 *   store/slices/* may import this module  ✓
 *   This module must NOT import any slice  (would re-create the cycle)
 *   It may import ports/ (notify) and lazily import campaignStore (for
 *   the actual save), keeping the cold-path dynamic.
 */

import type { GameContext, ChatMessage, CondenserState, PinnedExcerpt } from '../../types';
import { notify } from '../../ports/notification';

export interface CampaignSavePayload {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    pinnedExcerpts?: PinnedExcerpt[];
}

/**
 * Optional override for harvesting the freshest state from the live store
 * at save-fire time. Registered by the slice that owns the canonical
 * context+messages, so the debounced save always picks up edits made
 * after the original `debouncedSaveCampaignState` call.
 */
type StateGetter = () => CampaignSavePayload;
let _getStateForSave: StateGetter | null = null;

let stateTimer: ReturnType<typeof setTimeout> | null = null;

export function debouncedSaveCampaignState(
    campaignId: string | null,
    fallbackState: CampaignSavePayload,
): void {
    if (!campaignId) return;
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(async () => {
        // Prefer the registered live getter (always up-to-date); fall back
        // to the snapshot passed in at call time. The getter is the source
        // of truth — the fallback exists for legacy callers and tests.
        const state = _getStateForSave ? _getStateForSave() : fallbackState;
        try {
            const { saveCampaignState } = await import('../campaignStore');
            await saveCampaignState(campaignId, state);
        } catch (e) {
            console.error(e);
            notify.error('Failed to save campaign state');
        }
    }, 1000);
}

export function registerCampaignStateGetter(getter: StateGetter): void {
    _getStateForSave = getter;
}
