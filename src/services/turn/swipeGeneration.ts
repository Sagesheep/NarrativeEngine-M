import type { LLMProvider, SamplingConfig, SwipeVariant } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessage } from '../chatEngine';
import { sanitizePayloadForApi } from '../llm/payloadSanitizer';
import { extractAndStripSceneStakes } from './sceneStakesTag';
import { uid } from '../../utils/uid';
import { applySceneNote, restoreThinkingPrefill, type SceneNoteInput } from '../payload/sceneNote';
import { getApiFormat } from '../../utils/llmApiHelper';

export const MAX_SWIPES = 5;
export const SWIPE_BASE_TEMP_OFFSET = 0.1;

// System line appended to swipe generations (swipes 2–5) per the contract.
export const SWIPE_SYSTEM_LINE =
    'Do not initiate or invent dice rolls or lore lookups; narrate only from results already in history.';

export interface SwipeGenerationOptions {
    provider: LLMProvider;
    cachedPayload: OpenAIMessage[];     // final completion callback's currentPayload (with tool history)
    modelName?: string;
    temperature: number;                // slider value (base + offset)
    abortSignal?: AbortSignal;
    /** Optional user guidance for this variant (e.g. "make it darker", "add more dialogue"). */
    guidance?: string;
    /** The campaign's Scene Note, read live so an edit applies to the next swipe. */
    sceneNote?: SceneNoteInput;
    timeoutSeconds?: number;
}

export interface SwipeGenerationResult {
    variant: SwipeVariant;
}

// ── generateSwipeVariant ───────────────────────────────────────────────
// Lazy: one variant at a time. Swipes 2–5 always send tools: undefined and
// sanitize the payload with allowTools=false. The system line is appended.
// If the user typed guidance, it's appended as an additional system message.
export function generateSwipeVariant(
    opts: SwipeGenerationOptions,
    onChunk: (text: string) => void,
): Promise<SwipeGenerationResult> {
    const { provider, cachedPayload, modelName, temperature, abortSignal, guidance, sceneNote } = opts;

    // Sanitize with allowTools=false (swipes 2–5 never get tools).
    const sanitized = sanitizePayloadForApi(cachedPayload, false, modelName);

    // Build the tail system messages: the no-tools line, then optional guidance.
    const tailMessages: OpenAIMessage[] = [
        { role: 'system', content: SWIPE_SYSTEM_LINE },
    ];
    if (guidance && guidance.trim()) {
        tailMessages.push({
            role: 'system',
            content: `Player guidance for this variant: ${guidance.trim()}`,
        });
    }

    // Place the Scene Note after the tail: depth counts only player/GM messages, so
    // depth N lands where it would on a reply, and a prefill (Assistant at depth 0,
    // Thinking) stays the very last message.
    const withSystemLine: OpenAIMessage[] = applySceneNote([...sanitized, ...tailMessages], sceneNote, getApiFormat(provider));

    const sampling: SamplingConfig = { temperature };

    return new Promise<SwipeGenerationResult>((resolve, reject) => {
        const controller = new AbortController();
        if (abortSignal) {
            if (abortSignal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            abortSignal.addEventListener('abort', () => controller.abort());
        }

        let reasoningContent = '';

        sendMessage(
            provider,
            withSystemLine,
            (chunk) => {
                onChunk(restoreThinkingPrefill(chunk, sceneNote));
            },
            (rawFinalText, _toolCall, reasoning) => {
                const finalText = restoreThinkingPrefill(rawFinalText, sceneNote);
                // Swipes never accept tool calls (tools: undefined) — ignore.
                reasoningContent = reasoning ?? '';
                const { displayText, stakes } = extractAndStripSceneStakes(finalText);
                const tagPresent = finalText !== displayText || stakes !== 'calm';
                const variant: SwipeVariant = {
                    id: uid(),
                    text: displayText,
                    reasoningContent: reasoningContent || undefined,
                    sceneStakes: stakes,
                    tagPresent,
                };
                resolve({ variant });
            },
            (err) => {
                if (err === '__ABORT__' || err === 'AbortError' || err === 'The user aborted a request.') {
                    reject(new DOMException('Aborted', 'AbortError'));
                    return;
                }
                reject(new Error(err));
            },
            undefined,                       // tools: undefined (swipes 2–5)
            controller,
            sampling,
            opts.timeoutSeconds,
        );
    });
}

// ── Compute the swipe temperature ──────────────────────────────────────
// Opens at base + 0.1. If the user drags the slider, the offset is
// remembered for the rest of the browse session, reset on commit.
export function computeSwipeTemperature(baseTemp: number | undefined, sessionOffset: number): number {
    const base = baseTemp ?? 0.7;
    return Math.max(0, Math.min(2, base + sessionOffset));
}
