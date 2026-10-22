/* eslint-disable @typescript-eslint/no-explicit-any */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clear } from 'idb-keyval';
import type { GameContext, NPCEntry } from '../../../types';

const deleteVec = vi.fn(async () => {});
const storeVec = vi.fn(async () => {});
vi.mock('../../storage/embeddingStorage', () => ({
    embeddingStorage: {
        deleteByTypeAndId: (...a: unknown[]) => (deleteVec as any)(...a),
        store: (...a: unknown[]) => (storeVec as any)(...a),
    },
}));
vi.mock('../../embedding', () => ({
    embedText: vi.fn(async () => new Float32Array([1, 2])),
    getCurrentModelId: () => 'test-model',
}));

import { turnSnapshotStorage, pickTurnContext, MAX_TURN_SNAPSHOTS, type TurnSnapshot } from '../../storage/turnSnapshotStorage';
import { rewindTurnState } from '../turnRewind';

const CID = 'c1';
const npc = (id: string, personality = 'calm'): NPCEntry => ({ id, name: `NPC ${id}`, personality } as NPCEntry);
const snap = (messageId: string, timestamp: number, over: Partial<TurnSnapshot> = {}): TurnSnapshot => ({
    messageId, timestamp, context: { inventory: `inv@${messageId}` }, npcLedger: [], npcPressure: {}, onStageNpcIds: [], ...over,
});

function targets(npcLedger: NPCEntry[]) {
    return {
        npcLedger,
        updateContext: vi.fn(),
        setNPCLedger: vi.fn(),
        setNpcPressure: vi.fn(),
        setOnStageNpcIds: vi.fn(),
    };
}

beforeEach(async () => {
    await clear();
    vi.clearAllMocks();
});

describe('turn snapshots', () => {
    it('keeps only engine-driven context fields', () => {
        const ctx = { inventory: 'sword', agencyTick: 4, notebook: [], rulesRaw: 'rules', playerNotes: [], sceneNote: 'x' } as unknown as GameContext;
        expect(pickTurnContext(ctx)).toEqual({ inventory: 'sword', agencyTick: 4, notebook: [] });
    });

    it('caps how many turns are kept', async () => {
        for (let i = 0; i < MAX_TURN_SNAPSHOTS + 5; i++) await turnSnapshotStorage.save(CID, snap(`m${i}`, i));
        expect(await turnSnapshotStorage.takeFrom(CID, 'm10', 10)).not.toBeNull();
        // The oldest five were evicted.
        expect(await turnSnapshotStorage.takeFrom(CID, 'm4', 4)).toBeNull();
    });
});

describe('rewindTurnState', () => {
    it('restores the state from before the edited turn and drops later snapshots', async () => {
        await turnSnapshotStorage.save(CID, snap('m548', 548, {
            npcLedger: [npc('a')], npcPressure: { a: { engaged: 1 } as any }, onStageNpcIds: ['a'],
        }));
        await turnSnapshotStorage.save(CID, snap('m552', 552));
        await turnSnapshotStorage.save(CID, snap('m547', 547));

        const t = targets([npc('a'), npc('b')]);
        expect(await rewindTurnState(CID, 'm548', 548, t)).toBe(true);
        expect(t.updateContext).toHaveBeenCalledWith({ inventory: 'inv@m548' });
        expect(t.setNPCLedger).toHaveBeenCalledWith([npc('a')]);
        expect(t.setNpcPressure).toHaveBeenCalledWith({ a: { engaged: 1 } });
        expect(t.setOnStageNpcIds).toHaveBeenCalledWith(['a']);

        // Turns 548+ are gone; 547 is still rewindable.
        expect(await turnSnapshotStorage.takeFrom(CID, 'm552', 552)).toBeNull();
        expect(await turnSnapshotStorage.takeFrom(CID, 'm547', 547)).not.toBeNull();
    });

    it('drops vectors for NPCs the rewound turns added and re-embeds changed ones', async () => {
        await turnSnapshotStorage.save(CID, snap('m1', 1, { npcLedger: [npc('a', 'calm'), npc('c')] }));
        const t = targets([npc('a', 'furious'), npc('b')]);
        await rewindTurnState(CID, 'm1', 1, t);
        await vi.waitFor(() => expect(storeVec).toHaveBeenCalledTimes(2));

        expect(deleteVec).toHaveBeenCalledWith(CID, 'npc', 'b');
        expect(deleteVec).toHaveBeenCalledTimes(1);
        // 'a' changed description; 'c' was removed since and needs its vector back.
        expect(storeVec.mock.calls.map((c: any[]) => c[1]).sort()).toEqual(['a', 'c']);
    });

    it('leaves state alone when no snapshot was kept for the turn', async () => {
        const t = targets([npc('a')]);
        expect(await rewindTurnState(CID, 'old', 5, t)).toBe(false);
        expect(t.updateContext).not.toHaveBeenCalled();
        expect(t.setNPCLedger).not.toHaveBeenCalled();
    });
});
