import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runLoreCheck, buildVerifierPrompt, buildSearchQuery } from '../lore';

vi.mock('../llm/llmCall', () => ({ llmCall: vi.fn() }));
vi.mock('../archive', () => ({ deepArchiveScan: vi.fn(async () => 'mock archive brief') }));
vi.mock('../lore/loreRetriever', () => ({
    retrieveRelevantLore: vi.fn(() => [
        { id: '1', header: 'Eldra the Pale', content: 'Eldra is a high elf, not a dwarf.', tokens: 10,
          alwaysInclude: false, triggerKeywords: [], scanDepth: 1, category: 'character',
          linkedEntities: [], priority: 5 },
    ]),
}));
vi.mock('../embedding', () => ({
    semanticSearch: vi.fn(async () => ['lore-1']),
    isEmbedderReady: vi.fn(() => true),
}));
vi.mock('../turn/stages/expandQueryStage', () => ({
    expandQuery: vi.fn(async (q: string) => [q, `${q} variant1`, `${q} variant2`]),
}));
vi.mock('../turn/utilityLLM', () => ({
    realUtilityLLM: vi.fn(() => ({
        endpoint: vi.fn(() => ({ provider: 'mock' })),
        call: vi.fn(async () => '["expanded1","expanded2"]'),
    })),
}));

import { llmCall } from '../llm/llmCall';
import { retrieveRelevantLore } from '../lore/loreRetriever';
import { semanticSearch, isEmbedderReady } from '../embedding';
import { expandQuery } from '../turn/stages/expandQueryStage';

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
    npcLedger: [],
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

    it('strips unclosed think tags before parsing', async () => {
        (llmCall as any).mockResolvedValue(
            '<think>reasoning that never ends\n{"verdict":"unsupported","issues":["test"],"citations":[],"suggestedRewrite":null}'
        );
        const res = await runLoreCheck(baseInput());
        expect(res.verdict).toBe('unsupported');
        expect(res.issues).toEqual(['test']);
    });

    it('strips closed think tags and code fences before parsing', async () => {
        (llmCall as any).mockResolvedValue(
            '<think>thinking about it</think>\n```json\n{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}\n```'
        );
        const res = await runLoreCheck(baseInput());
        expect(res.verdict).toBe('consistent');
    });

    it('parses markdown-code-fenced JSON despite instructions', async () => {
        (llmCall as any).mockResolvedValue(
            '```json\n{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}\n```'
        );
        const res = await runLoreCheck(baseInput());
        expect(res.verdict).toBe('consistent');
    });

    it('skips deepArchiveScan when no sealed chapters', async () => {
        const { deepArchiveScan } = await import('../archive');
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput({ sealedChapters: [], archiveIndex: [] }));
        expect(deepArchiveScan).not.toHaveBeenCalled();
    });

    it('calls retrieveRelevantLore (not searchLoreByQuery)', async () => {
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput());
        expect(retrieveRelevantLore).toHaveBeenCalled();
    });

    it('runs semantic search when embedder is ready', async () => {
        (isEmbedderReady as any).mockReturnValue(true);
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput());
        expect(semanticSearch).toHaveBeenCalledWith('c1', expect.any(Array), 'lore', 25, 0.30);
    });

    it('skips semantic search when embedder is not ready', async () => {
        (isEmbedderReady as any).mockReturnValue(false);
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput());
        expect(semanticSearch).not.toHaveBeenCalled();
    });

    it('runs query expansion for short selections', async () => {
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput({ selectedText: 'Eldra nodded' }));
        expect(expandQuery).toHaveBeenCalled();
    });

    it('skips query expansion for long selections', async () => {
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput({ selectedText: 'Eldra the dwarf nodded slowly and looked around the room with great suspicion' }));
        expect(expandQuery).not.toHaveBeenCalled();
    });

    it('uses JSON_ONLY_FOOTER in verifier prompt', async () => {
        (llmCall as any).mockResolvedValue('{"verdict":"consistent","issues":[],"citations":[],"suggestedRewrite":null}');
        await runLoreCheck(baseInput());
        const prompt = (llmCall as any).mock.calls[0][1];
        expect(prompt).toContain('No prose, no markdown fences');
    });
});

describe('buildSearchQuery', () => {
    it('returns selectedText alone when no hint', () => {
        expect(buildSearchQuery('Eldra nodded')).toBe('Eldra nodded');
    });

    it('appends hint with separator', () => {
        expect(buildSearchQuery('Eldra nodded', 'she was already dead')).toBe(
            'Eldra nodded \u2014 she was already dead'
        );
    });

    it('trims whitespace from hint', () => {
        expect(buildSearchQuery('Eldra nodded', '  dead  ')).toBe(
            'Eldra nodded \u2014 dead'
        );
    });

    it('ignores whitespace-only hint', () => {
        expect(buildSearchQuery('Eldra nodded', '   ')).toBe('Eldra nodded');
    });
});

describe('buildVerifierPrompt', () => {
    const baseArgs = {
        selectedText: 'Eldra the dwarf nodded.',
        surroundingContext: 'previous. Eldra the dwarf nodded. next.',
        loreText: '### Eldra the Pale\nEldra is a high elf.',
        archiveText: '(no archived scenes available)',
    };

    it('omits USER CONCERN block when no hint or categories', () => {
        const prompt = buildVerifierPrompt(baseArgs);
        expect(prompt).not.toContain('[USER CONCERN]');
        expect(prompt).not.toContain('Categories:');
        expect(prompt).not.toContain('Note:');
    });

    it('includes USER CONCERN block with categories only', () => {
        const prompt = buildVerifierPrompt({
            ...baseArgs,
            categories: ['wrong-entity', 'contradicts-lore'],
        });
        expect(prompt).toContain('[USER CONCERN]');
        expect(prompt).toContain('Categories: wrong-entity, contradicts-lore');
        expect(prompt).not.toContain('Note:');
    });

    it('includes USER CONCERN block with hint only', () => {
        const prompt = buildVerifierPrompt({
            ...baseArgs,
            hint: 'this NPC was already dead',
        });
        expect(prompt).toContain('[USER CONCERN]');
        expect(prompt).toContain('Note: "this NPC was already dead"');
        expect(prompt).not.toContain('Categories:');
    });

    it('includes both categories and note in USER CONCERN block', () => {
        const prompt = buildVerifierPrompt({
            ...baseArgs,
            hint: 'she was dead already',
            categories: ['wrong-fact', 'out-of-character'],
        });
        expect(prompt).toContain('[USER CONCERN]');
        expect(prompt).toContain('Categories: wrong-fact, out-of-character');
        expect(prompt).toContain('Note: "she was dead already"');
    });

    it('includes user concern guidance in job description', () => {
        const prompt = buildVerifierPrompt({
            ...baseArgs,
            hint: 'wrong city',
        });
        expect(prompt).toContain('If a USER CONCERN is provided, weigh it heavily');
    });

    it('does not include user concern guidance when no hint/categories', () => {
        const prompt = buildVerifierPrompt(baseArgs);
        expect(prompt).not.toContain('If a USER CONCERN is provided');
    });
});