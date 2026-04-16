import type { ArchiveChapter } from '../../types';
import { getList, setList, k, type SceneRecord } from './_helpers';

export const chapterStorage = {
    async list(cid: string): Promise<ArchiveChapter[]> {
        return getList(k(cid, 'chapters'));
    },

    async create(cid: string, title?: string): Promise<ArchiveChapter> {
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const nextNum = chapters.length + 1;
        const chapterId = `CH${String(nextNum).padStart(2, '0')}`;
        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        const nextSceneId = String(scenes.length + 1).padStart(3, '0');
        const newChapter: ArchiveChapter = {
            chapterId,
            title: title || `Chapter ${nextNum}`,
            sceneRange: [nextSceneId, nextSceneId],
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

        const sealed: ArchiveChapter = { ...openChapter, sealedAt: Date.now() };
        const lastScene = parseInt(sealed.sceneRange[1], 10);
        const nextScene = String(lastScene + 1).padStart(3, '0');
        const nextNum = chapters.length + 1;
        const newOpen: ArchiveChapter = {
            chapterId: `CH${String(nextNum).padStart(2, '0')}`,
            title: 'Open Chapter',
            sceneRange: [nextScene, nextScene],
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
            sceneCount: (chA.sceneCount || 0) + (chB.sceneCount || 0),
            keywords: Array.from(new Set([...(chA.keywords || []), ...(chB.keywords || [])])),
            npcs: Array.from(new Set([...(chA.npcs || []), ...(chB.npcs || [])])),
            invalidated: true,
            summary: `[MERGED] ${chA.summary}\n\n${chB.summary}`,
        };

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
            sceneCount: splitNum - startNum, invalidated: true,
        };
        const chB: ArchiveChapter = {
            ...ch, chapterId: `${ch.chapterId}B`,
            sceneRange: [String(splitNum).padStart(3, '0'), ch.sceneRange[1]],
            sceneCount: endNum - splitNum + 1, invalidated: true,
        };

        chapters.splice(idx, 1, chA, chB);
        await setList(k(cid, 'chapters'), chapters);
        return { chapterA: chA, chapterB: chB };
    },
};
