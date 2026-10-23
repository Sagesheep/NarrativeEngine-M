import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clear } from 'idb-keyval';
import type { ArchiveChapter, ArchiveIndexEntry, TimelineEvent, SemanticFact } from '../../types';

/**
 * Surgical-delete tests (WO-9). Tests 1–5 exercise archiveStorage against an
 * fake IndexedDB transactions; test 6 is a pure function test of
 * findSceneIdForMessage (no IDB at all).
 */

// Real idb-keyval over fake IndexedDB exercises the atomic append path.


// embeddingStorage.deleteByTypeAndId / store are imported by the storage wrapper
// for WO-3 / WO-7; stub them so they no-op rather than hitting the real IDB.
vi.mock('../storage/embeddingStorage', () => ({
    embeddingStorage: {
        deleteByTypeAndId: vi.fn(async () => {}),
        store: vi.fn(async () => {}),
    },
}));

// embedder: stubbed so updateSceneAssistant's re-embed no-ops cleanly.
vi.mock('../embedding', () => ({
    embedText: vi.fn(async () => new Float32Array([1, 2, 3])),
    getCurrentModelId: vi.fn(() => 'test-model'),
}));

import { archiveStorage } from '../storage/archiveStorage';
import { offlineStorage } from '../storage';
import { findSceneIdForMessage, firstSceneToRollBack } from '../../components/hooks/useMessageEditor';
import { loadArchiveIndex } from '../../store/campaignStore';
import { getList, setList, k, type SceneRecord } from '../storage/_helpers';
import type { ChatMessage } from '../../types';

const CID = 'camp-test';

function resetStore() {
    return clear();
}

function makeTimelineEvent(sceneId: string): TimelineEvent {
    return {
        id: `tl-${sceneId}`,
        sceneId,
        chapterId: 'CH01',
        subject: 'subj',
        predicate: 'status',
        object: 'obj',
        summary: 'sum',
        importance: 1,
        source: 'regex',
    };
}

function makeFact(sceneId: string): SemanticFact {
    return {
        id: `fact-${sceneId}`,
        subject: 'npc',
        predicate: 'status',
        object: 'alive',
        importance: 1,
        sceneId,
        timestamp: 0,
    };
}

function makeChapter(sceneIds: string[], sealed = true): ArchiveChapter {
    return {
        chapterId: 'CH01',
        title: 'Chapter 1',
        sceneRange: [sceneIds[0] ?? '001', sceneIds[sceneIds.length - 1] ?? '001'],
        sceneIds: [...sceneIds],
        summary: 'sealed summary',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: sceneIds.length,
        ...(sealed ? { sealedAt: Date.now() } : {}),
    };
}

async function getScenes(): Promise<SceneRecord[]> {
    return getList<SceneRecord>(k(CID, 'scenes'));
}
async function getIndex(): Promise<ArchiveIndexEntry[]> {
    return getList<ArchiveIndexEntry>(k(CID, 'archive_index'));
}

describe('archiveSurgicalDelete — WO-1: gap-safe scene numbering', () => {
    beforeEach(() => resetStore());

    it('after deleting scene 002, appendCore mints 004 (not a colliding 003)', async () => {
        // seed 001,002,003
        await offlineStorage.archive.append(CID, 'u1', 'a1');
        await offlineStorage.archive.append(CID, 'u2', 'a2');
        await offlineStorage.archive.append(CID, 'u3', 'a3');
        // surgical delete of 002
        await offlineStorage.archive.deleteScene(CID, '002');
        // next append must be 004, not 003
        const res = await offlineStorage.archive.append(CID, 'u4', 'a4');
        expect(res?.sceneId).toBe('004');
    });
});

