import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../storage/embeddingStorage', () => ({
    EMBEDDING_VERSION: 4,
    embeddingStorage: {
        getAll: vi.fn(() => Promise.resolve([])),
        getAllWithVersion: vi.fn(() => Promise.resolve([])),
        deleteByTypeAndId: vi.fn(() => Promise.resolve()),
        store: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('../embedding/embeddingScheduler', () => ({
    enqueueProgressiveWithExistingCheck: vi.fn(() => Promise.resolve()),
}));

vi.mock('../llm/llmCall', () => ({
    llmCall: vi.fn(() => Promise.resolve('{"primary":[],"secondary":[]}')),
}));

import { indexRules } from '../lore/rulesIndexer';
import { embeddingStorage } from '../storage/embeddingStorage';

const mockGetAllWithVersion = embeddingStorage.getAllWithVersion as ReturnType<typeof vi.fn>;
const mockDelete = embeddingStorage.deleteByTypeAndId as ReturnType<typeof vi.fn>;

const RULES_MD = `## Grappling
A creature can attempt to grapple a target within reach. The target may resist.

## Concentration
Some spells require concentration to maintain their effect over time.`;

describe('indexRules — truncated-rule migration', () => {
    beforeEach(() => vi.clearAllMocks());

    it('deletes rule vectors with version < EMBEDDING_VERSION so they re-embed', async () => {
        mockGetAllWithVersion.mockResolvedValue([
            { id: 'old-rule', vector: [0.1], version: 3, type: 'rule', modelId: 'm' },
            { id: 'fresh-rule', vector: [0.2], version: 4, type: 'rule', modelId: 'm' },
        ]);

        await indexRules('c1', RULES_MD, undefined, undefined, false);

        // stale (v3) deleted, current (v4) left alone
        expect(mockDelete).toHaveBeenCalledWith('c1', 'rule', 'old-rule');
        expect(mockDelete).not.toHaveBeenCalledWith('c1', 'rule', 'fresh-rule');
    });

    it('does not delete anything when all rule vectors are current', async () => {
        mockGetAllWithVersion.mockResolvedValue([
            { id: 'r1', vector: [0.1], version: 4, type: 'rule', modelId: 'm' },
        ]);

        await indexRules('c1', RULES_MD, undefined, undefined, false);

        // no version-based deletion (orphan cleanup may still run, but r1 is a current vector)
        expect(mockDelete).not.toHaveBeenCalledWith('c1', 'rule', 'r1');
    });
});
