import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store registers itself with the embedding scheduler at import time; stub
// it so importing the store has no side effects (mirrors useAppStore.wiring.test).
vi.mock('../../services/embedding/embeddingScheduler', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../services/embedding/embeddingScheduler')>();
    return { ...actual, registerStore: vi.fn() };
});

import { useAppStore } from '../useAppStore';
import type { ChatMessage } from '../../types';

describe('debugPayload retention cap (updateLastMessage)', () => {
    beforeEach(() => useAppStore.setState({ messages: [] }));

    it('retains debugPayload on only the most recent 10 messages', () => {
        for (let i = 0; i < 15; i++) {
            const msg: ChatMessage = { id: `m${i}`, role: 'assistant', content: `t${i}`, timestamp: i };
            useAppStore.getState().addMessage(msg);
            useAppStore.getState().updateLastMessage({ debugPayload: { turn: i } });
        }

        const msgs = useAppStore.getState().messages;
        const withPayload = msgs.filter(m => m.debugPayload !== undefined);

        expect(msgs).toHaveLength(15);              // no messages dropped
        expect(withPayload).toHaveLength(10);       // payloads capped
        expect(withPayload.map(m => m.id)).toEqual( // the recent 10, m5..m14
            Array.from({ length: 10 }, (_, k) => `m${k + 5}`),
        );
        // evicted messages keep their text, just lose the heavy payload
        expect(msgs.find(m => m.id === 'm0')?.content).toBe('t0');
        expect(msgs.find(m => m.id === 'm0')?.debugPayload).toBeUndefined();
    });

    it('does not touch payloads when the patch has no debugPayload', () => {
        useAppStore.setState({
            messages: [
                { id: 'a', role: 'assistant', content: 'x', timestamp: 0, debugPayload: { old: 1 } },
                { id: 'b', role: 'assistant', content: 'y', timestamp: 1 },
            ] as ChatMessage[],
        });
        useAppStore.getState().updateLastMessage({ content: 'updated' });

        const msgs = useAppStore.getState().messages;
        expect(msgs.find(m => m.id === 'a')?.debugPayload).toBeDefined();
        expect(msgs.find(m => m.id === 'b')?.content).toBe('updated');
    });
});
