import { describe, expect, it } from 'vitest';
import { parsePresentHeader, resolveNPCIds } from '../postTurn/witnessStage';
import type { NPCEntry } from '../../../types';

const npc = (id: string, name: string, aliases = '') => ({ id, name, aliases }) as NPCEntry;
const ledger = [npc('n1', 'Rin Holmes'), npc('n2', 'Helena Broadmarsh'), npc('n3', 'Lao Cheng'), npc('n4', 'The Broker', 'Name Unknown')];

// Cases ported from mainApp's presentHeader.test.ts.
describe('parsePresentHeader', () => {
    it('reads the bundled ruleset shape', () => {
        expect(parsePresentHeader('📅 [Time] Day 3 | 📍 [Location] Docks | 👥 [Present] Rin, Mira')).toEqual(['Rin', 'Mira']);
    });

    it('reads a labeled shape', () => {
        expect(parsePresentHeader('👥 Present: Rin; Mira')).toEqual(['Rin', 'Mira']);
    });

    it('reads a bold label', () => {
        expect(parsePresentHeader('👥 **Present:** [**Grey**], [**Rin**], [**Sanna**]')).toEqual(['Grey', 'Rin', 'Sanna']);
    });

    it('reads bracketed, bold names (custom rulesets)', () => {
        expect(parsePresentHeader('Scene #250 | 📅 Night | 📍 Study | 👥 [**Rin**], [**Helena Broadmarsh**], The Voice (Sensed)'))
            .toEqual(['Rin', 'Helena Broadmarsh', 'The Voice']);
    });

    it('reads a bracketed list with descriptors', () => {
        expect(parsePresentHeader('📍 [A village] | 👥 [Headman **Lao Cheng**, grieving boy]')).toEqual(['Headman Lao Cheng', 'grieving boy']);
    });

    it('"Nobody" is an empty list, not a missing header', () => {
        expect(parsePresentHeader('📍 Smuggler\'s Ditch | 👥 Nobody')).toEqual([]);
    });

    it('a reply with no 👥 field is null', () => {
        expect(parsePresentHeader('The rain keeps falling.')).toBeNull();
    });

    it('the last 👥 field wins (the scene moved mid-reply)', () => {
        expect(parsePresentHeader('👥 [**Rin**]\n\nLater…\n\n📍 Study | 👥 [**Helena**]')).toEqual(['Helena']);
    });

    it('drops placeholders that name nobody', () => {
        expect(parsePresentHeader('👥 Unknown, Rin')).toEqual(['Rin']);
    });
});

describe('resolveNPCIds on parsed headers', () => {
    it('resolves short names and titles; descriptors resolve to nothing', () => {
        const names = parsePresentHeader('👥 [**Rin**], [Headman **Lao Cheng**, grieving boy]')!;
        expect(resolveNPCIds(names, ledger)).toEqual(['n1', 'n3']);
    });

    it('a placeholder does not land on an NPC with a matching alias', () => {
        const names = parsePresentHeader('👥 Unknown')!;
        expect(resolveNPCIds(names, ledger)).toEqual([]);
    });
});
