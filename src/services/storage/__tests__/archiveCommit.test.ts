import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { clear, get, set } from 'idb-keyval';
import { archiveStorage } from '../archiveStorage';
import type { ArchiveChapter, ArchiveIndexEntry } from '../../../types';
import type { SceneRecord } from '../_helpers';

const CID = 'atomic-archive';
const keys = ['scenes', 'archive_index', 'facts', 'chapters'].map(s => `${CID}_${s}`);
beforeEach(async () => { await clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('durable archive commit', () => {
    it('commits prose, index, facts and chapter membership together', async () => {
        const result = await archiveStorage.appendCore(CID, 'Hello', 'The gate opens.', 'gm-1');
        expect(result.created).toBe(true);
        expect(await get<SceneRecord[]>(keys[0])).toEqual([expect.objectContaining({ sceneId: '001', commitId: 'gm-1' })]);
        expect(await get<ArchiveIndexEntry[]>(keys[1])).toHaveLength(1);
        expect(await get(keys[2])).toEqual([]);
        expect(await get<ArchiveChapter[]>(keys[3])).toEqual([expect.objectContaining({ sceneIds: ['001'], sceneCount: 1 })]);
    });

    it.each(keys)('rolls back every record when writing %s fails, then permits retry', async failedKey => {
        await archiveStorage.appendCore(CID, 'first', 'first reply', 'gm-1');
        const before = await Promise.all(keys.map(key => get(key)));
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
            if (key === failedKey) throw new DOMException('Storage full', 'QuotaExceededError');
            return put.call(this, value, key);
        });
        await expect(archiveStorage.appendCore(CID, 'second', 'second reply', 'gm-2')).rejects.toThrow('Storage full');
        expect(await Promise.all(keys.map(key => get(key)))).toEqual(before);
        vi.restoreAllMocks();
        expect(await archiveStorage.appendCore(CID, 'second', 'second reply', 'gm-2')).toMatchObject({ sceneId: '002', created: true });
    });

    it('rolls back asynchronous transaction aborts, including earlier successful puts', async () => {
        const put = IDBObjectStore.prototype.put;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
            const request = put.call(this, value, key);
            if (key === keys[3]) request.onsuccess = () => this.transaction.abort();
            return request;
        });
        await expect(archiveStorage.appendCore(CID, 'hello', 'reply', 'gm-1')).rejects.toThrow();
        expect(await Promise.all(keys.map(key => get(key)))).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('reuses the committed scene after restart without duplicating chapter membership', async () => {
        await archiveStorage.appendCore(CID, 'hello', 'reply', 'gm-1');
        expect(await archiveStorage.appendCore(CID, 'hello', 'reply', 'gm-1')).toMatchObject({ sceneId: '001', created: false });
        expect(await get(keys[0])).toHaveLength(1);
        expect(await get<ArchiveChapter[]>(keys[3])).toEqual([expect.objectContaining({ sceneIds: ['001'], sceneCount: 1 })]);
        await expect(archiveStorage.appendCore(CID, 'hello', 'edited reply', 'gm-1')).rejects.toThrow('different text');
    });

    it('serializes simultaneous retries and allocates unique scene numbers for different turns', async () => {
        const results = await Promise.all([
            archiveStorage.appendCore(CID, 'hello', 'reply', 'gm-1'),
            archiveStorage.appendCore(CID, 'hello', 'reply', 'gm-1'),
            archiveStorage.appendCore(CID, 'next', 'next reply', 'gm-2'),
        ]);
        expect(results.map(r => r.sceneId)).toEqual(['001', '001', '002']);
        expect(await get(keys[0])).toHaveLength(2);
    });

    it('keeps the legacy chapter boundary deduplication behavior', async () => {
        await set(keys[3], [{ chapterId: 'CH01', sceneRange: ['001', '001'], sceneIds: ['001'], sceneCount: 1 }]);
        await archiveStorage.appendCore(CID, 'hello', 'reply', 'gm-1');
        expect(await get<ArchiveChapter[]>(keys[3])).toEqual([expect.objectContaining({ sceneIds: ['001'], sceneCount: 1 })]);
    });
});
