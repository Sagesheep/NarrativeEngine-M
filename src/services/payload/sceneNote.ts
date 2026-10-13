import type { ApiFormat, GameContext, SceneNoteRole } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';

/**
 * Scene Note — mobile's one prompt injection (ST's "author's note").
 *
 * The player's note is placed as a message at a chosen depth in the request:
 * depth 0 follows the latest message, depth 1 precedes it, deeper counts back
 * through player/GM messages (the leading system blocks and tool exchanges are
 * not counted). Placement rules follow mainApp's prompt injections
 * (services/payload/promptInjections.ts), reduced to a single note.
 *
 * Roles:
 * - system / user: an instruction, sent with the [SCENE NOTE] label.
 * - assistant: the text as-is, as the GM speaking. At depth 0 it is the last
 *   message, which most backends treat as a prefill the reply continues from.
 * - thinking: a reasoning prefill (`<think>` + text), always last; depth is
 *   ignored. The reply then starts mid-reasoning, so restoreThinkingPrefill puts
 *   the prefix back for display and history.
 * Prefill support depends on the model/backend (Claude rejects it with thinking on).
 *
 * Applied only to the outgoing story request (reply, retry, swipe), never to
 * the cached payload or the saved chat, so an edit takes effect on the very
 * next request. buildPayload reserves its tokens.
 */

export const SCENE_NOTE_LABEL = '[SCENE NOTE: VOLATILE GUIDANCE]';
export const SCENE_NOTE_DEFAULT_DEPTH = 3;
export const SCENE_NOTE_MAX_DEPTH = 20;
export const SCENE_NOTE_ROLES: { value: SceneNoteRole; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'user', label: 'User' },
    { value: 'assistant', label: 'Assistant' },
    { value: 'thinking', label: 'Thinking' },
];

export type SceneNoteInput = Pick<GameContext, 'sceneNote' | 'sceneNoteActive' | 'sceneNoteDepth' | 'sceneNoteRole'>;

export function normalizeSceneNoteRole(v: unknown): SceneNoteRole {
    return SCENE_NOTE_ROLES.some(r => r.value === v) ? (v as SceneNoteRole) : 'system';
}

/** The note's content as sent, or '' when it is off or empty. */
export function sceneNoteText(note: Partial<SceneNoteInput> | null | undefined): string {
    const text = note?.sceneNoteActive ? (note.sceneNote ?? '').trim() : '';
    if (!text) return '';
    switch (normalizeSceneNoteRole(note?.sceneNoteRole)) {
        case 'assistant': return text;
        case 'thinking': return `<think>\n${text}`;
        default: return `${SCENE_NOTE_LABEL}\n${text}`;
    }
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
 * field, which would lift the note to the top, so a System note goes to them as
 * a labelled user message that keeps its position.
 */
export function applySceneNote(
    messages: readonly OpenAIMessage[],
    note: Partial<SceneNoteInput> | null | undefined,
    format: ApiFormat,
): OpenAIMessage[] {
    const text = sceneNoteText(note);
    if (!text) return [...messages];
    const role = normalizeSceneNoteRole(note?.sceneNoteRole);

    let prefixEnd = 0;
    while (prefixEnd < messages.length && messages[prefixEnd].role === 'system') prefixEnd++;
    const anchors = messages.flatMap((m, i) =>
        i >= prefixEnd && (m.role === 'user' || m.role === 'assistant') && !(m as { tool_calls?: unknown[] }).tool_calls?.length ? [i] : []);

    // A reasoning prefill only works as the very last message.
    const depth = role === 'thinking' ? 0 : Math.min(clampDepth(note?.sceneNoteDepth), anchors.length);
    let index = depth === 0 ? messages.length : anchors[anchors.length - depth];
    // Never split a tool exchange.
    while (index > prefixEnd && messages[index]?.role === 'tool') index--;

    let noteMessage: OpenAIMessage;
    if (role === 'system' && (format === 'claude' || format === 'gemini')) {
        noteMessage = { role: 'user', content: `[System instruction]\n${text}` } as OpenAIMessage;
    } else {
        noteMessage = { role: role === 'thinking' ? 'assistant' : role, content: text } as OpenAIMessage;
    }

    return [...messages.slice(0, index), noteMessage, ...messages.slice(index)];
}

/**
 * With a Thinking note the model continues from inside `<think>`, so its reply
 * starts mid-reasoning with no opening tag. Put the sent prefix back so the
 * reasoning is recognised (hidden in the bubble, stripped from history) instead
 * of showing up as story text. Only when the reply closes the reasoning
 * (`</think>`): while streaming that may not have arrived yet, and a model that
 * ignored the prefill must not get a stray `<think>` glued to its story. Other
 * roles and replies that open their own `<think>` are returned unchanged.
 */
export function restoreThinkingPrefill(reply: string, note: Partial<SceneNoteInput> | null | undefined): string {
    if (normalizeSceneNoteRole(note?.sceneNoteRole) !== 'thinking') return reply;
    const prefix = sceneNoteText(note);
    if (!prefix || !reply || /^\s*<think>/i.test(reply) || !/<\/think>/i.test(reply)) return reply;
    return prefix + reply;
}
