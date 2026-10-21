import { describe, it, expect, vi, beforeEach } from 'vitest';

// The embedder runs on the phone, so the same text must not be embedded again for
// every search a turn makes (scene, lore and rule searches, then NPC recall).

const h = vi.hoisted(() => ({
    embedText: vi.fn(),
    modelId: 'model-a',
    getAll: vi.fn(),
}));

vi.mock('../embedding/embedder', () => ({
    embedText: h.embedText,
    isEmbedderReady: () => true,
    getCurrentModelId: () => h.modelId,
    calibrateScoreFloor: (floor: number) => floor,
}));
vi.mock('../storage', () => ({
    offlineStorage: { embeddings: { getAll: h.getAll } },
}));

import { semanticSearchScored } from '../embedding/vectorSearch';

beforeEach(() => {
    h.embedText.mockReset();
    h.embedText.mockImplementation(async () => new Float32Array([1, 0, 0]));
    h.getAll.mockReset();
    h.getAll.mockResolvedValue([{ id: 'x', vector: [1, 0, 0] }]);
    h.modelId = 'model-a';
});

describe('semanticSearchScored — query vectors', () => {
    it('searches started together embed a shared query once', async () => {
        await Promise.all([
            semanticSearchScored('c', ['the gate at dawn'], 'scene'),
            semanticSearchScored('c', ['the gate at dawn'], 'lore'),
            semanticSearchScored('c', ['the gate at dawn'], 'rule'),
        ]);
        expect(h.embedText).toHaveBeenCalledTimes(1);
    });

    it('a later search reuses the vector', async () => {
        await semanticSearchScored('c', ['who was at the docks'], 'scene');
        await semanticSearchScored('c', ['who was at the docks', 'a new line'], 'npc');
        expect(h.embedText.mock.calls.map(c => c[0])).toEqual(['who was at the docks', 'a new line']);
    });

    it('a different embedding model embeds again', async () => {
        await semanticSearchScored('c', ['the old mill'], 'scene');
        h.modelId = 'model-b';
        await semanticSearchScored('c', ['the old mill'], 'scene');
        expect(h.embedText).toHaveBeenCalledTimes(2);
    });

    it('a failed embed is not remembered', async () => {
        h.embedText.mockResolvedValueOnce(null);
        expect(await semanticSearchScored('c', ['a failed query'], 'scene')).toBeUndefined();
        await semanticSearchScored('c', ['a failed query'], 'scene');
        expect(h.embedText).toHaveBeenCalledTimes(2);
    });
});

describe('semanticSearchScored — vectors from another model', () => {
    it('leaves out vectors the loaded model did not make', async () => {
        h.getAll.mockResolvedValue([
            { id: 'old', vector: [1, 0, 0], modelId: 'model-old' },
            { id: 'new', vector: [0.9, 0.1, 0], modelId: 'model-a' },
            { id: 'untagged', vector: [0.8, 0.2, 0] },
        ]);
        const hits = await semanticSearchScored('c', ['the gate'], 'lore');
        expect(hits?.map(x => x.id)).toEqual(['new', 'untagged']);
    });
});
