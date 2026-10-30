import { describe, it, expect, vi } from 'vitest';
import { chunkLoreFile, ragModeToActivation } from '../loreChunker';
import { retrieveRelevantLore } from '../loreRetriever';
import { deriveDefaultLoreMeta } from '../loreIndexer';
import { computeLoreBudget } from '../../turn/stages/loreStage';

vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../../utils/llmCall';
import { enrichLoreKeywords } from '../loreKeywordEnricher';

const LORE = `## People

### [CHUNK: OVERVIEW -- Profile Akihiko]
<!-- rag: keyword, triggers: Akihiko, Sanada, priority: 8 -->
Boxing captain at Gekkoukan. In October 2009 he trains every Monday evening at the dorm.

### [CHUNK: EVENT -- Monthly Calendar]
<!-- rag: keyword, triggers: calendar, priority: 6 -->
Monday October 2009 dorm Gekkoukan evening training schedule.

### [CHUNK: OVERVIEW -- Untagged Notes]
Iwatodai Station sits beside the Strip Mall.`;

describe('authored lore triggers', () => {
    it('uses hint triggers as-is and marks the chunk authored', () => {
        const [akihiko] = chunkLoreFile(LORE);
        expect(akihiko.triggerKeywords).toEqual(['Akihiko', 'Sanada']);
        expect(akihiko.authoredKeywords).toBe(true);
    });

    it('still auto-extracts keywords for chunks without hint triggers', () => {
        const untagged = chunkLoreFile(LORE).find(c => c.header.includes('Untagged'))!;
        expect(untagged.authoredKeywords).toBeUndefined();
        expect(untagged.triggerKeywords).toContain('untagged');
        expect(untagged.triggerKeywords.length).toBeGreaterThan(2);
    });

    it('generic scene-header words no longer pull in a chunk that only mentions them in its body', () => {
        const chunks = chunkLoreFile(LORE);
        const header = '📅 Monday, 5 October 2009 — 7:00 PM | 📍 Gekkoukan dorm';
        const hits = retrieveRelevantLore(chunks, 'Ken asks Akihiko about training.', 5000, [{ role: 'assistant', content: header } as never]);
        const ids = hits.map(c => c.header);
        expect(ids).toContain('[CHUNK: OVERVIEW -- Profile Akihiko]');
        expect(ids).not.toContain('[CHUNK: EVENT -- Monthly Calendar]');
    });

    it('enricher leaves authored chunks untouched', async () => {
        const chunks = chunkLoreFile(LORE);
        const save = vi.fn();
        vi.mocked(llmCall).mockResolvedValue('{}');
        await enrichLoreKeywords('c1', chunks, {} as never, save);
        const prompt = vi.mocked(llmCall).mock.calls[0]?.[1] as string;
        expect(prompt).not.toContain('profile-akihiko');
        expect(prompt).toContain('untagged-notes');
        expect(chunks[0].triggerKeywords).toEqual(['Akihiko', 'Sanada']);
    });
});

describe('hybrid hint mode', () => {
    const HYBRID = `### [CHUNK: OVERVIEW -- Profile Akihiko]
<!-- rag: hybrid, triggers: Akihiko, Sanada, priority: 8 -->
Boxing captain at Gekkoukan.`;

    it('activates by keyword or vector and keeps authored triggers', () => {
        const [chunk] = chunkLoreFile(HYBRID);
        expect(chunk.ragMode).toBe('hybrid');
        expect(chunk.activationModes).toEqual(['vector', 'keyword']);
        expect(chunk.triggerKeywords).toEqual(['Akihiko', 'Sanada']);
        expect(chunk.authoredKeywords).toBe(true);
    });

    it('is retrieved by a semantic hit alone', () => {
        const chunks = chunkLoreFile(HYBRID);
        const hits = retrieveRelevantLore(chunks, 'Who is the boxer?', 5000, [], [chunks[0].id]);
        expect(hits.map(c => c.id)).toContain(chunks[0].id);
    });

    it('a keyword-only chunk ignores semantic hits', () => {
        const chunks = chunkLoreFile(HYBRID.replace('rag: hybrid', 'rag: keyword'));
        const hits = retrieveRelevantLore(chunks, 'Who is the boxer?', 5000, [], [chunks[0].id]);
        expect(hits).toHaveLength(0);
    });

    it('rules and lore indexers expand hybrid to both modes', () => {
        const [chunk] = chunkLoreFile(HYBRID);
        expect(deriveDefaultLoreMeta({ ...chunk, activationModes: undefined })).toEqual(['vector', 'keyword']);
        expect(ragModeToActivation('keyword')).toEqual(['keyword']);
    });
});

describe('computeLoreBudget', () => {
    it('defaults to 5% of the context limit with a 1200 floor', () => {
        expect(computeLoreBudget({ contextLimit: 8192 })).toBe(1200);
        expect(computeLoreBudget({ contextLimit: 64000 })).toBe(3200);
    });

    it('uses an explicit setting when positive', () => {
        expect(computeLoreBudget({ contextLimit: 64000, loreBudgetTokens: 2000 })).toBe(2000);
        expect(computeLoreBudget({ contextLimit: 64000, loreBudgetTokens: 0 })).toBe(3200);
    });
});
