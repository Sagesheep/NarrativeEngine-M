import type { ArchiveChapter, SemanticFact } from '../../types';
import { extractNPCFacts } from '../archiveIndexer';
import { getList, setList, k } from './_helpers';
import { archiveStorage } from './archiveStorage';
import { chapterStorage } from './chapterStorage';
import { factStorage } from './factStorage';
import { timelineStorage } from './timelineStorage';
import { entityStorage } from './entityStorage';
import { backupStorage } from './backupStorage';
import { embeddingStorage } from './embeddingStorage';

export const offlineStorage = {
    archive: {
        async getNextSceneNumber(cid: string): Promise<number> {
            return archiveStorage.getNextSceneNumber(cid);
        },

        async append(cid: string, userContent: string, assistantContent: string): Promise<{ sceneId: string; sceneNumber: number } | undefined> {
            const core = await archiveStorage.appendCore(cid, userContent, assistantContent);
            if (!core) return undefined;

            const { sceneId, sceneNumber, indexEntry, timestamp } = core;

            import('../embedder').then(({ embedText }) => {
                const combinedText = `${userContent}\n${assistantContent}`.slice(0, 500);
                return embedText(combinedText);
            }).then(vec => {
                if (vec) embeddingStorage.store(cid, sceneId, Array.from(vec), 'scene');
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

            let chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
            let openChapter = chapters.find(c => !c.sealedAt);
            if (!openChapter) {
                const nextNum = chapters.length + 1;
                openChapter = {
                    chapterId: `CH${String(nextNum).padStart(2, '0')}`,
                    title: `Chapter ${nextNum}`,
                    sceneRange: [sceneId, sceneId],
                    summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
                    tone: '', themes: [], sceneCount: 1,
                };
                chapters.push(openChapter);
            } else {
                openChapter.sceneRange[1] = sceneId;
                openChapter.sceneCount = (openChapter.sceneCount || 0) + 1;
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
};
