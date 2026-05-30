import { describe, it, expect } from 'vitest';
import { retrieveRelevantLore } from '../lore';
import type { LoreChunk } from '../../types';

const makeChunk = (
    id: string,
    triggerKeywords: string[],
    opts: Partial<LoreChunk> = {}
): LoreChunk => ({
    id,
    header: `Header for ${id}`,
    content: `Content about ${id}`,
    tokens: 50,
    alwaysInclude: false,
    triggerKeywords,
    scanDepth: 2,
    category: 'character',
    linkedEntities: [],
    priority: 5,
    ...opts,
});

describe('retrieveRelevantLore — activation modes', () => {
    it('always mode: always includes chunk regardless of keywords or semantic hits', () => {
        const chunk = makeChunk('always-1', [], {
            activationModes: ['always'],
        });
        const result = retrieveRelevantLore([chunk], 'totally unrelated message');
        expect(result).toContainEqual(expect.objectContaining({ id: 'always-1' }));
    });

    it('keyword-only mode: requires keyword match to be included', () => {
        const chunk = makeChunk('kw-only', ['dragon'], {
            activationModes: ['keyword'],
        });
        const result1 = retrieveRelevantLore([chunk], 'a dragon appeared');
        expect(result1).toContainEqual(expect.objectContaining({ id: 'kw-only' }));

        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here');
        expect(result2).not.toContainEqual(expect.objectContaining({ id: 'kw-only' }));
    });

    it('vector-only mode: requires semantic hit to be included', () => {
        const chunk = makeChunk('vec-only', ['dragon'], {
            activationModes: ['vector'],
        });
        // No keyword match, no semantic hit → excluded
        const result1 = retrieveRelevantLore([chunk], 'nothing relevant here');
        expect(result1).not.toContainEqual(expect.objectContaining({ id: 'vec-only' }));

        // No keyword match, but semantic hit → included
        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here', 1200, [], ['vec-only']);
        expect(result2).toContainEqual(expect.objectContaining({ id: 'vec-only' }));
    });

    it('vector+keyword mode: keyword match alone and semantic hit alone both score', () => {
        const chunk = makeChunk('both', ['dragon'], {
            activationModes: ['vector', 'keyword'],
        });
        // Keyword match scores via keyword mode
        const result1 = retrieveRelevantLore([chunk], 'a dragon appeared');
        expect(result1).toContainEqual(expect.objectContaining({ id: 'both' }));

        // Semantic hit scores via vector mode
        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here', 1200, [], ['both']);
        expect(result2).toContainEqual(expect.objectContaining({ id: 'both' }));
    });

    it('legacy behavior: undefined activationModes = vector+keyword (hybrid)', () => {
        const chunk = makeChunk('legacy', ['dragon'], {
            // activationModes intentionally undefined
        });
        // Keyword match works
        const result1 = retrieveRelevantLore([chunk], 'a dragon appeared');
        expect(result1).toContainEqual(expect.objectContaining({ id: 'legacy' }));

        // Semantic hit works
        const result2 = retrieveRelevantLore([chunk], 'nothing relevant here', 1200, [], ['legacy']);
        expect(result2).toContainEqual(expect.objectContaining({ id: 'legacy' }));
    });

    it('legacy alwaysInclude respected when activationModes undefined', () => {
        const chunk = makeChunk('legacy-always', [], {
            alwaysInclude: true,
        });
        const result = retrieveRelevantLore([chunk], 'unrelated');
        expect(result).toContainEqual(expect.objectContaining({ id: 'legacy-always' }));
    });

    it('activationModes always takes precedence over legacy alwaysInclude', () => {
        // alwaysInclude=true but activationModes=['keyword'] → keyword mode, NOT always
        const chunk = makeChunk('override', ['dragon'], {
            alwaysInclude: true,
            activationModes: ['keyword'],
        });
        // No keyword match → should NOT be included despite alwaysInclude=true
        const result = retrieveRelevantLore([chunk], 'unrelated message');
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'override' }));
    });

    it('keyword-only chunk excluded by secondary keyword AND-gate', () => {
        const chunk = makeChunk('kw-and-sec', ['dragon'], {
            activationModes: ['keyword'],
            secondaryKeywords: ['fortress'],
        });
        // Primary "dragon" present, but secondary "fortress" is absent
        const result = retrieveRelevantLore([chunk], 'the dragon appeared');
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'kw-and-sec' }));
    });

    it('keyword-only chunk included when secondary AND-gate satisfied', () => {
        const chunk = makeChunk('kw-and-sec-ok', ['dragon'], {
            activationModes: ['keyword'],
            secondaryKeywords: ['fortress'],
        });
        const result = retrieveRelevantLore([chunk], 'the dragon fortress');
        expect(result).toContainEqual(expect.objectContaining({ id: 'kw-and-sec-ok' }));
    });

    it('secondary-key AND-gate bypassed for semantic-only path', () => {
        const chunk = makeChunk('semantic-bypass', ['nevermatchesxyz'], {
            activationModes: ['vector', 'keyword'],
            secondaryKeywords: ['alsonomatch'],
        });
        // No keyword match at all but semantic hit
        const result = retrieveRelevantLore(
            [chunk],
            'completely unrelated sentence',
            1200,
            [],
            ['semantic-bypass']
        );
        expect(result).toContainEqual(expect.objectContaining({ id: 'semantic-bypass' }));
    });
});

describe('retrieveRelevantLore — secondary-key AND-gate (legacy compat)', () => {
    it('does NOT retrieve a chunk when primary keyword matches but secondary keywords are absent', () => {
        const chunk = makeChunk('chunk-1', ['drakmoor'], {
            secondaryKeywords: ['fortress', 'siege'],
        });
        const result = retrieveRelevantLore([chunk], 'I went to drakmoor yesterday');
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'chunk-1' }));
    });

    it('retrieves a chunk when both primary AND at least one secondary keyword are present', () => {
        const chunk = makeChunk('chunk-2', ['drakmoor'], {
            secondaryKeywords: ['fortress', 'siege'],
        });
        const result = retrieveRelevantLore([chunk], 'The siege of drakmoor began at dawn');
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-2' }));
    });

    it('retrieves a chunk via semantic-only path even when secondary keywords are NOT satisfied', () => {
        const chunk = makeChunk('chunk-4', ['nevermatches'], {
            secondaryKeywords: ['alsonevermatches'],
        });
        const result = retrieveRelevantLore([chunk], 'a completely unrelated sentence here', 1200, [], ['chunk-4']);
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-4' }));
    });

    it('retrieves a chunk with primary keyword match and NO secondaryKeywords field', () => {
        const chunk = makeChunk('chunk-5', ['goldenveil']);
        const result = retrieveRelevantLore([chunk], 'the goldenveil guild is nearby');
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-5' }));
    });
});