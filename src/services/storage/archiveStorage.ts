import { del as idbDel } from 'idb-keyval';
import type { ArchiveChapter, SemanticFact } from '../../types';
import { buildArchiveIndexEntry } from '../archive';
import { getList, setList, k, type SceneRecord } from './_helpers';

export const archiveStorage = {
    async getNextSceneNumber(cid: string): Promise<number> {
        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        return scenes.length + 1;
    },

    async appendCore(
        cid: string,
        userContent: string,
        assistantContent: string,
    ): Promise<{ sceneId: string; sceneNumber: number; indexEntry: import('../../types').ArchiveIndexEntry; timestamp: number } | undefined> {
        try {
            const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
            const sceneNumber = scenes.length + 1;
            const sceneId = String(sceneNumber).padStart(3, '0');
            const timestamp = Date.now();

            scenes.push({ sceneId, userContent, assistantContent, timestamp });
            await setList(k(cid, 'scenes'), scenes);

            const indexEntry = buildArchiveIndexEntry(sceneId, timestamp, userContent, assistantContent);
            const index = await getList<import('../../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
            index.push(indexEntry);
            await setList(k(cid, 'archive_index'), index);

            return { sceneId, sceneNumber, indexEntry, timestamp };
        } catch (err) {
            console.error('[OfflineStorage] Archive append failed:', err);
            return undefined;
        }
    },

    async getIndex(cid: string) {
        return getList<import('../../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
    },

    async getScenes(cid: string, sceneIds: string[]): Promise<{ sceneId: string; content: string }[]> {
        if (sceneIds.length === 0) return [];
        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        return scenes
            .filter(s => sceneIds.includes(s.sceneId))
            .map(s => ({
                sceneId: s.sceneId,
                content: `## SCENE ${s.sceneId}\n*${new Date(s.timestamp).toLocaleString()}*\n\n**[USER]**\n${s.userContent}\n\n**[GM]**\n${s.assistantContent}\n\n---`,
            }));
    },

    async deleteFrom(cid: string, fromSceneId: string): Promise<{ ok: boolean; chaptersRepaired: boolean }> {
        const fromNum = parseInt(fromSceneId.padStart(3, '0'), 10);

        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        await setList(k(cid, 'scenes'), scenes.filter(s => parseInt(s.sceneId, 10) < fromNum));

        const index = await getList<import('../../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
        await setList(k(cid, 'archive_index'), index.filter(e => parseInt(e.sceneId, 10) < fromNum));

        const facts = await getList<SemanticFact>(k(cid, 'facts'));
        await setList(k(cid, 'facts'), facts.filter(f => parseInt(f.sceneId, 10) < fromNum));

        const timeline = await getList<import('../../types').TimelineEvent>(k(cid, 'timeline'));
        await setList(k(cid, 'timeline'), timeline.filter(e => parseInt(e.sceneId, 10) < fromNum));

        let chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        let chaptersRepaired = false;
        const originalCount = chapters.length;

        chapters = chapters.filter(ch => parseInt(ch.sceneRange[0], 10) < fromNum);
        for (const ch of chapters) {
            const endNum = parseInt(ch.sceneRange[1], 10);
            if (endNum >= fromNum) {
                ch.sceneRange[1] = String(fromNum - 1).padStart(3, '0');
                ch.invalidated = true;
                delete ch.sealedAt;
                ch.sceneCount = fromNum - parseInt(ch.sceneRange[0], 10);
                ch.sceneIds = (ch.sceneIds ?? []).filter(id => parseInt(id, 10) < fromNum);
                chaptersRepaired = true;
            }
        }
        if (chapters.length !== originalCount) chaptersRepaired = true;

        const openChapter = chapters.find(ch => !ch.sealedAt);
        if (!openChapter) {
            const nextNum = chapters.length + 1;
            chapters.push({
                chapterId: `CH${String(nextNum).padStart(2, '0')}`,
                title: `Chapter ${nextNum}`,
                sceneRange: [fromSceneId.padStart(3, '0'), fromSceneId.padStart(3, '0')],
                sceneIds: [],
                summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
                tone: '', themes: [], sceneCount: 0,
            });
            chaptersRepaired = true;
        }
        await setList(k(cid, 'chapters'), chapters);

        return { ok: true, chaptersRepaired };
    },

    async clear(cid: string): Promise<void> {
        await idbDel(k(cid, 'scenes'));
        await idbDel(k(cid, 'archive_index'));
        await idbDel(k(cid, 'chapters'));
    },

    async updateIndex(cid: string, index: import('../../types').ArchiveIndexEntry[]): Promise<void> {
        await setList(k(cid, 'archive_index'), index);
    },

    // Whole-word, case-insensitive rename of a name across the sealed archive:
    // scene prose (user + GM) plus the index snippet/keyword/mention text. Used by
    // the manual highlight→rename tool. Returns the number of scenes touched.
    async renameText(cid: string, from: string, to: string): Promise<number> {
        const fromTrim = from.trim();
        if (!fromTrim || !to.trim()) return 0;
        const pat = `\\b${fromTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        const sub = (txt: string) => txt.replace(new RegExp(pat, 'gi'), to);

        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        let changed = 0;
        const newScenes = scenes.map(s => {
            const uc = sub(s.userContent);
            const ac = sub(s.assistantContent);
            if (uc !== s.userContent || ac !== s.assistantContent) changed++;
            return { ...s, userContent: uc, assistantContent: ac };
        });
        if (changed > 0) await setList(k(cid, 'scenes'), newScenes);

        const index = await getList<import('../../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
        let idxChanged = false;
        const newIndex = index.map(e => {
            const userSnippet = e.userSnippet ? sub(e.userSnippet) : e.userSnippet;
            const keywords = e.keywords?.map(sub);
            const npcsMentioned = e.npcsMentioned?.map(sub);
            if (userSnippet !== e.userSnippet
                || JSON.stringify(keywords) !== JSON.stringify(e.keywords)
                || JSON.stringify(npcsMentioned) !== JSON.stringify(e.npcsMentioned)) {
                idxChanged = true;
                return { ...e, userSnippet, keywords, npcsMentioned };
            }
            return e;
        });
        if (idxChanged) await setList(k(cid, 'archive_index'), newIndex);

        return changed;
    },
};
