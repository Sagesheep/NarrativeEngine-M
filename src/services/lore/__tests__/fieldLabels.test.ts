import { describe, it, expect } from 'vitest';
import { chunkLoreFile } from '../loreChunker';
import { retrieveRelevantLore } from '../loreRetriever';
import type { LoreChunk } from '../../../types';

const STRUCTURED = `## [CHUNK: CHARACTER -- Helena Broadmarsh]
**Type:** Noble
**Aliases:** The Widow
**Appearance:** Grey silk, iron rings
**Disposition:** Cold
Helena runs the harbor guild from Saltmere.`;

describe('lore field labels', () => {
    it('labels of a structured entry do not become trigger keywords', () => {
        const [chunk] = chunkLoreFile(STRUCTURED);
        const kws = chunk.triggerKeywords ?? [];
        expect(kws).toContain('helena broadmarsh');
        expect(kws).toContain('saltmere');
        for (const label of ['type', 'aliases', 'appearance', 'disposition']) {
            expect(kws).not.toContain(label);
        }
    });

    it('chunks stored with label keywords are not triggered by them', () => {
        const stale: LoreChunk = {
            id: 'c1', header: 'Old entry', content: 'Nothing relevant.', tokens: 10,
            triggerKeywords: ['type', 'appearance'], category: 'character',
        } as LoreChunk;
        const hits = retrieveRelevantLore([stale], 'What type of appearance does she have?', 1200, [], []);
        expect(hits.map(c => c.id)).not.toContain('c1');

        // Control: a real keyword on the same chunk still triggers it.
        const real = { ...stale, triggerKeywords: ['type', 'saltmere'] };
        const control = retrieveRelevantLore([real], 'We sail to Saltmere.', 1200, [], []);
        expect(control.map(c => c.id)).toContain('c1');
    });
});
