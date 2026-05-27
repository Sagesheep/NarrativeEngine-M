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

describe('retrieveRelevantLore — secondary-key AND-gate', () => {
    it('does NOT retrieve a chunk when primary keyword matches but secondary keywords are absent', () => {
        const chunk = makeChunk('chunk-1', ['drakmoor'], {
            secondaryKeywords: ['fortress', 'siege'],
        });
        // "drakmoor" is in message but neither "fortress" nor "siege" is
        const result = retrieveRelevantLore([chunk], 'I went to drakmoor yesterday');
        expect(result).not.toContainEqual(expect.objectContaining({ id: 'chunk-1' }));
    });

    it('retrieves a chunk when both primary AND at least one secondary keyword are present', () => {
        const chunk = makeChunk('chunk-2', ['drakmoor'], {
            secondaryKeywords: ['fortress', 'siege'],
        });
        // Both "drakmoor" (primary) and "siege" (secondary) present
        const result = retrieveRelevantLore([chunk], 'The siege of drakmoor began at dawn');
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-2' }));
    });

    it('retrieves a chunk via semantic-only path when id is in semanticLoreIds with no keyword match', () => {
        const chunk = makeChunk('chunk-3', ['obscurekeywordxyz'], {
            secondaryKeywords: ['alsoobscure'],
        });
        // No keywords match the message — but chunk-3 is passed as a semantic hit
        const result = retrieveRelevantLore([chunk], 'generic message with no matching words', 1200, [], ['chunk-3']);
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-3' }));
    });

    it('retrieves a semantic-only chunk even when its secondary keywords are NOT satisfied (gate bypassed)', () => {
        const chunk = makeChunk('chunk-4', ['nevermatches'], {
            secondaryKeywords: ['alsonevermatches'],
        });
        // Semantic hit with unmet secondary keys — should still be retrieved
        const result = retrieveRelevantLore([chunk], 'a completely unrelated sentence here', 1200, [], ['chunk-4']);
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-4' }));
    });

    it('retrieves a chunk with primary keyword match and NO secondaryKeywords field (back-compat)', () => {
        const chunk = makeChunk('chunk-5', ['goldenveil']);
        // No secondaryKeywords field at all — should behave as before
        const result = retrieveRelevantLore([chunk], 'the goldenveil guild is nearby');
        expect(result).toContainEqual(expect.objectContaining({ id: 'chunk-5' }));
    });
});
