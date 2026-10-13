import { describe, it, expect, vi } from 'vitest';
import { expandQuery, npcsNamedIn, recentSceneText } from '../stages/expandQueryStage';
import type { ChatMessage, NPCEntry } from '../../../types';
import type { UtilityLLM } from '../turnTypes';

const npc = (id: string, name: string, aliases = '') => ({ id, name, aliases }) as NPCEntry;
// The oldest ledger entries come first; the old prompt sent these ten regardless of the scene.
const ledger = [
    ...Array.from({ length: 10 }, (_, i) => npc(`old${i}`, `Ancient Person${i}`)),
    npc('n1', 'Rin Holmes'), npc('n2', 'Helena Broadmarsh', 'the Widow'), npc('n3', 'The Broker'),
];
const msg = (role: 'user' | 'assistant', content: string) => ({ id: content, role, content, timestamp: 0 }) as ChatMessage;

describe('npcsNamedIn', () => {
    it('finds full names, aliases and capitalised name words', () => {
        const found = npcsNamedIn('Rin glances at the widow.', ledger).map(n => n.id);
        expect(found).toEqual(['n1', 'n2']);
    });

    it('ignores title words that name nobody', () => {
        expect(npcsNamedIn('The guard nods.', ledger)).toEqual([]);
    });
});

describe('expandQuery', () => {
    it('sends the last exchange and only the NPCs named in it, with thinking off', async () => {
        const call = vi.fn().mockResolvedValue('["what Rin promised Helena", "Rin Holmes deal"]');
        const llm: UtilityLLM = { call, endpoint: () => undefined };
        const messages = [msg('user', 'old line'), msg('user', 'I ask Rin about it'), msg('assistant', 'Rin looks toward Helena Broadmarsh.')];

        const out = await expandQuery('what did she promise?', messages, ledger, llm);

        expect(out).toEqual(['what did she promise?', 'what Rin promised Helena', 'Rin Holmes deal']);
        const [prompt, opts] = call.mock.calls[0];
        expect(prompt).toContain('CHARACTERS IN THE RECENT SCENE: Rin Holmes, Helena Broadmarsh');
        expect(prompt).not.toContain('Ancient Person');
        expect(prompt).toContain('GM: Rin looks toward Helena Broadmarsh.');
        expect(prompt).not.toContain('old line');
        expect(opts).toMatchObject({ maxTokens: 200, thinkingEffort: 'off' });
    });

    it('returns the original query alone on a bad answer', async () => {
        const llm: UtilityLLM = { call: vi.fn().mockResolvedValue(''), endpoint: () => undefined };
        expect(await expandQuery('q', [], ledger, llm)).toEqual(['q']);
    });
});

describe('recentSceneText', () => {
    it('keeps only the last exchange', () => {
        const text = recentSceneText([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c'), msg('assistant', 'd')]);
        expect(text).toBe('PLAYER: c\n\nGM: d');
    });
});
