import { describe, it, expect, beforeEach } from 'vitest';
import { computeArchiveIdf, clearIdfCache, fuseRecall, retrieveArchiveMemory } from '../archive';
import type { ArchiveIndexEntry } from '../../types';

function makeEntry(
    sceneId: string,
    keywords: string[],
    npcsMentioned: string[],
    keywordStrengths: Record<string, number>,
    npcStrengths: Record<string, number>,
    importance?: number
): ArchiveIndexEntry {
    return {
        sceneId,
        timestamp: parseInt(sceneId, 10) * 1000,
        keywords,
        npcsMentioned,
        userSnippet: `Scene ${sceneId}`,
        keywordStrengths,
        npcStrengths,
        importance,
    };
}

describe('computeArchiveIdf', () => {
    beforeEach(() => clearIdfCache());

    it('assigns higher IDF to rare terms than common terms', () => {
        const entries: ArchiveIndexEntry[] = [];
        for (let i = 0; i < 18; i++) {
            entries.push(makeEntry(String(i).padStart(3, '0'), ['protagonist'], ['dragon'], { protagonist: 0.5 }, { dragon: 0.5 }));
        }
        entries.push(makeEntry('018', ['protagonist', 'obelisk'], ['dragon', 'zara'], { protagonist: 0.5, obelisk: 0.8 }, { dragon: 0.5, zara: 0.9 }));
        entries.push(makeEntry('019', ['protagonist', 'obelisk'], ['dragon', 'zara'], { protagonist: 0.5, obelisk: 0.8 }, { dragon: 0.5, zara: 0.9 }));

        const idf = computeArchiveIdf(entries);

        expect(idf['obelisk']).toBeGreaterThan(idf['protagonist']);
        expect(idf['zara']).toBeGreaterThan(idf['dragon']);
    });

    it('uses legacy keywords/npcsMentioned for entries without strengths', () => {
        const entries: ArchiveIndexEntry[] = [
            makeEntry('000', ['sword'], ['goblin'], {}, {}),
            makeEntry('001', ['sword'], ['goblin'], {}, {}),
            makeEntry('002', ['wand'], ['dragon'], {}, {}),
        ];

        const idf = computeArchiveIdf(entries);

        expect(idf['wand']).toBeGreaterThan(idf['sword']);
        expect(idf['dragon']).toBeGreaterThan(idf['goblin']);
    });

    it('memoizes on identical index signature', () => {
        const entries = [
            makeEntry('000', ['test'], [], { test: 0.5 }, {}),
        ];

        const idf1 = computeArchiveIdf(entries);
        const idf2 = computeArchiveIdf(entries);
        expect(idf1).toBe(idf2);
    });

    it('recomputes when index changes', () => {
        const entries1 = [makeEntry('000', ['a'], [], { a: 0.5 }, {})];
        const entries2 = [makeEntry('000', ['a'], [], { a: 0.5 }, {}), makeEntry('001', ['b'], [], { b: 0.5 }, {})];

        computeArchiveIdf(entries1);
        const idf2 = computeArchiveIdf(entries2);

        expect(idf2['b']).toBeDefined();
    });
});

describe('IDF-weighted scoreEntry', () => {
    beforeEach(() => clearIdfCache());

    it('down-ranks scenes matched only on common terms vs rare terms', () => {
        // 'common' appears in 18 scenes (low IDF); 'rare' appears in 2 (high IDF).
        const entries: ArchiveIndexEntry[] = [];
        for (let i = 0; i < 18; i++) {
            entries.push(makeEntry(String(i).padStart(3, '0'), ['common'], [], { common: 0.5 }, {}));
        }
        // sceneA matched only on the common term, sceneB only on the rare term — equal strength.
        const sceneA = makeEntry('090', ['common'], [], { common: 0.5 }, {});
        const sceneB = makeEntry('091', ['rare'], [], { rare: 0.5 }, {});
        // One more 'rare' occurrence so it isn't a singleton, but still far rarer than 'common'.
        const sceneFiller = makeEntry('092', ['rare'], [], { rare: 0.5 }, {});
        entries.push(sceneA, sceneB, sceneFiller);

        const result = retrieveArchiveMemory(
            entries, 'common rare', [], undefined, 25
        );

        const rarePos = result.indexOf('091');
        const commonPos = result.indexOf('090');
        expect(rarePos).toBeGreaterThanOrEqual(0);
        expect(commonPos).toBeGreaterThanOrEqual(0);
        expect(rarePos).toBeLessThan(commonPos);
    });
});

