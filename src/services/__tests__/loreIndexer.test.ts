import { describe, it, expect, vi, beforeEach } from 'vitest';
import { indexLore, deriveDefaultLoreMeta, upgradeVectorOnlyDefault } from '../lore/loreIndexer';
import type { LoreChunk } from '../../types';

vi.mock('../storage/embeddingStorage', () => ({
    embeddingStorage: {
        getAll: vi.fn(),
        store: vi.fn(),
        deleteByTypeAndId: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('../embedding', () => ({
    getCurrentModelId: vi.fn(() => 'test-model-v1'),
}));

vi.mock('../embedding/embeddingScheduler', () => ({
    enqueueProgressiveWithExistingCheck: vi.fn(() => Promise.resolve()),
}));

import { embeddingStorage } from '../storage/embeddingStorage';
import { enqueueProgressiveWithExistingCheck } from '../embedding/embeddingScheduler';

const mockGetAll = embeddingStorage.getAll as ReturnType<typeof vi.fn>;
const mockEnqueue = enqueueProgressiveWithExistingCheck as ReturnType<typeof vi.fn>;

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

describe('upgradeVectorOnlyDefault', () => {
    it('upgrades legacy [vector]-only to [vector, keyword]', () => {
        expect(upgradeVectorOnlyDefault(['vector'])).toEqual(['vector', 'keyword']);
    });

    it('leaves [vector, keyword] unchanged', () => {
        const modes: ('vector' | 'keyword' | 'always')[] = ['vector', 'keyword'];
        expect(upgradeVectorOnlyDefault(modes)).toBe(modes);
    });

    it('leaves [keyword]-only unchanged', () => {
        const modes: ('vector' | 'keyword' | 'always')[] = ['keyword'];
        expect(upgradeVectorOnlyDefault(modes)).toBe(modes);
    });

    it('leaves [always] unchanged', () => {
        const modes: ('vector' | 'keyword' | 'always')[] = ['always'];
        expect(upgradeVectorOnlyDefault(modes)).toBe(modes);
    });

    it('passes undefined through (caller derives default)', () => {
        expect(upgradeVectorOnlyDefault(undefined)).toBeUndefined();
    });
});

describe('indexLore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('enqueues only vector-mode chunks that need embedding', async () => {
        const existingChunk = makeChunk('existing-1', { embeddedModelId: 'test-model-v1' });
        const newChunk = makeChunk('new-1');

        mockGetAll.mockResolvedValue([{ id: 'existing-1', vector: [0.1] }]);

        const chunks = [existingChunk, newChunk];
        await indexLore('campaign-1', chunks);

        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        const callArgs = mockEnqueue.mock.calls[0][0];
        expect(callArgs.campaignId).toBe('campaign-1');
        expect(callArgs.type).toBe('lore');
        const enqueuedIds = callArgs.chunks.map((c: any) => c.id);
        expect(enqueuedIds).toContain('new-1');
        expect(enqueuedIds).not.toContain('existing-1');
    });

    it('re-embeds chunks whose embeddedModelId differs from current model', async () => {
        const chunk = makeChunk('stale-1', { embeddedModelId: 'old-model-v0' });

        mockGetAll.mockResolvedValue([{ id: 'stale-1', vector: [0.1] }]);

        await indexLore('campaign-1', [chunk]);

        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        expect(chunk.embeddedModelId).toBe('test-model-v1');
    });

    it('skips embedding for chunks already embedded with current model', async () => {
        const chunk = makeChunk('fresh-1', { embeddedModelId: 'test-model-v1' });

        mockGetAll.mockResolvedValue([{ id: 'fresh-1', vector: [0.1] }]);

        await indexLore('campaign-1', [chunk]);

        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('skips always-mode chunks from enqueue', async () => {
        const alwaysChunk = makeChunk('always-1', { alwaysInclude: true });

        mockGetAll.mockResolvedValue([]);

        await indexLore('campaign-1', [alwaysChunk]);

        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('deletes orphan embeddings', async () => {
        const chunk = makeChunk('kept-1');

        mockGetAll.mockResolvedValue([
            { id: 'kept-1', vector: [0.1] },
            { id: 'orphan-1', vector: [0.2] },
        ]);

        await indexLore('campaign-1', [chunk]);

        expect(embeddingStorage.deleteByTypeAndId).toHaveBeenCalledWith('campaign-1', 'lore', 'orphan-1');
    });

    it('does nothing when chunks array is empty', async () => {
        await indexLore('campaign-1', []);
        expect(mockEnqueue).not.toHaveBeenCalled();
        expect(embeddingStorage.store).not.toHaveBeenCalled();
    });
});