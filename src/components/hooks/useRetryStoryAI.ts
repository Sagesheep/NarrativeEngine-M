import { useState, useCallback, useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { generateSwipeVariant, SWIPE_BASE_TEMP_OFFSET, computeSwipeTemperature } from '../../services/turn/swipeGeneration';
import { getCachedSwipePayload } from '../../services/turn/pendingCommit';
import type { ChatMessage } from '../../types';
import type { OpenAIMessage } from '../../services/llm/llmService';
import { toast } from '../Toast';

// Smart Retry v1: re-enter the story AI with the cached precontext, bypassing
// gatherContext. Reuses the same `generateSwipeVariant` primitive as swipes 2–5
// (consistent payload sanitization, scene-stakes parsing, abort handling).
//
// Differences from `useSwipeVariants.generateSwipe`:
//   1. Replaces the failed bubble's content in place (does NOT append a slot).
//   2. On success, stamps variant 0 + pendingCommit (swipe-style), so the
//      success path unifies with the existing swipe-browse UI.
//   3. Optional `newPromptText` splices the player-authored prefix in the
//      cached payload's user-message slot, preserving engine appendages
//      ([RESOLVED ROLL — …], loot block, dice-fairness, intro tag) per
//      Fable 5 finding 5. Used by the soft-edit path (work item 7).
//   4. Clears `retryable` on success so the Retry button disappears.
//
// v1 known limitation (Fable 5 finding 6): `generateSwipeVariant` hard-codes
// `allowTools=false` + appends `SWIPE_SYSTEM_LINE` ("narrate only from results
// already in history"). For a fresh retry after a pre-tool failure there are
// no tool results in history, so the retried turn can't roll dice or query
// lore, and the SWIPE_SYSTEM_LINE is mildly misleading. Documented in §7 of
// the plan; revisit in a follow-up.

const ENGINE_TAG_PATTERNS: RegExp[] = [
    /\n\[RESOLVED ROLL — /,
    /\n\[LOOT DROP: /,
    /\n\[DICE FAIRNESS/i,
    /\n\[CHARACTER INTRO/i,
];

// Splice only the player-authored prefix in the cached payload's user slot,
// preserving engine appendages (newline-delimited bracketed tags). Returns
// the patched payload (does NOT mutate the input — the cache is shared).
function patchUserPromptInPayload(payload: OpenAIMessage[], newPromptText: string): OpenAIMessage[] {
    // Find the last user message in the payload (the turn's prompt).
    let lastUserIdx = -1;
    for (let i = payload.length - 1; i >= 0; i--) {
        if (payload[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return payload;

    const original = payload[lastUserIdx].content;
    if (typeof original !== 'string') return payload;

    // Find the earliest engine tag start position — everything before it is
    // the player-authored prefix; everything from there on is engine output
    // we must preserve.
    let splitIdx = original.length;
    for (const pat of ENGINE_TAG_PATTERNS) {
        const m = original.match(pat);
        if (m && m.index !== undefined && m.index < splitIdx) splitIdx = m.index;
    }
    const engineSuffix = original.slice(splitIdx);
    const patchedContent = newPromptText.trim() + engineSuffix;

    const patched = [...payload];
    patched[lastUserIdx] = { ...patched[lastUserIdx], content: patchedContent };
    return patched;
}

export function useRetryStoryAI() {
    const [retryLoading, setRetryLoading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    const retryStoryAI = useCallback(async (
        messageId: string,
        newPromptText?: string,
    ): Promise<void> => {
        if (retryLoading) return;
        const store = useAppStore.getState();
        const msg = store.messages.find(m => m.id === messageId);
        if (!msg || !msg.retryable) return;

        const provider = store.getActiveStoryEndpoint();
        if (!provider) {
            toast.error('No Story AI configured.');
            return;
        }

        let cachedPayload = getCachedSwipePayload();
        if (!cachedPayload) {
            toast.error('Context lost — send a new message to regenerate.');
            return;
        }

        // Soft-edit: splice the new prompt text into the cached payload,
        // preserving engine appendages. Also update the live user message so
        // the chat reflects the edit (displayContent stays as-is — the reveal
        // text is separate from the prompt the model sees).
        if (newPromptText !== undefined) {
            cachedPayload = patchUserPromptInPayload(cachedPayload, newPromptText);
            // Patch the live user message content (find the user msg paired
            // with this assistant bubble — the latest user msg before it).
            const msgs = store.messages;
            const assistantIdx = msgs.findIndex(m => m.id === messageId);
            if (assistantIdx !== -1) {
                for (let i = assistantIdx - 1; i >= 0; i--) {
                    if (msgs[i].role === 'user') {
                        useAppStore.getState().updateMessageContent(msgs[i].id, newPromptText.trim());
                        break;
                    }
                }
            }
        }

        const updateStore = (patch: Partial<ChatMessage>) => {
            const s = useAppStore.getState();
            const idx = s.messages.findIndex(m => m.id === messageId);
            if (idx === -1) return;
            const updated = [...s.messages];
            updated[idx] = { ...updated[idx], ...patch } as ChatMessage;
            useAppStore.setState({ messages: updated });
        };

        // Clear the retryable flag + partial error text — we're regenerating.
        updateStore({
            retryable: undefined,
            content: '',
            displayContent: '',
            reasoning_content: undefined,
        });

        setRetryLoading(true);
        abortRef.current = new AbortController();
        const abortSignal = abortRef.current.signal;

        try {
            const activePreset = store.settings.presets.find(p => p.id === store.settings.activePresetId);
            const baseTemp = activePreset?.sampling?.temperature;
            const temperature = computeSwipeTemperature(baseTemp, SWIPE_BASE_TEMP_OFFSET);

            const { variant } = await generateSwipeVariant(
                {
                    provider,
                    cachedPayload,
                    modelName: provider.modelName,
                    temperature,
                    abortSignal,
                },
                (chunk) => {
                    if (abortSignal.aborted) return;
                    const s = useAppStore.getState();
                    const idx = s.messages.findIndex(m => m.id === messageId);
                    if (idx === -1) return;
                    const updated = [...s.messages];
                    updated[idx] = {
                        ...s.messages[idx],
                        content: chunk,
                        displayContent: chunk,
                    };
                    useAppStore.setState({ messages: updated });
                },
            );

            if (abortSignal.aborted) return;

            // Success: stamp variant 0 + pendingCommit (unify with swipe UI).
            // precontext stays so the box remains visible; retryable is cleared.
            const fresh = useAppStore.getState();
            const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
            if (freshIdx === -1) return;
            const updated = [...fresh.messages];
            updated[freshIdx] = {
                ...fresh.messages[freshIdx],
                content: variant.text,
                displayContent: variant.text,
                reasoning_content: variant.reasoningContent,
                swipeSet: [variant],
                pendingCommit: true,
                swipeActiveIndex: 0,
                retryable: undefined,
            };
            useAppStore.setState({ messages: updated });
            import('../../store/campaignStore').then(m => m.saveCampaignState(fresh.activeCampaignId!, {
                context: fresh.context,
                messages: updated,
                condenser: fresh.condenser,
                pinnedExcerpts: fresh.pinnedExcerpts,
            })).catch(e => console.warn('[Retry] saveCampaignState failed:', e));
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            if (err instanceof Error && err.message === '__ABORT__') return;
            console.warn('[Retry] generation failed:', err);
            // Re-stamp retryable so the user can try again.
            updateStore({ retryable: true });
            toast.error('Retry failed — try again.');
        } finally {
            setRetryLoading(false);
            abortRef.current = null;
        }
    }, [retryLoading]);

    const abortRetry = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    return { retryStoryAI, retryLoading, abortRetry };
}