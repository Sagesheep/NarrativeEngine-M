import type { ArchiveChapter, SemanticFact } from '../../types';
import { extractNPCFacts } from '../archive';
import { getList, setList, k } from './_helpers';
import { archiveStorage } from './archiveStorage';
import { chapterStorage } from './chapterStorage';
import { factStorage } from './factStorage';
import { timelineStorage } from './timelineStorage';
import { entityStorage } from './entityStorage';
import { backupStorage } from './backupStorage';
import { embeddingStorage } from './embeddingStorage';
import { imageStorage } from './imageStorage';

export const offlineStorage = {
    archive: {
        async getNextSceneNumber(cid: string): Promise<number> {
            return archiveStorage.getNextSceneNumber(cid);
        },

        async append(cid: string, userContent: string, assistantContent: string): Promise<{ sceneId: string; sceneNumber: number } | undefined> {
            const core = await archiveStorage.appendCore(cid, userContent, assistantContent);
            if (!core) return undefined;

            const { sceneId, sceneNumber, indexEntry, timestamp } = core;

            import('../embedding').then(async ({ embedText, getCurrentModelId }) => {
                const modelId = getCurrentModelId();
                const combinedText = `${userContent}\n${assistantContent}`;
                const vec = await embedText(combinedText);
                if (vec) embeddingStorage.store(cid, sceneId, Array.from(vec), 'scene', modelId);
            }).catch(() => {});

            const npcNames = indexEntry.npcsMentioned;
            if (npcNames.length > 0) {
                const combinedText = `${userContent}\n${assistantContent}`;
                const newFacts = extractNPCFacts(npcNames, combinedText);
                if (newFacts.length > 0) {
                    const facts = await getList<SemanticFact>(k(cid, 'facts'));
                    for (const fact of newFacts) {
                        const isDuplicate = facts.some(ef =>
                            ef.subject === fact.subject && ef.predicate === fact.predicate && ef.object === fact.object
                        );
                        if (!isDuplicate) {
                            facts.push({
                                ...fact,
                                id: `fact_${String(facts.length + 1).padStart(4, '0')}`,
                                sceneId,
                                timestamp,
                            });
                        }
                    }
                    await setList(k(cid, 'facts'), facts);
                }
            }

            const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
            let openChapter = chapters.find(c => !c.sealedAt);
            if (!openChapter) {
                const nextNum = chapters.length + 1;
                openChapter = {
                    chapterId: `CH${String(nextNum).padStart(2, '0')}`,
                    title: `Chapter ${nextNum}`,
                    sceneRange: [sceneId, sceneId],
                    sceneIds: [sceneId],
                    summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
                    tone: '', themes: [], sceneCount: 1,
                };
                chapters.push(openChapter);
            } else {
                openChapter.sceneRange[1] = sceneId;
                openChapter.sceneCount = (openChapter.sceneCount || 0) + 1;
                if (!openChapter.sceneIds) openChapter.sceneIds = [];
                // B4 — guard against recording the boundary scene twice. The new open
                // chapter's sceneRange is seeded to the next scene id; if sceneIds was
                // pre-seeded with that same id (e.g. by a legacy backfill), don't push it
                // again. Only append if this sceneId isn't already the last entry.
                const last = openChapter.sceneIds[openChapter.sceneIds.length - 1];
                if (last !== sceneId) {
                    openChapter.sceneIds.push(sceneId);
                }
            }
            await setList(k(cid, 'chapters'), chapters);

            return { sceneId, sceneNumber };
        },

        async getIndex(cid: string) {
            return archiveStorage.getIndex(cid);
        },

        async getScenes(cid: string, sceneIds: string[]) {
            return archiveStorage.getScenes(cid, sceneIds);
        },

        async updateIndex(cid: string, index: import('../../types').ArchiveIndexEntry[]): Promise<void> {
            return archiveStorage.updateIndex(cid, index);
        },

        async deleteFrom(cid: string, fromSceneId: string) {
            return archiveStorage.deleteFrom(cid, fromSceneId);
        },

        async deleteScene(cid: string, sceneId: string) {
            const res = await archiveStorage.deleteScene(cid, sceneId);
            if (res.ok) {
                await embeddingStorage.deleteByTypeAndId(cid, 'scene', sceneId).catch(() => {});
            }
            return res;
        },

        async updateSceneAssistant(cid: string, sceneId: string, assistantContent: string) {
            const res = await archiveStorage.updateSceneAssistant(cid, sceneId, assistantContent);
            if (res.ok) {
                import('../embedding').then(async ({ embedText, getCurrentModelId }) => {
                    const vec = await embedText(`${res.userContent}\n${assistantContent}`);
                    if (vec) embeddingStorage.store(cid, sceneId, Array.from(vec), 'scene', getCurrentModelId());
                }).catch(() => {});
            }
            return res;
        },

        async clear(cid: string) {
            return archiveStorage.clear(cid);
        },
    },

    chapters: chapterStorage,
    facts: factStorage,
    timeline: timelineStorage,
    entities: entityStorage,
    backup: backupStorage,
    embeddings: embeddingStorage,
    images: imageStorage,
};
