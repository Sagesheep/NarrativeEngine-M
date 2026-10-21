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

        async append(cid: string, userContent: string, assistantContent: string, commitId?: string) {
            const core = await archiveStorage.appendCore(cid, userContent, assistantContent, commitId);
            // Embeddings are rebuildable and must not decide whether the turn committed.
            if (core.created) {
                import('../embedding').then(async ({ embedText, getCurrentModelId }) => {
                    const vec = await embedText(userContent + '\n' + assistantContent);
                    if (vec) await embeddingStorage.store(cid, core.sceneId, Array.from(vec), 'scene', getCurrentModelId());
                }).catch(e => console.warn('[Archive] Embedding deferred:', e));
            }
            return core;
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