describe('fuseRecall (RRF)', () => {
    it('consensus scenes outrank single-ranker scenes', () => {
        const keywordRanked = ['a', 'b', 'c'];
        const embeddingRanked = ['c', 'b', 'd'];

        const fused = fuseRecall(keywordRanked, embeddingRanked);

        expect(fused.indexOf('c')).toBeLessThan(fused.indexOf('a'));
        expect(fused.indexOf('b')).toBeLessThan(fused.indexOf('a'));
    });

    it('empty embeddings returns keyword-only result', () => {
        const keywordRanked = ['a', 'b', 'c'];
        const result = fuseRecall(keywordRanked, []);
        expect(result).toEqual(['a', 'b', 'c']);
    });

    it('empty keywords returns embedding-only result', () => {
        const embeddingRanked = ['x', 'y', 'z'];
        const result = fuseRecall([], embeddingRanked);
        expect(result).toEqual(['x', 'y', 'z']);
    });

    it('both empty returns empty array', () => {
        const result = fuseRecall([], []);
        expect(result).toEqual([]);
    });

    it('applies weights correctly', () => {
        const keywordRanked = ['a', 'b'];
        const embeddingRanked = ['b', 'a'];

        fuseRecall(keywordRanked, embeddingRanked, 60, 1.0, 1.0);
        const fusedKwHeavy = fuseRecall(keywordRanked, embeddingRanked, 60, 2.0, 1.0);

        expect(fusedKwHeavy[0]).toBe('a');
    });
});

describe('retrieveArchiveMemory with RRF fusion', () => {
    beforeEach(() => clearIdfCache());

    it('returns keyword-only results when no semantic candidates provided', () => {
        const entries = [
            makeEntry('001', ['dragon'], [], { dragon: 0.8 }, {}),
            makeEntry('002', ['sword'], [], { sword: 0.6 }, {}),
            makeEntry('003', ['castle'], [], { castle: 0.4 }, {}),
        ];

        const result = retrieveArchiveMemory(entries, 'dragon', []);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toBe('001');
    });

    it('fuses keyword and semantic candidates', () => {
        const entries = [
            makeEntry('001', ['dragon'], [], { dragon: 0.8 }, {}),
            makeEntry('002', ['sword'], [], { sword: 0.6 }, {}),
            makeEntry('003', ['castle'], [], { castle: 0.4 }, {}),
        ];

        // '003' matches no keyword (query is "dragon"); it can only surface via embeddings.
        const semanticHits = [
            { id: '003', score: 0.9 },
            { id: '002', score: 0.7 },
        ];

        const keywordOnly = retrieveArchiveMemory(entries, 'dragon', []);
        expect(keywordOnly).not.toContain('003');

        clearIdfCache();
        const fused = retrieveArchiveMemory(
            entries, 'dragon', [], undefined, undefined, undefined, undefined, semanticHits as any
        );
        // The embedding-only scene must now appear thanks to fusion.
        expect(fused).toContain('003');
    });

    it('filters results by sceneRanges', () => {
        const entries = [
            makeEntry('001', ['dragon'], [], { dragon: 0.8 }, {}),
            makeEntry('002', ['dragon'], [], { dragon: 0.9 }, {}),
            makeEntry('010', ['dragon'], [], { dragon: 0.7 }, {}),
        ];

        const result = retrieveArchiveMemory(
            entries, 'dragon', [], undefined, undefined, undefined, [['001', '005']]
        );

        expect(result.every(id => parseInt(id) >= 1 && parseInt(id) <= 5)).toBe(true);
    });

    it('force-recalls a divergence scene even with zero keyword/embedding match', () => {
        // Build enough matching scenes to fill dynamicMax without the divergence scene.
        const entries: ArchiveIndexEntry[] = [];
        for (let i = 0; i < 10; i++) {
            entries.push(makeEntry(String(i).padStart(3, '0'), ['dragon'], [], { dragon: 0.8 }, {}));
        }
        // Scene 099 shares no terms with the query, so it never matches keyword or embedding.
        entries.push(makeEntry('099', ['obelisk'], [], { obelisk: 0.9 }, {}));

        const withoutDiv = retrieveArchiveMemory(entries, 'dragon', [], undefined, 3);
        expect(withoutDiv).not.toContain('099');

        clearIdfCache();
        const withDiv = retrieveArchiveMemory(
            entries, 'dragon', [], undefined, 3, undefined, undefined, undefined, new Set(['099'])
        );
        // The zero-match divergence scene must surface despite no relevance.
        expect(withDiv).toContain('099');
    });

    it('promotes a matched divergence scene toward the front', () => {
        const entries: ArchiveIndexEntry[] = [];
        for (let i = 0; i < 6; i++) {
            entries.push(makeEntry(String(i).padStart(3, '0'), ['dragon'], [], { dragon: 0.8 }, {}));
        }
        const result = retrieveArchiveMemory(
            entries, 'dragon', [], undefined, 3, undefined, undefined, undefined, new Set(['003'])
        );
        expect(result[0]).toBe('003');
    });

    it('applies filter boost to promote scenes matching planner filters', () => {
        const plainEntry: ArchiveIndexEntry = {
            ...makeEntry('001', ['battle'], [], { battle: 0.6 }, {}),
            events: [{ eventType: 'combat', importance: 5, text: 'a skirmish', characters: ['Goblin'] }],
        };
        const filteredEntry: ArchiveIndexEntry = {
            ...makeEntry('002', ['battle'], [], { battle: 0.6 }, {}),
            events: [{ eventType: 'combat', importance: 5, text: 'a duel', locations: ['Citadel'] }],
        };
        const entries = [plainEntry, filteredEntry];

        const noFilter = retrieveArchiveMemory(entries, 'battle', [], undefined, 2);
        clearIdfCache();
        const withFilter = retrieveArchiveMemory(
            entries, 'battle', [], undefined, 2, undefined, undefined, undefined, undefined,
            { locations: ['Citadel'] }
        );
        // Equal base relevance; the Citadel-matching scene should rank ahead once filtered.
        expect(withFilter[0]).toBe('002');
        expect(noFilter.length).toBe(2);
    });

    it('caps results at explicit maxScenes', () => {
        const entries = [];
        for (let i = 0; i < 100; i++) {
            const id = String(i).padStart(3, '0');
            entries.push(makeEntry(id, ['dragon'], [], { dragon: 0.8 }, {}));
        }

        const result = retrieveArchiveMemory(entries, 'dragon', [], undefined, 10);
        expect(result.length).toBeLessThanOrEqual(10);
    });

    it('returns empty for empty index', () => {
        const result = retrieveArchiveMemory([], 'test', []);
        expect(result).toEqual([]);
    });
});

