import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveIndexEntry, LLMProvider } from '../../../types';

const mockLlmCall = vi.fn();
vi.mock('../../../utils/llmCall', () => ({ llmCall: (...args: unknown[]) => mockLlmCall(...args) }));

import { rerankCandidates, type RerankCandidate } from '../semanticReranker';
import { sceneRerankSummary } from '../../turn/stages/rerankStage';

const endpoint: LLMProvider = { id: 'u', label: 'u', endpoint: 'http://x', apiKey: '', modelName: 'm' };
const scenes: RerankCandidate[] = ['001', '062', '120', '534', '600', '777'].map(id => ({ id, summary: `scene ${id}`, type: 'scene' }));

describe('rerankCandidates id parsing', () => {
    beforeEach(() => mockLlmCall.mockReset());

    it('asks with thinking off', async () => {
        mockLlmCall.mockResolvedValue('["534"]');
        await rerankCandidates('q', scenes, endpoint);
        expect(mockLlmCall.mock.calls[0][2]).toMatchObject({ maxTokens: 500, thinkingEffort: 'off' });
    });

    it('reads bare numbers with leading zeros instead of dropping the whole answer', async () => {
        mockLlmCall.mockResolvedValue('[534, 062, 1]');
        expect(await rerankCandidates('q', scenes, endpoint)).toEqual(['534', '062', '001']);
    });

    it('reads quoted ids and drops invented ones', async () => {
        mockLlmCall.mockResolvedValue('Here: ["120", "999", "600"]');
        expect(await rerankCandidates('q', scenes, endpoint)).toEqual(['120', '600']);
    });

    it('keeps each id once', async () => {
        mockLlmCall.mockResolvedValue('["534", 534, "534"]');
        expect(await rerankCandidates('q', scenes, endpoint)).toEqual(['534']);
    });

    it('falls back to input order when nothing usable comes back', async () => {
        mockLlmCall.mockResolvedValue('');
        expect(await rerankCandidates('q', scenes, endpoint)).toEqual(scenes.map(c => c.id));
    });
});

describe('sceneRerankSummary', () => {
    const base: ArchiveIndexEntry = { sceneId: '534', timestamp: 0, keywords: ['Dice', 'Roll', 'Harbor'], npcsMentioned: ['Rin', 'Therese'], userSnippet: 'I sign the deal' };
    const names = new Map([['n1', 'Rin Holmes'], ['n2', 'Therese']]);

    it('uses event tags and the witnessed cast', () => {
        const entry = { ...base, npcsWitnessed: ['n1'], events: [{ eventType: 'deal', importance: 7, text: 'Rin agrees to the harbor deal' }] } as unknown as ArchiveIndexEntry;
        expect(sceneRerankSummary(entry, names)).toBe('Rin agrees to the harbor deal | present: Rin Holmes | player: I sign the deal');
    });

    it('falls back to keywords and mentioned names', () => {
        expect(sceneRerankSummary(base, names)).toBe('Dice, Roll, Harbor | present: Rin, Therese | player: I sign the deal');
    });
});
