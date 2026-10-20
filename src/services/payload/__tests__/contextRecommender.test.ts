import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, LLMProvider, LoreChunk, NPCEntry } from '../../../types';

vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../../utils/llmCall';
import { recommendContext, parseRecommendedNPCs, buildConversationExcerpt } from '../contextRecommender';

const mockLlmCall = vi.mocked(llmCall);

const npc = (id: string, name: string, extra: Partial<NPCEntry> = {}): NPCEntry => ({
    id, name, aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '',
    status: 'Alive', goals: '', voice: '', personality: '', exampleOutput: '', affinity: 0,
    tier: 'recurring', ...extra,
} as NPCEntry);

const ledger = [npc('a1', 'Mara', { aliases: 'The Fox' }), npc('b2', 'Tom'), npc('c3', 'Ilse')];
const handles = new Map([['N1', ledger[0]], ['N2', ledger[1]], ['N3', ledger[2]]]);
const provider = { endpoint: 'http://x', modelName: 'deepseek' } as LLMProvider;
const lore = [{ id: 'l1', header: 'Harbor', category: 'location', content: 'x', tokens: 5 } as LoreChunk];

describe('parseRecommendedNPCs', () => {
    it('resolves handles to names and keeps valid detail levels', () => {
        const r = parseRecommendedNPCs([{ id: 'N1', detail: 'full' }, { id: 'n2', detail: 'Brief' }], handles, ledger);
        expect(r.names).toEqual(['Mara', 'Tom']);
        expect(r.detail).toEqual({ a1: 'full', b2: 'brief' });
    });

    it('accepts the legacy plain-name form (no detail levels)', () => {
        const r = parseRecommendedNPCs(['Mara', 'Tom'], handles, ledger);
        expect(r.names).toEqual(['Mara', 'Tom']);
        expect(r.detail).toEqual({});
    });

    it('resolves names and aliases inside the object form', () => {
        const r = parseRecommendedNPCs([{ name: 'the fox', detail: 'brief' }], handles, ledger);
        expect(r.names).toEqual(['Mara']);
        expect(r.detail).toEqual({ a1: 'brief' });
    });

    it('drops an invalid level but keeps the NPC selected', () => {
        const r = parseRecommendedNPCs([{ id: 'N3', detail: 'medium' }, { id: 'N2' }], handles, ledger);
        expect(r.names).toEqual(['Ilse', 'Tom']);
        expect(r.detail).toEqual({});
    });

    it('drops unknown handles in object form, passes unknown strings through', () => {
        const r = parseRecommendedNPCs([{ id: 'N99', detail: 'full' }, 'Stranger', 42, null, { id: '' }], handles, ledger);
        expect(r.names).toEqual(['Stranger']);
        expect(r.detail).toEqual({});
    });

    it('a duplicate pick never downgrades full to brief', () => {
        const r = parseRecommendedNPCs([{ id: 'N1', detail: 'full' }, { name: 'Mara', detail: 'brief' }], handles, ledger);
        expect(r.names).toEqual(['Mara']);
        expect(r.detail).toEqual({ a1: 'full' });
    });

    it('non-array input yields nothing', () => {
        expect(parseRecommendedNPCs({ N1: 'full' }, handles, ledger)).toEqual({ names: [], detail: {} });
    });
});

describe('buildConversationExcerpt', () => {
    it('keeps the ending of the latest GM reply, still truncates older messages', () => {
        const older = { id: '1', role: 'assistant', content: 'O'.repeat(500) } as ChatMessage;
        const latest = { id: '2', role: 'assistant', content: 'H'.repeat(400) + 'M'.repeat(400) + 'END_OF_SCENE' } as ChatMessage;
        const out = buildConversationExcerpt([older, latest], 'I wave.');
        expect(out).toContain('O'.repeat(300) + '\n');
        expect(out).not.toContain('O'.repeat(301));
        expect(out).toContain('END_OF_SCENE');
        expect(out).toContain('[PLAYER]: I wave.');
    });
});

describe('recommendContext', () => {
    beforeEach(() => mockLlmCall.mockReset());

    it('sends handles and presence, and returns names, detail and lore', async () => {
        mockLlmCall.mockResolvedValue('{"npcs":[{"id":"N1","detail":"full"},{"id":"N3","detail":"brief"}],"lore":["l1"]}');
        const r = await recommendContext(provider, ledger, lore, [], 'Hello', undefined, undefined, ['c3']);
        const prompt = String(mockLlmCall.mock.calls[0][1]);
        expect(prompt).toContain('N1: Mara (aka The Fox)');
        expect(prompt).toContain('N3: Ilse — Alive [recurring] [present]');
        expect(prompt).not.toContain('Tom — Alive [recurring] [present]');
        expect(r).toEqual({ relevantNPCNames: ['Mara', 'Ilse'], relevantLoreIds: ['l1'], npcDetail: { a1: 'full', c3: 'brief' } });
    });

    it('still handles the legacy response shape', async () => {
        mockLlmCall.mockResolvedValue('```json\n{"npcs":["Tom"],"lore":["l1"]}\n```');
        const r = await recommendContext(provider, ledger, lore, [], 'Hello');
        expect(r).toEqual({ relevantNPCNames: ['Tom'], relevantLoreIds: ['l1'], npcDetail: {} });
    });

    it('throws on a response with no JSON (caller falls back)', async () => {
        mockLlmCall.mockResolvedValue('Sorry, I cannot help with that.');
        await expect(recommendContext(provider, ledger, lore, [], 'Hello')).rejects.toThrow();
    });
});
