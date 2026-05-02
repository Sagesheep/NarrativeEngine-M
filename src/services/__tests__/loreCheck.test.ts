import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLoreCheck } from '../loreCheck';

vi.mock('../../utils/llmCall', () => ({ llmCall: vi.fn() }));
vi.mock('../deepArchiveSearch', () => ({ deepArchiveScan: vi.fn(async () => 'mock archive brief') }));
vi.mock('../loreRetriever', () => ({
    searchLoreByQuery: vi.fn(() => [
        { id: '1', header: 'Eldra the Pale', content: 'Eldra is a high elf, not a dwarf.', tokens: 10,
          alwaysInclude: false, triggerKeywords: [], scanDepth: 1, category: 'character',
          linkedEntities: [], priority: 5 },
    ]),
}));

import { llmCall } from '../../utils/llmCall';

const baseInput = (overrides = {}) => ({
    utilityEndpoint: { provider: 'mock' } as any,
    selectedText: 'Eldra the dwarf nodded.',
    surroundingContext: '... Eldra the dwarf nodded. ...',
    messages: [{ id: 'm1', role: 'assistant', content: 'foo', timestamp: 0 }] as any,
    targetMessageId: 'm1',
    loreChunks: [],
    archiveIndex: [{ sceneId: '042', timestamp: 0, keywords: [], npcsMentioned: [], userSnippet: '' }] as any,
    sealedChapters: [{ chapterId: 'ch01', sceneRange: ['001', '050'], sealedAt: 1 }] as any,
    campaignId: 'c1',
    onStatus: () => {},
    ...overrides,
});

describe('runLoreCheck', () => {
    beforeEach(() => vi.clearAllMocks());

    it('parses a "contradicts" verdict with a rewrite', async () => {
        (llmCall as any).mockResolvedValue(JSON.stringify({
            verdict: 'contradicts',
            issues: ['Eldra is described as a high elf in lore.'],
            citations: [{ ref: 'lore:Eldra the Pale', label: 'Eldra (lore)' }],
            suggestedRewrite: 'Eldra the high elf nodded.',
        }));
        const res = await runLoreCheck(baseInput());
        expect(res.verdict).toBe('contradicts');
        expect(res.issues).toHaveLength(1);
        expect(res.citations[0].ref).toBe('lore:Eldra the Pale');
        expect(res.suggestedRewrite).toBe('Eldra the high elf nodded.');
        expect(res.originalText).toBe('Eldra the dwarf nodded.');
    });

    it('falls back to "unsupported" on unparseable LLM output', async () => {
        (llmCall as any).mockResolvedValue('not json at all');
        const res = await runLoreCheck(baseInput());
        expect(res.verdict).toBe('unsupported');
        expect(res.suggestedRewrite).toBeNull();
    });

    it('strips <think/> blocks and code fences before parsing', async () => {
        (llmCall as any).mockResolvedValue(
            '<thinkthinking about it</think\n```json\n{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}\n```'
        );
        const res = await runLoreCheck(baseInput());
        expect(res.verdict).toBe('consistent');
    });

    it('skips deepArchiveScan when no sealed chapters', async () => {
        const { deepArchiveScan } = await import('../deepArchiveSearch');
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput({ sealedChapters: [], archiveIndex: [] }));
        expect(deepArchiveScan).not.toHaveBeenCalled();
    });
});
