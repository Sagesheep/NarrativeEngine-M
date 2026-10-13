import { describe, it, expect } from 'vitest';
import { applySceneNote, sceneNoteText, restoreThinkingPrefill, SCENE_NOTE_LABEL } from '../sceneNote';
import type { SceneNoteRole } from '../../../types';
import { buildPayload } from '../payloadBuilder';
import { defaultContext } from '../../../store/slices/campaignSlice';
import { defaultSettings } from '../../../store/settingsMigration';
import type { OpenAIMessage } from '../../llm/llmService';

const msgs: OpenAIMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'system', content: 'facts' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'final' },
];
const note = (depth: number, active = true) => ({ sceneNote: 'Keep it explicit.', sceneNoteActive: active, sceneNoteDepth: depth });
const contents = (ms: OpenAIMessage[]) => ms.map(m => String(m.content));

describe('applySceneNote', () => {
    it('depth 0 goes after the latest message; depth 1 right before it', () => {
        expect(contents(applySceneNote(msgs, note(0), 'openai')).slice(-2)).toEqual(['final', `${SCENE_NOTE_LABEL}\nKeep it explicit.`]);
        expect(contents(applySceneNote(msgs, note(1), 'openai')).slice(-2)).toEqual([`${SCENE_NOTE_LABEL}\nKeep it explicit.`, 'final']);
    });

    it('depth 3 counts back through player and GM messages, never into the system block', () => {
        const out = applySceneNote(msgs, note(3), 'openai');
        expect(contents(out).indexOf(`${SCENE_NOTE_LABEL}\nKeep it explicit.`)).toBe(4);
        const deep = applySceneNote(msgs, note(20), 'openai');
        expect(deep[2].content).toBe(`${SCENE_NOTE_LABEL}\nKeep it explicit.`);
        expect(deep[0].content).toBe('rules');
    });

    it('is a system message for OpenAI-style APIs and a labelled user message for Claude and Gemini', () => {
        expect(applySceneNote(msgs, note(1), 'openai')[6]).toMatchObject({ role: 'system' });
        for (const format of ['claude', 'gemini'] as const) {
            const placed = applySceneNote(msgs, note(1), format)[6];
            expect(placed.role).toBe('user');
            expect(String(placed.content).startsWith('[System instruction]\n')).toBe(true);
        }
    });

    it('does nothing when off or empty, and never mutates the input', () => {
        expect(applySceneNote(msgs, note(1, false), 'openai')).toEqual(msgs);
        expect(sceneNoteText({ sceneNote: '   ', sceneNoteActive: true })).toBe('');
        const before = [...msgs];
        applySceneNote(msgs, note(1), 'openai');
        expect(msgs).toEqual(before);
    });

    it('never splits a tool exchange', () => {
        const withTool: OpenAIMessage[] = [
            ...msgs.slice(0, 6),
            { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'x', arguments: '{}' } }] } as OpenAIMessage,
            { role: 'tool', content: 'result', tool_call_id: 't' } as OpenAIMessage,
            { role: 'user', content: 'final' },
        ];
        for (const depth of [0, 1, 2, 3]) {
            const out = applySceneNote(withTool, note(depth), 'openai');
            const call = out.findIndex(m => (m as { tool_calls?: unknown[] }).tool_calls?.length);
            expect(out[call + 1].role).toBe('tool');
        }
    });
});

describe('Scene Note roles', () => {
    const withRole = (role: SceneNoteRole, depth = 1) => ({ ...note(depth), sceneNoteRole: role });

    it('User keeps the label and its depth; it is not converted for Claude', () => {
        const placed = applySceneNote(msgs, withRole('user'), 'claude')[6];
        expect(placed).toEqual({ role: 'user', content: `${SCENE_NOTE_LABEL}\nKeep it explicit.` });
    });

    it('Assistant sends the text as-is; at depth 0 it is the last message (a prefill)', () => {
        const out = applySceneNote(msgs, withRole('assistant', 0), 'openai');
        expect(out[out.length - 1]).toEqual({ role: 'assistant', content: 'Keep it explicit.' });
        expect(applySceneNote(msgs, withRole('assistant', 2), 'openai')[5]).toEqual({ role: 'assistant', content: 'Keep it explicit.' });
    });

    it('Thinking is a <think> prefill, always last whatever the depth', () => {
        const out = applySceneNote(msgs, withRole('thinking', 7), 'openai');
        expect(out[out.length - 1]).toEqual({ role: 'assistant', content: '<think>\nKeep it explicit.' });
    });

    it('an unknown role falls back to System', () => {
        expect(applySceneNote(msgs, { ...note(1), sceneNoteRole: 'narrator' as never }, 'openai')[6].role).toBe('system');
    });
});

describe('restoreThinkingPrefill', () => {
    const thinking = { ...note(0), sceneNoteRole: 'thinking' as const };

    it('puts the sent <think> prefix back once the reply closes its reasoning', () => {
        expect(restoreThinkingPrefill(' so she lies.</think>The guard nods.', thinking))
            .toBe('<think>\nKeep it explicit. so she lies.</think>The guard nods.');
    });

    it('leaves the reply alone while reasoning is still streaming, when the model ignored the prefill, or for other roles', () => {
        expect(restoreThinkingPrefill(' so she lies', thinking)).toBe(' so she lies');
        expect(restoreThinkingPrefill('The guard nods.', thinking)).toBe('The guard nods.');
        expect(restoreThinkingPrefill('<think>own</think>Story', thinking)).toBe('<think>own</think>Story');
        expect(restoreThinkingPrefill('x</think>y', { ...note(0), sceneNoteRole: 'assistant' })).toBe('x</think>y');
    });
});

describe('Scene Note and the cached payload', () => {
    it('is no longer folded into the final message, and is not in the payload at all', () => {
        const { messages } = buildPayload({
            settings: { ...defaultSettings, contextLimit: 8192 },
            context: { ...defaultContext, sceneNote: 'Keep it explicit.', sceneNoteActive: true, sceneNoteDepth: 2 },
            history: [],
            userMessage: 'I open the door.',
        });
        expect(messages.some(m => String(m.content).includes('Keep it explicit.'))).toBe(false);
    });
});
