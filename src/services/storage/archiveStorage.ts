import { createStore, del as idbDel, type UseStore } from 'idb-keyval';
import { nextChapterNumber, chapterIdFor } from '../../utils/chapterIds';
import type { ArchiveChapter, SemanticFact } from '../../types';
import { buildArchiveIndexEntry, extractNPCFacts } from '../archive';
import { getList, setList, k, type SceneRecord } from './_helpers';

// Use the same database/object store as idb-keyval's default store. All reads
// and writes must share one readwrite transaction, including scene allocation.
let archiveStore: UseStore | undefined;

function nextSceneNumber(scenes: SceneRecord[]): number {
    let max = 0;
    for (const s of scenes) {
        const n = parseInt(s.sceneId, 10);
        if (!Number.isNaN(n) && n > max) max = n;
    }
    return max + 1;
}

export const archiveStorage = {
    async getNextSceneNumber(cid: string): Promise<number> {
        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        return nextSceneNumber(scenes);
    },

    async appendCore(
        cid: string,
        userContent: string,
        assistantContent: string,
        commitId?: string,
    ) {
        archiveStore ??= createStore('keyval-store', 'keyval');
        return archiveStore('readwrite', store => new Promise<{
            sceneId: string; sceneNumber: number; timestamp: number; created: boolean;
        }>((resolve, reject) => {
            const tx = store.transaction;
            let result: { sceneId: string; sceneNumber: number; timestamp: number; created: boolean };
            let failure: unknown;
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(failure ?? tx.error ?? new Error('Archive transaction aborted'));
            tx.onerror = () => { failure ??= tx.error; };
            const suffixes = ['scenes', 'archive_index', 'facts', 'chapters'];
            const requests = suffixes.map(suffix => store.get(k(cid, suffix)));
            let remaining = requests.length;
            for (const request of requests) request.onsuccess = () => {
                if (--remaining > 0) return;
                try {
                    const scenes: SceneRecord[] = requests[0].result ?? [];
                    const index: import('../../types').ArchiveIndexEntry[] = requests[1].result ?? [];
                    const facts: SemanticFact[] = requests[2].result ?? [];
                    const chapters: ArchiveChapter[] = requests[3].result ?? [];
                    const existing = commitId ? scenes.find(scene => scene.commitId === commitId) : undefined;
                    if (existing) {
                        if (existing.userContent !== userContent || existing.assistantContent !== assistantContent) {
                            throw new Error('This turn was already archived with different text');
                        }
                        result = { sceneId: existing.sceneId, sceneNumber: parseInt(existing.sceneId, 10), timestamp: existing.timestamp, created: false };
                        return;
                    }
                    const sceneNumber = nextSceneNumber(scenes);
                    const sceneId = String(sceneNumber).padStart(3, '0');
                    const timestamp = Date.now();

                    scenes.push({ sceneId, userContent, assistantContent, timestamp, ...(commitId ? { commitId } : {}) });

                    const indexEntry = buildArchiveIndexEntry(sceneId, timestamp, userContent, assistantContent);
                    index.push(indexEntry);
                    for (const fact of extractNPCFacts(indexEntry.npcsMentioned, `${userContent}\n${assistantContent}`)) {
                        if (!facts.some(ef => ef.subject === fact.subject && ef.predicate === fact.predicate && ef.object === fact.object)) {
                            facts.push({ ...fact, id: `fact_${String(facts.length + 1).padStart(4, '0')}`, sceneId, timestamp });
                        }
                    }
                    let openChapter = chapters.find(ch => !ch.sealedAt);
                    if (!openChapter) {
                        const nextNum = nextChapterNumber(chapters);
                        openChapter = {
                            chapterId: chapterIdFor(nextNum), title: `Chapter ${nextNum}`,
                            sceneRange: [sceneId, sceneId], sceneIds: [], sceneCount: 0,
                            summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [],
                        };
                        chapters.push(openChapter);
                    }
                    openChapter.sceneRange[1] = sceneId;
                    openChapter.sceneIds ??= [];
                    if (!openChapter.sceneIds.includes(sceneId)) openChapter.sceneIds.push(sceneId);
                    openChapter.sceneCount = openChapter.sceneIds.length;

                    store.put(scenes, k(cid, 'scenes'));
                    store.put(index, k(cid, 'archive_index'));
                    store.put(facts, k(cid, 'facts'));
                    store.put(chapters, k(cid, 'chapters'));
                    result = { sceneId, sceneNumber, timestamp, created: true };
                } catch (err) {
                    failure = err;
                    tx.abort();
                }
            };
        }));
    },

    async deleteScene(cid: string, sceneId: string): Promise<{ ok: boolean }> {
        const target = parseInt(sceneId, 10);
        if (Number.isNaN(target)) return { ok: false };
        const idEq = (id: string) => parseInt(id, 10) === target;

        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        if (!scenes.some(s => idEq(s.sceneId))) return { ok: false }; // nothing to do
        await setList(k(cid, 'scenes'), scenes.filter(s => !idEq(s.sceneId)));

        const index = await getList<import('../../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
        await setList(k(cid, 'archive_index'), index.filter(e => !idEq(e.sceneId)));

        const facts = await getList<SemanticFact>(k(cid, 'facts'));
        await setList(k(cid, 'facts'), facts.filter(f => !idEq(f.sceneId)));

        const timeline = await getList<import('../../types').TimelineEvent>(k(cid, 'timeline'));
        await setList(k(cid, 'timeline'), timeline.filter(e => !idEq(e.sceneId)));

        // Repair the chapter that contained this scene: drop the id from sceneIds,
        // decrement sceneCount, and invalidate its seal (summary is now stale).
        // Leave sceneRange endpoints as-is — gaps inside a range are fine; recall
        // uses sceneIds, not range arithmetic.
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        let touched = false;
        for (const ch of chapters) {
            const had = (ch.sceneIds ?? []).some(idEq);
            if (!had) continue;
            ch.sceneIds = (ch.sceneIds ?? []).filter(id => !idEq(id));
            ch.sceneCount = Math.max(0, (ch.sceneCount ?? 0) - 1);
            if (ch.sealedAt) { ch.invalidated = true; delete ch.sealedAt; }
            touched = true;
        }
        if (touched) await setList(k(cid, 'chapters'), chapters);

        return { ok: true };
    },

    async updateSceneAssistant(cid: string, sceneId: string, assistantContent: string): Promise<{ ok: true; userContent: string } | { ok: false }> {
        const target = parseInt(sceneId, 10);
        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        const scene = scenes.find(s => parseInt(s.sceneId, 10) === target);
        if (!scene) return { ok: false };
        scene.assistantContent = assistantContent;
        await setList(k(cid, 'scenes'), scenes);

        const index = await getList<import('../../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
        const newEntry = buildArchiveIndexEntry(scene.sceneId, scene.timestamp, scene.userContent, assistantContent);
        await setList(k(cid, 'archive_index'), index.map(e => parseInt(e.sceneId, 10) === target ? newEntry : e));

        return { ok: true, userContent: scene.userContent };
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
            const nextNum = nextChapterNumber(chapters);
            chapters.push({
                chapterId: chapterIdFor(nextNum),
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
