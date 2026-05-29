import { describe, it, expect } from 'vitest';
import { dedupeNPCLedger } from '../npcSlice';
import type { NPCEntry } from '../../../types';

const makeNPC = (name: string, id?: string): NPCEntry => ({
    id: id || name.toLowerCase().replace(/\s+/g, '-'),
    name,
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
});

describe('dedupeNPCLedger', () => {
    it('returns empty array for empty input', () => {
        expect(dedupeNPCLedger([])).toEqual([]);
    });

    it('returns same array when no duplicates', () => {
        const npcs = [makeNPC('Gandalf'), makeNPC('Frodo')];
        const result = dedupeNPCLedger(npcs);
        expect(result).toHaveLength(2);
        expect(result.map(n => n.name)).toEqual(['Gandalf', 'Frodo']);
    });

    it('removes exact duplicate names (keeps newer)', () => {
        const npc1 = makeNPC('Gandalf');
        const npc2 = makeNPC('Gandalf');
        npc2.affinity = 99;
        const result = dedupeNPCLedger([npc1, npc2]);
        expect(result).toHaveLength(1);
        expect(result[0].affinity).toBe(99);
    });

    it('removes first-name-only entry when full-name exists', () => {
        const partial = makeNPC('Gandalf');
        const full = makeNPC('Gandalf the Grey');
        const result = dedupeNPCLedger([partial, full]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Gandalf the Grey');
    });

    it('removes first-name-only entry when full-name exists (reverse order)', () => {
        const full = makeNPC('Gandalf the Grey');
        const partial = makeNPC('Gandalf');
        const result = dedupeNPCLedger([full, partial]);
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Gandalf the Grey');
    });

    it('keeps different full names with same first name', () => {
        const npc1 = makeNPC('John Smith');
        const npc2 = makeNPC('John Doe');
        const result = dedupeNPCLedger([npc1, npc2]);
        expect(result).toHaveLength(2);
    });

    it('handles case-insensitive matching', () => {
        const npc1 = makeNPC('gandalf');
        const npc2 = makeNPC('GANDALF');
        const result = dedupeNPCLedger([npc1, npc2]);
        expect(result).toHaveLength(1);
    });

    it('handles three-way collision: partial + two exacts', () => {
        const partial = makeNPC('Gandalf');
        const exact1 = makeNPC('Gandalf');
        const exact2 = makeNPC('Gandalf');
        exact2.affinity = 77;
        const result = dedupeNPCLedger([partial, exact1, exact2]);
        expect(result).toHaveLength(1);
        expect(result[0].affinity).toBe(77);
    });
});