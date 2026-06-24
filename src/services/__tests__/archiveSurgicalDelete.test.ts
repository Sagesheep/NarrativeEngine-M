import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveChapter, ArchiveIndexEntry, TimelineEvent, SemanticFact } from '../../types';

/**
 * Surgical-delete tests (WO-9). Tests 1–5 exercise archiveStorage against an
 * in-memory idb-keyval mock; test 6 is a pure function test of
 * findSceneIdForMessage (no IDB at all).
 */

// ── In-memory idb-keyval mock (shared by tests 1–5) ───────────────────────────

const memStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
    get: vi.fn(async (key: string) => memStore.get(key)),
    set: vi.fn(async (key: string, val: unknown) => { memStore.set(key, val); }),
    del: vi.fn(async (key: string) => { memStore.delete(key); }),
    keys: vi.fn(async () => Array.from(memStore.keys())),
    getMany: vi.fn(async (keys: string[]) => keys.map(k => memStore.get(k))),
    delMany: vi.fn(async (keys: string[]) => { for (const k of keys) memStore.delete(k); }),
}));

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
import { findSceneIdForMessage } from '../../components/hooks/useMessageEditor';
import { getList, setList, k, type SceneRecord } from '../storage/_helpers';
import type { ChatMessage } from '../../types';

const CID = 'camp-test';

function resetStore() {
    memStore.clear();
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