describe('archiveSurgicalDelete — WO-2: deleteScene removes from all stores', () => {
    beforeEach(() => resetStore());

    it('removes scene 002 from scenes/index/facts/timeline and repairs its sealed chapter', async () => {
        // seed scenes via append (builds index entries) 001,002,003
        await offlineStorage.archive.append(CID, 'u1', 'a1');
        await offlineStorage.archive.append(CID, 'u2', 'a2');
        await offlineStorage.archive.append(CID, 'u3', 'a3');

        // Manually attach: a fact, a timeline event, and a sealed chapter spanning 001..003
        await setList(k(CID, 'facts'), [makeFact('002')]);
        await setList(k(CID, 'timeline'), [makeTimelineEvent('002')]);
        await setList(k(CID, 'chapters'), [makeChapter(['001', '002', '003'], true)]);

        const res = await archiveStorage.deleteScene(CID, '002');
        expect(res).toEqual({ ok: true });

        const scenes = await getScenes();
        const index = await getIndex();
        const facts = await getList<SemanticFact>(k(CID, 'facts'));
        const timeline = await getList<TimelineEvent>(k(CID, 'timeline'));
        const chapters = await getList<ArchiveChapter>(k(CID, 'chapters'));

        expect(scenes.map(s => s.sceneId)).toEqual(['001', '003']);
        expect(index.map(e => e.sceneId)).not.toContain('002');
        expect(facts.map(f => f.sceneId)).not.toContain('002');
        expect(timeline.map(e => e.sceneId)).not.toContain('002');
        const ch = chapters[0];
        expect(ch.sceneIds).not.toContain('002');
        expect(ch.sceneCount).toBe(2);
        expect(ch.invalidated).toBe(true);
        expect(ch.sealedAt).toBeUndefined();
    });
});

describe('archiveSurgicalDelete — WO-2: deleteScene leaves later scenes intact', () => {
    beforeEach(() => resetStore());

    it('deleting 002 keeps 001 and 003 unchanged', async () => {
        await offlineStorage.archive.append(CID, 'u1', 'a1');
        await offlineStorage.archive.append(CID, 'u2', 'a2');
        await offlineStorage.archive.append(CID, 'u3', 'a3');

        const before = await getScenes();
        const s1Before = before.find(s => s.sceneId === '001');
        const s3Before = before.find(s => s.sceneId === '003');

        await archiveStorage.deleteScene(CID, '002');

        const after = await getScenes();
        const s1After = after.find(s => s.sceneId === '001');
        const s3After = after.find(s => s.sceneId === '003');
        expect(s1After).toEqual(s1Before);
        expect(s3After).toEqual(s3Before);
        expect(after.map(s => s.sceneId)).toEqual(['001', '003']);
    });
});

describe('archiveSurgicalDelete — WO-2: deleteScene on missing id', () => {
    beforeEach(() => resetStore());

    it('returns ok:false and mutates nothing', async () => {
        await offlineStorage.archive.append(CID, 'u1', 'a1');
        const scenesBefore = await getScenes();
        const indexBefore = await getIndex();

        const res = await archiveStorage.deleteScene(CID, '999');
        expect(res).toEqual({ ok: false });

        const scenesAfter = await getScenes();
        const indexAfter = await getIndex();
        expect(scenesAfter).toEqual(scenesBefore);
        expect(indexAfter).toEqual(indexBefore);
    });
});

describe('archiveSurgicalDelete — WO-7: updateSceneAssistant', () => {
    beforeEach(() => resetStore());

    it('rewrites assistantContent, rebuilds index entry, preserves timestamp + userContent, leaves others alone', async () => {
        await offlineStorage.archive.append(CID, 'u-original-keep', 'a1-original');
        await offlineStorage.archive.append(CID, 'u2', 'a2-original');

        const scenesBefore = await getScenes();
        const targetBefore = scenesBefore.find(s => s.sceneId === '001')!;
        const otherBefore = scenesBefore.find(s => s.sceneId === '002')!;
        const tsBefore = targetBefore.timestamp;

        const newAssistant = 'The dragon Kael perished beneath the Sundered Gate';
        const res = await archiveStorage.updateSceneAssistant(CID, '001', newAssistant);
        expect(res.ok).toBe(true);

        const scenesAfter = await getScenes();
        const target = scenesAfter.find(s => s.sceneId === '001')!;
        const other = scenesAfter.find(s => s.sceneId === '002')!;

        // assistantContent rewritten, timestamp + userContent preserved
        expect(target.assistantContent).toBe(newAssistant);
        expect(target.timestamp).toBe(tsBefore);
        expect(target.userContent).toBe(targetBefore.userContent);

        // index entry rebuilt — new keywords reflect the new text
        const index = await getIndex();
        const idxTarget = index.find(e => e.sceneId === '001')!;
        expect(idxTarget.userSnippet).toBe(targetBefore.userContent.slice(0, 120));
        // a keyword drawn from the new text should now appear
        expect(JSON.stringify(idxTarget.keywords)).toMatch(/dragon|Kael|Sundered/i);

        // other scene untouched
        expect(other).toEqual(otherBefore);
    });
});

