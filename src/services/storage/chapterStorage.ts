import type { ArchiveChapter } from '../../types';
import { nextChapterNumber, chapterIdFor } from '../../utils/chapterIds';
import { getList, setList, k, type SceneRecord } from './_helpers';

export function backfillSceneIds(chapters: ArchiveChapter[]): { chapters: ArchiveChapter[]; changed: boolean } {
    let changed = false;
    const result = chapters.map(ch => {
        if (ch.sceneIds && ch.sceneIds.length > 0) return ch;
        const start = parseInt(ch.sceneRange[0], 10);
        const end = parseInt(ch.sceneRange[1], 10);
        if (isNaN(start) || isNaN(end) || end < start) return { ...ch, sceneIds: [] as string[] };
        const sceneIds: string[] = [];
        for (let i = start; i <= end; i++) sceneIds.push(String(i).padStart(3, '0'));
        changed = true;
        return { ...ch, sceneIds };
    });
    return { chapters: result, changed };
}

export const chapterStorage = {
    async list(cid: string): Promise<ArchiveChapter[]> {
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const { chapters: backfilled, changed } = backfillSceneIds(chapters);
        if (changed) {
            await setList(k(cid, 'chapters'), backfilled);
            console.log(`[ChapterStorage] Backfilled sceneIds for ${backfilled.filter(c => c.sceneIds && c.sceneIds.length > 0 && !(chapters.find(o => o.chapterId === c.chapterId)?.sceneIds?.length)).length} legacy chapter(s)`);
        }
        return backfilled;
    },

    async create(cid: string, title?: string): Promise<ArchiveChapter> {
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const nextNum = nextChapterNumber(chapters);
        const chapterId = chapterIdFor(nextNum);
        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        const nextSceneId = String(scenes.length + 1).padStart(3, '0');
        const newChapter: ArchiveChapter = {
            chapterId,
            title: title || `Chapter ${nextNum}`,
            sceneRange: [nextSceneId, nextSceneId],
            sceneIds: [],
            summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
            tone: '', themes: [], sceneCount: 0,
        };
        chapters.push(newChapter);
        await setList(k(cid, 'chapters'), chapters);
        return newChapter;
    },

    async update(cid: string, chapterId: string, patch: Partial<ArchiveChapter>): Promise<void> {
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const idx = chapters.findIndex(c => c.chapterId === chapterId);
        if (idx === -1) return;
        chapters[idx] = { ...chapters[idx], ...patch };
        await setList(k(cid, 'chapters'), chapters);
    },

    async seal(cid: string): Promise<{ sealedChapter: ArchiveChapter; newOpenChapter: ArchiveChapter } | null> {
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const openChapter = chapters.find(c => !c.sealedAt);
        if (!openChapter) return null;

        // B4 — dedupe sceneIds on seal (boundary scene was recording twice in some saves).
        const dedupedIds = Array.from(new Set(openChapter.sceneIds ?? []));
        const sealed: ArchiveChapter = {
            ...openChapter,
            sceneIds: dedupedIds,
            sceneCount: dedupedIds.length,
            sealedAt: Date.now(),
        };
        const lastScene = parseInt(sealed.sceneRange[1], 10);
        const nextScene = String(lastScene + 1).padStart(3, '0');
        const nextNum = nextChapterNumber(chapters);
        const newOpen: ArchiveChapter = {
            chapterId: chapterIdFor(nextNum),
            title: 'Open Chapter',
            sceneRange: [nextScene, nextScene],
            sceneIds: [],
            summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
            tone: '', themes: [], sceneCount: 0,
        };

        const openIdx = chapters.findIndex(c => c.chapterId === openChapter.chapterId);
        chapters[openIdx] = sealed;
        chapters.push(newOpen);
        await setList(k(cid, 'chapters'), chapters);
        return { sealedChapter: sealed, newOpenChapter: newOpen };
    },

    async merge(cid: string, chapterIdA: string, chapterIdB: string): Promise<ArchiveChapter | null> {
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const idxA = chapters.findIndex(c => c.chapterId === chapterIdA);
        const idxB = chapters.findIndex(c => c.chapterId === chapterIdB);
        if (idxA === -1 || idxB === -1) return null;
        if (Math.abs(idxA - idxB) !== 1) return null;

        const firstIdx = Math.min(idxA, idxB);
        const secondIdx = Math.max(idxA, idxB);
        const chA = chapters[firstIdx];
        const chB = chapters[secondIdx];

        const merged: ArchiveChapter = {
            ...chA,
            title: `${chA.title} & ${chB.title}`,
            sceneRange: [chA.sceneRange[0], chB.sceneRange[1]],
            sceneIds: [...(chA.sceneIds ?? []), ...(chB.sceneIds ?? [])],
            sceneCount: (chA.sceneCount || 0) + (chB.sceneCount || 0),
            keywords: Array.from(new Set([...(chA.keywords || []), ...(chB.keywords || [])])),
            npcs: Array.from(new Set([...(chA.npcs || []), ...(chB.npcs || [])])),
            invalidated: true,
            summary: `[MERGED] ${chA.summary}\n\n${chB.summary}`,
        };
        // Merging into the open chapter keeps it open — otherwise no chapter is left
        // to receive new scenes. It gets summarized when it seals.
        if (!chA.sealedAt || !chB.sealedAt) {
            delete merged.sealedAt;
            delete merged.invalidated;
        }

        chapters.splice(firstIdx, 2, merged);
        await setList(k(cid, 'chapters'), chapters);
        return merged;
    },

    async split(cid: string, chapterId: string, atSceneId: string): Promise<{ chapterA: ArchiveChapter; chapterB: ArchiveChapter } | null> {
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const idx = chapters.findIndex(c => c.chapterId === chapterId);
        if (idx === -1) return null;

        const ch = chapters[idx];
        const startNum = parseInt(ch.sceneRange[0], 10);
        const endNum = parseInt(ch.sceneRange[1], 10);
        const splitNum = parseInt(atSceneId, 10);
        if (splitNum <= startNum || splitNum > endNum) return null;

        const chA: ArchiveChapter = {
            ...ch, chapterId: `${ch.chapterId}A`,
            sceneRange: [ch.sceneRange[0], String(splitNum - 1).padStart(3, '0')],
            sceneIds: (ch.sceneIds ?? []).filter(id => parseInt(id) < splitNum),
            sceneCount: splitNum - startNum, invalidated: true,
        };
        const chB: ArchiveChapter = {
            ...ch, chapterId: `${ch.chapterId}B`,
            sceneRange: [String(splitNum).padStart(3, '0'), ch.sceneRange[1]],
            sceneIds: (ch.sceneIds ?? []).filter(id => parseInt(id) >= splitNum),
            sceneCount: endNum - splitNum + 1, invalidated: true,
        };

        chapters.splice(idx, 1, chA, chB);
        await setList(k(cid, 'chapters'), chapters);
        return { chapterA: chA, chapterB: chB };
    },
};
