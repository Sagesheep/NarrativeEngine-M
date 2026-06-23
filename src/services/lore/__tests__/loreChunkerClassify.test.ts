import { describe, it, expect } from 'vitest';
import { classifyCategory } from '../loreChunker';
import type { LoreCategory } from '../../../types';

describe('B7 — classifyCategory parses the [CHUNK: TYPE] token first', () => {
    it('routes [CHUNK: OVERVIEW -- Spirit Cards] to world_overview (was misc)', () => {
        expect(classifyCategory('[CHUNK: OVERVIEW -- Spirit Cards]', 'body', undefined))
            .toBe<LoreCategory>('world_overview');
    });

    it('routes [CHUNK: FACTION -- Hochveldt Sovereignty] to faction (was misc)', () => {
        expect(classifyCategory('[CHUNK: FACTION -- Hochveldt Sovereignty]', 'body', undefined))
            .toBe<LoreCategory>('faction');
    });

    it('maps each known TYPE token to its category', () => {
        const cases: Array<[string, LoreCategory]> = [
            ['[CHUNK: WORLD -- Setting]', 'world_overview'],
            ['[CHUNK: ORGANIZATION -- Thieves Guild]', 'faction'],
            ['[CHUNK: HERO -- Alden]', 'character'],
            ['[CHUNK: CHARACTER -- Mira]', 'character'],
            ['[CHUNK: NPC -- Barkeep]', 'character'],
            ['[CHUNK: LOCATION -- Ironwall]', 'location'],
            ['[CHUNK: CITY -- Tellis]', 'location'],
            ['[CHUNK: REGION -- The Reach]', 'location'],
            ['[CHUNK: EVENT -- The Sundering]', 'event'],
            ['[CHUNK: TIMELINE -- Age of Ash]', 'event'],
            ['[CHUNK: RELATIONSHIP -- Alden & Mira]', 'relationship'],
            ['[CHUNK: POWER -- The Spark]', 'power_system'],
            ['[CHUNK: MAGIC -- The Weave]', 'power_system'],
            ['[CHUNK: ECONOMY -- Grain Trade]', 'economy'],
            ['[CHUNK: CULTURE -- Hochveldt rites]', 'culture'],
            ['[CHUNK: RELIGION -- The Hearthmother]', 'culture'],
            ['[CHUNK: RULES -- Combat]', 'rules'],
            ['[CHUNK: MECHANIC -- Saves]', 'rules'],
        ];
        for (const [header, expected] of cases) {
            expect(classifyCategory(header, 'body', undefined)).toBe<LoreCategory>(expected);
        }
    });

    it('a header with no [CHUNK:] marker still routes through the existing heuristics (regression)', () => {
        // These relied on substring/parent-header heuristics before B7; the TYPE-token
        // block is skipped when there's no marker, so the fallback path still runs.
        expect(classifyCategory('WORLD OVERVIEW', 'body', undefined)).toBe('world_overview');
        expect(classifyCategory('Random Section', 'body', 'FACTION')).toBe('faction');
        expect(classifyCategory('Some Guy', '**Goals:** x\n**Disposition:** y', undefined)).toBe('character');
    });

    it('a genuinely unclassifiable chunk still returns misc', () => {
        expect(classifyCategory('Random Notes', 'just some text', undefined)).toBe('misc');
    });

    it('an unknown TYPE token falls through to heuristics/misc (no false map)', () => {
        // TYPE token is parsed but not in the map — must NOT accidentally match a wrong
        // category; it should fall through to the existing checks and then misc.
        expect(classifyCategory('[CHUNK: UNKNOWN_TYPE -- Whatever]', 'just text', undefined)).toBe('misc');
    });
});