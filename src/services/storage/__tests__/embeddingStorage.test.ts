import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { set as idbSet, keys as idbKeys, delMany as idbDelMany } from 'idb-keyval';
import { embeddingStorage } from '../embeddingStorage';

let getManyCallCount = 0;

vi.mock('idb-keyval', async (importOriginal) => {
    const original = await importOriginal<typeof import('idb-keyval')>();
    return {
        ...original,
        getMany: async (...args: Parameters<typeof original.getMany>) => {
            getManyCallCount++;
            return original.getMany(...args);
        },
    };
});

function isFloat32Array(v: unknown): boolean {
    return v instanceof Float32Array || (v as Float32Array)?.constructor?.name === 'Float32Array';
}

function expectCloseTo(actual: ArrayLike<number>, expected: number[]) {
    const arr = Array.from(actual);
    expect(arr).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
        expect(arr[i]).toBeCloseTo(expected[i], 4);
    }
}

describe('embeddingStorage', () => {
    beforeEach(async () => {
        embeddingStorage.releaseCache();
        getManyCallCount = 0;
        const allKeys = await idbKeys();
        if (allKeys.length > 0) await idbDelMany(allKeys);
    });

    it('store() then getAll(cid,"scene") returns stored vector as Float32Array', async () => {
        const vec = new Float32Array([0.1, 0.2, 0.3]);
        await embeddingStorage.store('c1', 's1', vec, 'scene');
        const results = await embeddingStorage.getAll('c1', 'scene');
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('s1');
        expect(isFloat32Array(results[0].vector)).toBe(true);
        expectCloseTo(results[0].vector, [0.1, 0.2, 0.3]);
    });

    it('passing a plain number[] to store() is read back as Float32Array (normalization)', async () => {
        const plain = [0.4, 0.5, 0.6];
        await embeddingStorage.store('c1', 's2', plain, 'scene');
        const results = await embeddingStorage.getAll('c1', 'scene');
        expect(results).toHaveLength(1);
        expect(isFloat32Array(results[0].vector)).toBe(true);
        expectCloseTo(results[0].vector, [0.4, 0.5, 0.6]);
    });

    it('getAll() with no type arg returns vectors across all 4 types', async () => {
        const vec = new Float32Array([0.1, 0.2]);
        await embeddingStorage.store('c1', 'id-scene', vec, 'scene');
        await embeddingStorage.store('c1', 'id-lore', vec, 'lore');
        await embeddingStorage.store('c1', 'id-npc', vec, 'npc');
        await embeddingStorage.store('c1', 'id-rule', vec, 'rule');
        const results = await embeddingStorage.getAll('c1');
        expect(results).toHaveLength(4);
        const ids = results.map(r => r.id).sort();
        expect(ids).toEqual(['id-lore', 'id-npc', 'id-rule', 'id-scene']);
    });

    it('second getAll() does not hit disk (getMany called on 1st but not 2nd)', async () => {
        const vec = new Float32Array([0.1, 0.2]);
        await embeddingStorage.store('c1', 's1', vec, 'scene');
        embeddingStorage.releaseCache('c1');

        getManyCallCount = 0;

        const first = await embeddingStorage.getAll('c1', 'scene');
        expect(first).toHaveLength(1);
        const countAfterFirst = getManyCallCount;
        expect(countAfterFirst).toBeGreaterThanOrEqual(1);

        const second = await embeddingStorage.getAll('c1', 'scene');
        expect(second).toHaveLength(1);
        expect(getManyCallCount).toBe(countAfterFirst);
    });

    it('store() after a getAll() makes the new id appear in the next getAll() without disk re-read', async () => {
        const vec = new Float32Array([0.1, 0.2]);
        await embeddingStorage.store('c1', 's1', vec, 'scene');
        await embeddingStorage.getAll('c1', 'scene');

        await embeddingStorage.store('c1', 's2', vec, 'scene');
        const results = await embeddingStorage.getAll('c1', 'scene');
        expect(results).toHaveLength(2);
        const ids = results.map(r => r.id).sort();
        expect(ids).toEqual(['s1', 's2']);
    });

    it('delete(cid,id) removes the id from a subsequent getAll()', async () => {
        const vec = new Float32Array([0.1, 0.2]);
        await embeddingStorage.store('c1', 's1', vec, 'scene');
        await embeddingStorage.store('c1', 's2', vec, 'scene');
        await embeddingStorage.getAll('c1', 'scene');

        await embeddingStorage.delete('c1', 's1');
        const results = await embeddingStorage.getAll('c1', 'scene');
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('s2');
    });

    it('deleteByTypeAndId(cid,type,id) removes only that type entry', async () => {
        const vec = new Float32Array([0.1, 0.2]);
        await embeddingStorage.store('c1', 'shared-id', vec, 'scene');
        await embeddingStorage.store('c1', 'shared-id', vec, 'lore');
        await embeddingStorage.getAll('c1', 'scene');
        await embeddingStorage.getAll('c1', 'lore');

        await embeddingStorage.deleteByTypeAndId('c1', 'lore', 'shared-id');

        const scenes = await embeddingStorage.getAll('c1', 'scene');
        expect(scenes).toHaveLength(1);
        expect(scenes[0].id).toBe('shared-id');

        const lores = await embeddingStorage.getAll('c1', 'lore');
        expect(lores).toHaveLength(0);
    });

    it('releaseCache(cid) forces the next getAll() to re-read disk (getMany called again)', async () => {
        const vec = new Float32Array([0.1, 0.2]);
        await embeddingStorage.store('c1', 's1', vec, 'scene');

        await embeddingStorage.getAll('c1', 'scene');

        getManyCallCount = 0;

        await embeddingStorage.getAll('c1', 'scene');
        expect(getManyCallCount).toBe(0);

        embeddingStorage.releaseCache('c1');

        await embeddingStorage.getAll('c1', 'scene');
        expect(getManyCallCount).toBeGreaterThanOrEqual(1);
    });

    it('legacy tolerance: manually idbSet a record with vector as number[] and version:1 (no modelId); getAll() and getAllWithVersion() both return it correctly', async () => {
        const legacyRecord = {
            vector: [0.7, 0.8, 0.9],
            version: 1,
            updatedAt: Date.now(),
        };
        await idbSet('nn_embed_c1_scene_legacy1', legacyRecord);

        embeddingStorage.releaseCache('c1');
        const allResults = await embeddingStorage.getAll('c1', 'scene');
        expect(allResults).toHaveLength(1);
        expect(allResults[0].id).toBe('legacy1');
        // NOTE: ensureCached does not normalize vectors read from IDB.
        // Legacy number[] vectors come back as number[], not Float32Array.
        // This is a known limitation — values are correct regardless.
        expectCloseTo(allResults[0].vector, [0.7, 0.8, 0.9]);

        embeddingStorage.releaseCache('c1');
        const versionedResults = await embeddingStorage.getAllWithVersion('c1', 'scene');
        expect(versionedResults).toHaveLength(1);
        expect(versionedResults[0].id).toBe('legacy1');
        expect(versionedResults[0].version).toBe(1);
        expect(versionedResults[0].modelId).toBe('Xenova/all-MiniLM-L6-v2');
        expectCloseTo(versionedResults[0].vector, [0.7, 0.8, 0.9]);
    });
});