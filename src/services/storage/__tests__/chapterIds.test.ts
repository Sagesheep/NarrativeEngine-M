import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clear, set } from 'idb-keyval';
import { chapterStorage } from '../chapterStorage';
import { nextChapterNumber } from '../../../utils/chapterIds';
import type { ArchiveChapter } from '../../../types';

const CID = 'chapter-ids';
const chapter = (chapterId: string, start: string, end: string, sealed: boolean): ArchiveChapter => ({
    chapterId, title: chapterId, sceneRange: [start, end], sceneIds: [],
    summary: `${chapterId} summary`, keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
    tone: '', themes: [], sceneCount: 0, ...(sealed ? { sealedAt: 1 } : {}),
});

beforeEach(async () => { await clear(); });

describe('nextChapterNumber', () => {
    it('is one past the highest CH number, not the chapter count', () => {
        expect(nextChapterNumber([])).toBe(1);
        expect(nextChapterNumber([chapter('CH01', '001', '010', true), chapter('CH03', '011', '020', false)])).toBe(4);
        expect(nextChapterNumber([chapter('CH02A', '001', '005', true), chapter('CH02B', '006', '010', true)])).toBe(3);
    });
});

describe('chapter ids after merge', () => {
    it('a chapter created after a merge does not reuse a live id', async () => {
        await set(`${CID}_chapters`, [
            chapter('CH01', '001', '010', true),
            chapter('CH02', '011', '020', true),
            chapter('CH03', '021', '025', false),
        ]);
        await chapterStorage.merge(CID, 'CH01', 'CH02');
        const created = await chapterStorage.create(CID);
        expect(created.chapterId).toBe('CH04');
        const all = await chapterStorage.list(CID);
        expect(new Set(all.map(c => c.chapterId)).size).toBe(all.length);
    });

    it('merging a sealed chapter with the open one leaves it open', async () => {
        await set(`${CID}_chapters`, [
            chapter('CH01', '001', '010', true),
            chapter('CH02', '011', '015', false),
        ]);
        const merged = await chapterStorage.merge(CID, 'CH01', 'CH02');
        expect(merged?.sealedAt).toBeUndefined();
        const all = await chapterStorage.list(CID);
        expect(all.filter(c => !c.sealedAt)).toHaveLength(1);
    });
});
