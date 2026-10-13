import type { ApiFormat, GameContext } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';

/**
 * Scene Note — mobile's one prompt injection (ST's "author's note").
 *
 * The player's note is placed as a message at a chosen depth in the request:
 * depth 0 follows the latest message, depth 1 precedes it, deeper counts back
 * through player/GM messages (the leading system blocks and tool exchanges are
 * not counted). Placement rules follow mainApp's prompt injections
 * (services/payload/promptInjections.ts), reduced to a single system note.
 *
 * Applied only to the outgoing story request (reply, retry, swipe), never to
 * the cached payload or the saved chat, so an edit takes effect on the very
 * next request. buildPayload reserves its tokens.
 */

export const SCENE_NOTE_LABEL = '[SCENE NOTE: VOLATILE GUIDANCE]';
export const SCENE_NOTE_DEFAULT_DEPTH = 3;
export const SCENE_NOTE_MAX_DEPTH = 20;

export type SceneNoteInput = Pick<GameContext, 'sceneNote' | 'sceneNoteActive' | 'sceneNoteDepth'>;

/** The note's text as sent, or '' when it is off or empty. */
export function sceneNoteText(note: Partial<SceneNoteInput> | null | undefined): string {
    const text = note?.sceneNoteActive ? (note.sceneNote ?? '').trim() : '';
    return text ? `${SCENE_NOTE_LABEL}\n${text}` : '';
}

/** Tokens to reserve for the note when fitting history (+8 for message overhead). */
export function sceneNoteTokens(note: Partial<SceneNoteInput> | null | undefined): number {
    const text = sceneNoteText(note);
    return text ? countTokens(text) + 8 : 0;
}

function clampDepth(depth: unknown): number {
    const n = typeof depth === 'number' && Number.isFinite(depth) ? Math.floor(depth) : SCENE_NOTE_DEFAULT_DEPTH;
    return Math.min(SCENE_NOTE_MAX_DEPTH, Math.max(0, n));
}

/**
 * Returns a new message list with the note inserted at its depth; the input is
 * not mutated. Claude and Gemini move system messages into a separate system
 * field, which would lift the note to the top, so for them it is sent as a
 * labelled user message that keeps its position.
 */
export function applySceneNote(
    messages: readonly OpenAIMessage[],
    note: Partial<SceneNoteInput> | null | undefined,
    format: ApiFormat,
): OpenAIMessage[] {
    const text = sceneNoteText(note);
    if (!text) return [...messages];

    let prefixEnd = 0;
    while (prefixEnd < messages.length && messages[prefixEnd].role === 'system') prefixEnd++;
    const anchors = messages.flatMap((m, i) =>
        i >= prefixEnd && (m.role === 'user' || m.role === 'assistant') && !(m as { tool_calls?: unknown[] }).tool_calls?.length ? [i] : []);

    const depth = Math.min(clampDepth(note?.sceneNoteDepth), anchors.length);
    let index = depth === 0 ? messages.length : anchors[anchors.length - depth];
    // Never split a tool exchange.
    while (index > prefixEnd && messages[index]?.role === 'tool') index--;

    const nativeSystemFallback = format === 'claude' || format === 'gemini';
    const noteMessage = (nativeSystemFallback
        ? { role: 'user', content: `[System instruction]\n${text}` }
        : { role: 'system', content: text }) as OpenAIMessage;

    return [...messages.slice(0, index), noteMessage, ...messages.slice(index)];
}
