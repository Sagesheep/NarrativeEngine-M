import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { del, get as idbGet } from 'idb-keyval';
import { saveNPCLedger, getNPCLedger } from '../campaignStore';
import { affinityToPcRelation } from '../../services/npc/agencyBands';
import type { NPCEntry } from '../../types';

function makeNPC(overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'n1',
        name: 'Alden',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: '',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        ...overrides,
    } as NPCEntry;
}

describe('B2 — getNPCLedger homes orphan pcRelation (lazy migration)', () => {
    beforeEach(async () => {
        await del('npcs_b2-test');
    });

    it('homes pcRelation for a populated:true legacy NPC with pcRelation undefined', async () => {
        const legacy = makeNPC({ id: 'leg', affinity: 50, pcRelation: undefined, populated: true });
        await saveNPCLedger('b2-test', [legacy]);

        const loaded = await getNPCLedger('b2-test');
        expect(loaded[0].pcRelation).toBe(0); // affinity 50 → pcRelation 0
        expect(loaded[0].affinity).toBe(50); // affinity untouched
    });

    it('maps affinity 85 → pcRelation +2 (band edge)', async () => {
        const legacy = makeNPC({ id: 'leg85', affinity: 85, pcRelation: undefined, populated: true });
        await saveNPCLedger('b2-test', [legacy]);

        const loaded = await getNPCLedger('b2-test');
        expect(loaded[0].pcRelation).toBe(2);
        expect(loaded[0].pcRelation).toBe(affinityToPcRelation(85));
    });

    it('does not clobber an explicit pcRelation', async () => {
        const legacy = makeNPC({ id: 'leg-1', affinity: 50, pcRelation: -1, populated: true });
        await saveNPCLedger('b2-test', [legacy]);

        const loaded = await getNPCLedger('b2-test');
        expect(loaded[0].pcRelation).toBe(-1);
    });

    it('leaves isPC NPCs untouched (no pcRelation homing)', async () => {
        const pc = makeNPC({ id: 'pc', name: 'Hero', isPC: true, affinity: 50, pcRelation: undefined });
        await saveNPCLedger('b2-test', [pc]);

        const loaded = await getNPCLedger('b2-test');
        expect(loaded[0].pcRelation).toBeUndefined();
    });

    it('persists the homed pcRelation to disk (not just in-memory)', async () => {
        const legacy = makeNPC({ id: 'leg-disk', affinity: 70, pcRelation: undefined, populated: true });
        await saveNPCLedger('b2-test', [legacy]);
        await getNPCLedger('b2-test'); // triggers migration

        const onDisk = await idbGet<NPCEntry[]>('npcs_b2-test');
        expect(onDisk?.[0].pcRelation).toBe(1); // affinity 70 → +1
    });

    it('is idempotent — second load does not re-mutate', async () => {
        const legacy = makeNPC({ id: 'leg-id', affinity: 50, pcRelation: undefined, populated: true });
        await saveNPCLedger('b2-test', [legacy]);

        const first = await getNPCLedger('b2-test');
        expect(first[0].pcRelation).toBe(0);

        const second = await getNPCLedger('b2-test');
        expect(second[0].pcRelation).toBe(0);
    });
});