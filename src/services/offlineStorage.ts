import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import type { ArchiveChapter, SemanticFact, TimelineEvent, EntityEntry, BackupMeta } from '../types';
import { buildArchiveIndexEntry, extractNPCFacts } from './archiveIndexer';
import { uid } from '../utils/uid';

const TIMELINE_PREDICATES_LIST = [
    'status', 'located_in', 'holds', 'allied_with', 'enemy_of', 'killed_by',
    'controls', 'relationship_to', 'seeks', 'knows_about', 'destroyed', 'misc',
];

type SceneRecord = { sceneId: string; userContent: string; assistantContent: string; timestamp: number };

async function getList<T>(key: string): Promise<T[]> {
    return (await idbGet(key)) || [];
}
async function setList<T>(key: string, data: T[]): Promise<void> {
    await idbSet(key, data);
}

function k(cid: string, suffix: string) { return `${cid}_${suffix}`; }

function computeHash(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        const chr = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return hash.toString(16);
}

export const offlineStorage = {
    archive: {
        async getNextSceneNumber(cid: string): Promise<number> {
            const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
            return scenes.length + 1;
        },

        async append(cid: string, userContent: string, assistantContent: string): Promise<{ sceneId: string; sceneNumber: number } | undefined> {
            try {
                const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
                const sceneNumber = scenes.length + 1;
                const sceneId = String(sceneNumber).padStart(3, '0');
                const timestamp = Date.now();

                scenes.push({ sceneId, userContent, assistantContent, timestamp });
                await setList(k(cid, 'scenes'), scenes);

                const indexEntry = buildArchiveIndexEntry(sceneId, timestamp, userContent, assistantContent);
                const index = await getList<import('../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
                index.push(indexEntry);
                await setList(k(cid, 'archive_index'), index);

                import('./embedder').then(({ embedText }) => {
                    const combinedText = `${userContent}\n${assistantContent}`.slice(0, 500);
                    return embedText(combinedText);
                }).then(vec => {
                    if (vec) offlineStorage.embeddings.store(cid, sceneId, Array.from(vec), 'scene');
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
                        summary: '',
                        keywords: [],
                        npcs: [],
                        majorEvents: [],
                        unresolvedThreads: [],
                        tone: '',
                        themes: [],
                        sceneCount: 1,
                    };
                    chapters.push(openChapter);
                } else {
                    openChapter.sceneRange[1] = sceneId;
                    openChapter.sceneCount = (openChapter.sceneCount || 0) + 1;
                }
                await setList(k(cid, 'chapters'), chapters);

                return { sceneId, sceneNumber };
            } catch (err) {
                console.error('[OfflineStorage] Archive append failed:', err);
                return undefined;
            }
        },

        async getIndex(cid: string) {
            return getList<import('../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
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

            const index = await getList<import('../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
            await setList(k(cid, 'archive_index'), index.filter(e => parseInt(e.sceneId, 10) < fromNum));

            const facts = await getList<SemanticFact>(k(cid, 'facts'));
            await setList(k(cid, 'facts'), facts.filter(f => parseInt(f.sceneId, 10) < fromNum));

            const timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
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
    },

    chapters: {
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
    },

    facts: {
        async get(cid: string): Promise<SemanticFact[]> {
            return getList(k(cid, 'facts'));
        },
        async save(cid: string, facts: SemanticFact[]): Promise<void> {
            await setList(k(cid, 'facts'), facts);
        },
    },

    timeline: {
        async get(cid: string): Promise<TimelineEvent[]> {
            let timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
            if (timeline.length === 0) {
                const facts = await getList<SemanticFact>(k(cid, 'facts'));
                if (facts.length > 0) {
                    timeline = facts.map(f => ({
                        id: `tl_${f.id ? f.id.replace('fact_', '') : uid().slice(0, 4)}`,
                        sceneId: f.sceneId || '000',
                        chapterId: 'CH00',
                        subject: f.subject || '',
                        predicate: (TIMELINE_PREDICATES_LIST.includes(f.predicate) ? f.predicate : 'misc') as TimelineEvent['predicate'],
                        object: f.object || '',
                        summary: `${f.subject} ${f.predicate} ${f.object}`,
                        importance: typeof f.importance === 'number' ? f.importance : 5,
                        source: (f.source || 'regex') as TimelineEvent['source'],
                    }));
                    await setList(k(cid, 'timeline'), timeline);
                }
            }
            return timeline;
        },
        async add(cid: string, event: Partial<TimelineEvent>): Promise<TimelineEvent | null> {
            const { subject, predicate, object: obj } = event;
            if (!subject || !predicate || !obj) return null;
            const timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
            const newEvent: TimelineEvent = {
                id: `tl_${String(timeline.length + 1).padStart(4, '0')}`,
                sceneId: event.sceneId || '000',
                chapterId: event.chapterId || 'CH00',
                subject,
                predicate: (TIMELINE_PREDICATES_LIST.includes(predicate) ? predicate : 'misc') as TimelineEvent['predicate'],
                object: obj,
                summary: event.summary || `${subject} ${predicate} ${obj}`,
                importance: Math.min(10, Math.max(1, typeof event.importance === 'number' ? event.importance : 5)),
                source: 'manual',
            };
            timeline.push(newEvent);
            await setList(k(cid, 'timeline'), timeline);
            return newEvent;
        },
        async remove(cid: string, eventId: string): Promise<boolean> {
            const timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
            const filtered = timeline.filter(e => e.id !== eventId);
            await setList(k(cid, 'timeline'), filtered);
            return timeline.length !== filtered.length;
        },
    },

    entities: {
        async get(cid: string): Promise<EntityEntry[]> {
            return getList(k(cid, 'entities'));
        },
        async merge(cid: string, survivorId: string, absorbedId: string): Promise<{ ok: boolean } | null> {
            const entities = await getList<EntityEntry>(k(cid, 'entities'));
            const survivor = entities.find(e => e.id === survivorId);
            const absorbed = entities.find(e => e.id === absorbedId);
            if (!survivor || !absorbed) return null;
            survivor.aliases = [...new Set([...(survivor.aliases || []), absorbed.name, ...(absorbed.aliases || [])])];
            await setList(k(cid, 'entities'), entities.filter(e => e.id !== absorbedId));
            return { ok: true };
        },
    },

    backup: {
        async create(cid: string, opts: { label?: string; trigger?: string; isAuto?: boolean }): Promise<any> {
            const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
            if (scenes.length === 0) return { skipped: true };

            const index = await getList<import('../types').ArchiveIndexEntry>(k(cid, 'archive_index'));
            const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
            const facts = await getList<SemanticFact>(k(cid, 'facts'));
            const timeline = await getList<TimelineEvent>(k(cid, 'timeline'));

            const hash = computeHash(JSON.stringify({ scenes, index, chapters, facts, timeline }));
            const backups = await getList<{ timestamp: number; meta: BackupMeta; data: unknown }>(k(cid, 'backups'));

            if (opts.isAuto) {
                const autoBackups = backups.filter(b => b.meta.isAuto).sort((a, b) => b.timestamp - a.timestamp);
                if (autoBackups.length > 0 && autoBackups[0].meta.hash === hash) {
                    return { skipped: true };
                }
            }

            const now = Date.now();
            const meta: BackupMeta = {
                timestamp: now,
                label: opts.label || '',
                trigger: opts.trigger || 'manual',
                hash,
                fileCount: scenes.length,
                isAuto: opts.isAuto || false,
                campaignName: '',
            };

            backups.push({ timestamp: now, meta, data: { scenes, index, chapters, facts, timeline } });

            if (opts.isAuto) {
                const autoBackups = backups.filter(b => b.meta.isAuto).sort((a, b) => b.timestamp - a.timestamp);
                for (let i = 10; i < autoBackups.length; i++) {
                    const idx = backups.findIndex(b => b.timestamp === autoBackups[i].timestamp);
                    if (idx >= 0) backups.splice(idx, 1);
                }
            }

            await setList(k(cid, 'backups'), backups);
            return { timestamp: now, hash, fileCount: scenes.length };
        },

        async list(cid: string): Promise<BackupMeta[]> {
            const backups = await getList<{ timestamp: number; meta: BackupMeta }>(k(cid, 'backups'));
            return backups.map(b => b.meta).sort((a, b) => b.timestamp - a.timestamp);
        },

        async read(cid: string, ts: number): Promise<{ meta: BackupMeta; data: unknown } | null> {
            const backups = await getList<{ timestamp: number; meta: BackupMeta; data: unknown }>(k(cid, 'backups'));
            return backups.find(b => b.timestamp === ts) || null;
        },

        async restore(cid: string, ts: number): Promise<{ ok: boolean } | null> {
            const backups = await getList<{ timestamp: number; meta: BackupMeta; data: any }>(k(cid, 'backups'));
            const target = backups.find(b => b.timestamp === ts);
            if (!target) return null;

            await offlineStorage.backup.create(cid, {
                label: `Pre-restore from ${new Date(ts).toLocaleString()}`,
                trigger: 'pre-restore',
                isAuto: false,
            }).catch(() => {});

            const d = target.data;
            if (d.scenes) await setList(k(cid, 'scenes'), d.scenes);
            if (d.index) await setList(k(cid, 'archive_index'), d.index);
            if (d.chapters) await setList(k(cid, 'chapters'), d.chapters);
            if (d.facts) await setList(k(cid, 'facts'), d.facts);
            if (d.timeline) await setList(k(cid, 'timeline'), d.timeline);

            return { ok: true };
        },

        async delete(cid: string, ts: number): Promise<void> {
            const backups = await getList<{ timestamp: number; meta: BackupMeta; data: unknown }>(k(cid, 'backups'));
            await setList(k(cid, 'backups'), backups.filter(b => b.timestamp !== ts));
        },
    },

    embeddings: {
        async store(campaignId: string, id: string, vector: number[], type: 'scene' | 'lore'): Promise<void> {
            await idbSet(`nn_embed_${campaignId}_${type}_${id}`, { vector });
        },

        async get(campaignId: string, id: string): Promise<number[] | null> {
            const entry = await idbGet(`nn_embed_${campaignId}_scene_${id}`) as { vector: number[] } | null;
            if (entry) return entry.vector;
            const loreEntry = await idbGet(`nn_embed_${campaignId}_lore_${id}`) as { vector: number[] } | null;
            return loreEntry?.vector ?? null;
        },

        async getAll(campaignId: string, type?: 'scene' | 'lore'): Promise<Array<{ id: string; vector: number[] }>> {
            const results: Array<{ id: string; vector: number[] }> = [];
            const types = type ? [type] : ['scene', 'lore'] as const;
            for (const t of types) {
                const prefix = `nn_embed_${campaignId}_${t}_`;
                const allKeys = await import('idb-keyval').then(m => m.keys());
                for (const key of allKeys) {
                    if (typeof key === 'string' && key.startsWith(prefix)) {
                        const id = key.slice(prefix.length);
                        const entry = await idbGet(key) as { vector: number[] } | null;
                        if (entry) results.push({ id, vector: entry.vector });
                    }
                }
            }
            return results;
        },

        async delete(campaignId: string, id: string): Promise<void> {
            await idbDel(`nn_embed_${campaignId}_scene_${id}`).catch(() => {});
            await idbDel(`nn_embed_${campaignId}_lore_${id}`).catch(() => {});
        },

        async deleteAll(campaignId: string): Promise<void> {
            const allKeys = await import('idb-keyval').then(m => m.keys());
            const prefix = `nn_embed_${campaignId}_`;
            for (const key of allKeys) {
                if (typeof key === 'string' && key.startsWith(prefix)) {
                    await idbDel(key);
                }
            }
        },
    },
};
