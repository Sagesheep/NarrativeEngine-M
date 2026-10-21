import type { ChatMessage, PlayerNote } from '../types';
import { uid } from './uid';

const TITLE_MAX = 60;

function firstLine(text: string): string {
    const line = text.trim().split('\n').find(l => l.trim()) ?? '';
    const clean = line.replace(/^[#>*\-\s]+/, '').trim();
    return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX - 1) + '…' : clean;
}

export function makePlayerNote(title: string, body: string, sourceMessageId?: string): PlayerNote {
    const now = Date.now();
    return { id: uid(), title, body, createdAt: now, updatedAt: now, sourceMessageId };
}

/**
 * Build a note from a chat message. For a GM reply, the player's message just
 * before it is kept as the question, so an OOC Q&A reads as one note.
 */
export function noteFromMessage(msg: ChatMessage, messages: ChatMessage[]): PlayerNote {
    const text = (msg.displayContent || msg.content).trim();
    if (msg.role === 'assistant') {
        const idx = messages.findIndex(m => m.id === msg.id);
        const prev = idx > 0 ? messages.slice(0, idx).reverse().find(m => m.role === 'user') : undefined;
        const question = prev ? (prev.displayContent || prev.content).trim() : '';
        if (question) {
            const quoted = question.split('\n').map(l => `> ${l}`).join('\n');
            return makePlayerNote(firstLine(question), `${quoted}\n\n${text}`, msg.id);
        }
    }
    return makePlayerNote(firstLine(text), text, msg.id);
}
