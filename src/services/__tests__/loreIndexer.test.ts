import { describe, it, expect, vi, beforeEach } from 'vitest';
import { indexLore, deriveDefaultLoreMeta } from '../lore/loreIndexer';
import type { LoreChunk } from '../../types';

vi.mock('../storage/embeddingStorage', () => ({
    embeddingStorage: {
        getAll: vi.fn(),
        store: vi.fn(),
        deleteByTypeAndId: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('../embedding', () => ({
    embedText: vi.fn(() => Promise.resolve(new Float32Array([0.1, 0.2, 0.3]))),
    getCurrentModelId: vi.fn(() => 'test-model-v1'),
}));

import { embeddingStorage } from '../storage/embeddingStorage';
import { embedText } from '../embedding';

const mockGetAll = embeddingStorage.getAll as ReturnType<typeof vi.fn>;

const makeChunk = (id: string, opts: Partial<LoreChunk> = {}): LoreChunk => ({
    id,
    header: `Header for ${id}`,
    content: `Content about ${id} with some descriptive text to embed.`,
    tokens: 50,
    alwaysInclude: false,
    triggerKeywords: [id],
    scanDepth: 2,
    category: 'character',
    linkedEntities: [],
    priority: 5,
    ...opts,
});

describe('deriveDefaultLoreMeta', () => {
    it('returns existing activationModes if set', () => {
        const chunk = makeChunk('test', { activationModes: ['always'] });
        expect(deriveDefaultLoreMeta(chunk)).toEqual(['always']);
    });

    it('derives from ragMode when activationModes undefined', () => {
        const chunk = makeChunk('test', { ragMode: 'keyword' });
        expect(deriveDefaultLoreMeta(chunk)).toEqual(['keyword']);
    });

    it('derives always for alwaysInclude=true (no activationModes, no ragMode)', () => {
        const chunk = makeChunk('test', { alwaysInclude: true });
        expect(deriveDefaultLoreMeta(chunk)).toEqual(['always']);
    });

    it('derives always for priority>=9 (no activationModes, no ragMode)', () => {
        const chunk = makeChunk('test', { priority: 9 });
        expect(deriveDefaultLoreMeta(chunk)).toEqual(['always']);
    });

    it('defaults to [vector, keyword] when no hints', () => {
        const chunk = makeChunk('test', { priority: 5 });
        expect(deriveDefaultLoreMeta(chunk)).toEqual(['vector', 'keyword']);
    });
});

describe('indexLore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('embeds only new chunks (skips existing ids)', async () => {
        const existingChunk = makeChunk('existing-1', { embeddedModelId: 'test-model-v1' });
        const newChunk = makeChunk('new-1');

        mockGetAll.mockResolvedValue([{ id: 'existing-1', vector: [0.1] }]);

        const chunks = [existingChunk, newChunk];
        await indexLore('campaign-1', chunks);

        // Only the new chunk should be embedded (existing-1 already embedded with current model)
        expect(embedText).toHaveBeenCalledTimes(1);
        expect(embedText).toHaveBeenCalledWith(expect.stringContaining('new-1'));
        expect(embeddingStorage.store).toHaveBeenCalledTimes(1);
    });

    it('re-embeds chunks whose embeddedModelId differs from current model', async () => {
        const chunk = makeChunk('stale-1', { embeddedModelId: 'old-model-v0' });

        mockGetAll.mockResolvedValue([{ id: 'stale-1', vector: [0.1] }]);

        await indexLore('campaign-1', [chunk]);

        expect(embedText).toHaveBeenCalledTimes(1);
        expect(chunk.embeddedModelId).toBe('test-model-v1');
    });

    it('skips embedding for chunks already embedded with current model', async () => {
        const chunk = makeChunk('fresh-1', { embeddedModelId: 'test-model-v1' });

        mockGetAll.mockResolvedValue([{ id: 'fresh-1', vector: [0.1] }]);

        await indexLore('campaign-1', [chunk]);

        expect(embedText).not.toHaveBeenCalled();
    });

    it('deletes orphan embeddings', async () => {
        const chunk = makeChunk('kept-1');

        // Embedding storage has 'orphan-1' and 'kept-1', but chunk list only has 'kept-1'
        mockGetAll.mockResolvedValue([
            { id: 'kept-1', vector: [0.1] },
            { id: 'orphan-1', vector: [0.2] },
        ]);

        await indexLore('campaign-1', [chunk]);

        expect(embeddingStorage.deleteByTypeAndId).toHaveBeenCalledWith('campaign-1', 'lore', 'orphan-1');
    });

    it('does nothing when chunks array is empty', async () => {
        await indexLore('campaign-1', []);
        expect(embedText).not.toHaveBeenCalled();
        expect(embeddingStorage.store).not.toHaveBeenCalled();
    });
});