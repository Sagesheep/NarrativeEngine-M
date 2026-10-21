import { describe, it, expect } from 'vitest';
import { noteFromMessage } from '../playerNotes';
import type { ChatMessage } from '../../types';

const m = (id: string, role: ChatMessage['role'], content: string): ChatMessage =>
    ({ id, role, content, timestamp: 0 }) as ChatMessage;

describe('noteFromMessage', () => {
    it('keeps the player question with a GM reply', () => {
        const msgs = [
            m('1', 'user', 'OOC: how does stealth work here?'),
            m('2', 'assistant', 'Roll DEX vs the watcher.'),
        ];
        const note = noteFromMessage(msgs[1], msgs);
        expect(note.title).toBe('OOC: how does stealth work here?');
        expect(note.body).toBe('> OOC: how does stealth work here?\n\nRoll DEX vs the watcher.');
        expect(note.sourceMessageId).toBe('2');
    });

    it('saves a lone message as-is with a trimmed title', () => {
        const long = 'x'.repeat(100);
        const note = noteFromMessage(m('1', 'assistant', long), [m('1', 'assistant', long)]);
        expect(note.body).toBe(long);
        expect(note.title.length).toBe(60);
    });
});