describe('archiveSurgicalDelete — WO-4: findSceneIdForMessage (pure)', () => {
    it('maps user + assistant of a turn to the same scene-marker id, padded', () => {
        const messages: ChatMessage[] = [
            { id: 'u1', role: 'user', content: 'hello' } as ChatMessage,
            { id: 'a1', role: 'assistant', content: 'hi back' } as ChatMessage,
            { id: 'm1', role: 'system', name: 'scene-marker', content: 'Scene 42' } as ChatMessage,
        ];
        expect(findSceneIdForMessage(messages, 'u1')).toBe('042');
        expect(findSceneIdForMessage(messages, 'a1')).toBe('042');
    });

    it('returns null when the trailing turn was never archived (no marker before next user)', () => {
        const messages: ChatMessage[] = [
            { id: 'u1', role: 'user', content: 'hello' } as ChatMessage,
            { id: 'a1', role: 'assistant', content: 'hi back' } as ChatMessage,
            { id: 'u2', role: 'user', content: 'next turn' } as ChatMessage,
        ];
        expect(findSceneIdForMessage(messages, 'u1')).toBeNull();
        expect(findSceneIdForMessage(messages, 'a1')).toBeNull();
    });
});

describe('archiveSurgicalDelete — firstSceneToRollBack (pure)', () => {
    const marker = (n: number): ChatMessage => ({ id: `m${n}`, role: 'system', name: 'scene-marker', content: `Scene ${n}` } as ChatMessage);
    const user = (id: string, timestamp: number): ChatMessage => ({ id, role: 'user', content: id, timestamp } as ChatMessage);
    const index = [777, 778, 779, 900].map(n => ({ sceneId: String(n).padStart(3, '0'), timestamp: n * 1000 }));

    it('deletes from the scene after the last marker the kept chat shows', () => {
        const messages = [user('u777', 776_500), marker(777), user('u778', 777_500), marker(778)];
        expect(firstSceneToRollBack(messages, 'u778', 777_500, index)).toBe('778');
    });

    it('reaches scenes a failed rollback left behind, though they are older than the message', () => {
        // Chat was cut back to scene 777, the archive still holds 778–900, and the
        // resent message is newer than every leftover scene.
        const messages = [user('u777', 776_500), marker(777), user('resent', 5_000_000)];
        expect(firstSceneToRollBack(messages, 'resent', 5_000_000, index)).toBe('778');
    });

    it('skips gaps left by single-scene deletes', () => {
        const messages = [marker(779), user('u', 0)];
        expect(firstSceneToRollBack(messages, 'u', 0, index)).toBe('900');
    });

    it('returns null when nothing was archived after the kept chat', () => {
        const messages = [marker(900), user('u', 0)];
        expect(firstSceneToRollBack(messages, 'u', 0, index)).toBeNull();
    });

    it('falls back to timestamps when the chat has no marker before the message', () => {
        expect(firstSceneToRollBack([user('u', 778_500)], 'u', 778_500, index)).toBe('779');
    });
});

describe('archiveSurgicalDelete — loadArchiveIndex', () => {
    beforeEach(async () => { await clear(); });

    it('reads the index the archive writes, not the stale legacy key', async () => {
        await offlineStorage.archive.append('cid', 'u1', 'a1');
        await setList('archive_index_cid', []);
        const loaded = await loadArchiveIndex('cid');
        expect(loaded.map(e => e.sceneId)).toEqual(['001']);
    });
});
