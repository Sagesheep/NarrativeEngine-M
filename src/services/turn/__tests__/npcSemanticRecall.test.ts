import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, NPCEntry } from '../../../types';

const h = vi.hoisted(() => ({ semanticSearch: vi.fn() }));
vi.mock('../../embedding', () => ({
    semanticSearch: h.semanticSearch,
    isEmbedderReady: () => true,
}));

import { recallNpcsSemantically } from '../stages/npcSemanticRecallStage';

const npcLedger = [{ id: 'n1', name: 'Wen Huang' }] as NPCEntry[];
const msg = (role: ChatMessage['role'], content: string): ChatMessage =>
    ({ id: Math.random().toString(36), role, content, timestamp: 0 }) as ChatMessage;

beforeEach(() => {
    h.semanticSearch.mockReset();
    h.semanticSearch.mockResolvedValue(['n1']);
});

describe('recallNpcsSemantically — what it embeds', () => {
    it("puts the player's message first, keeps the tail of long messages, skips scene markers", async () => {
        const longReply = 'a'.repeat(1000) + 'b'.repeat(1500);
        const freshMessages = [
            msg('user', 'I open the door.'),
            msg('assistant', longReply),
            msg('system', 'Scene 049'),
        ];

        const hits = await recallNpcsSemantically({ activeCampaignId: 'c', npcLedger, freshMessages, finalInput: 'Who is there?' });

        expect(hits).toEqual(['n1']);
        const queries = h.semanticSearch.mock.calls[0][1] as string[];
        expect(queries[0]).toBe('Who is there?');
        expect(queries).toContain('I open the door.');
        expect(queries).toContain('b'.repeat(1500));      // last 1500 chars of the GM reply
        expect(queries).not.toContain('Scene 049');
        expect(queries.length).toBeLessThanOrEqual(4);
    });
});