describe('dynamicMax consensus-based behavior', () => {
    beforeEach(() => clearIdfCache());

    it('returns 5 when consensus >= 3', () => {
        const entries = [];
        for (let i = 0; i < 20; i++) {
            entries.push(makeEntry(String(i).padStart(3, '0'), ['dragon'], [], { dragon: 0.8 }, {}));
        }

        const semanticOverlaps = [
            { id: '000', score: 0.9 },
            { id: '001', score: 0.8 },
            { id: '002', score: 0.7 },
        ] as any;

        const result = retrieveArchiveMemory(entries, 'dragon', [], undefined, undefined, undefined, undefined, semanticOverlaps);
        expect(result.length).toBe(5);
    });

    it('returns 4 when consensus >= 1 but < 3', () => {
        const entries = [];
        for (let i = 0; i < 20; i++) {
            entries.push(makeEntry(String(i).padStart(3, '0'), ['alpha'], [], { alpha: 0.8 }, {}));
        }

        const semanticOne = [
            { id: '005', score: 0.8 },
        ] as any;

        const result = retrieveArchiveMemory(entries, 'alpha', [], undefined, undefined, undefined, undefined, semanticOne);
        expect(result.length).toBe(4);
    });

    it('returns 3 when no consensus', () => {
        const entries = [];
        for (let i = 0; i < 20; i++) {
            entries.push(makeEntry(String(i).padStart(3, '0'), [`term${i}`], [], { [`term${i}`]: 0.8 }, {}));
        }

        const semanticNoOverlap = entries.slice(10, 13).map(e => ({ id: e.sceneId, score: 0.5 })) as any;

        const result = retrieveArchiveMemory(entries, 'term0 term1 term2', [], undefined, undefined, undefined, undefined, semanticNoOverlap);
        expect(result.length).toBe(3);
    });
});