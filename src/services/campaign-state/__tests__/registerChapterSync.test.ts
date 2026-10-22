import { describe, it, expect } from 'vitest';
import { replaceChapterFacts, removeFactsFromScene, relabelChapterFacts, isFactActive, EMPTY_REGISTER } from '../divergenceRegister';
import type { DivergenceEntry, DivergenceRegister } from '../../../types';

function entry(over: Partial<DivergenceEntry> & { id: string }): DivergenceEntry {
    return {
        chapterId: 'CH01', category: 'party_facts', text: `fact ${over.id}`, sceneRef: '010',
        npcIds: [], pinned: false, source: 'auto', ...over,
    };
}
const register = (entries: DivergenceEntry[]): DivergenceRegister => ({ ...EMPTY_REGISTER, entries });
const ids = (reg: DivergenceRegister) => reg.entries.map(e => e.id);
const byId = (reg: DivergenceRegister, id: string) => reg.entries.find(e => e.id === id)!;

describe('replaceChapterFacts (seal / Regenerate)', () => {
    it("replaces the chapter's auto facts instead of duplicating them", () => {
        const reg = register([
            entry({ id: 'old1', chapterId: 'CH02', sceneRef: '030' }),
            entry({ id: 'old2', chapterId: 'CH02', sceneRef: '031' }),
            entry({ id: 'other', chapterId: 'CH01', sceneRef: '005' }),
        ]);
        const next = replaceChapterFacts(reg, 'CH02', [entry({ id: 'new1', chapterId: 'CH02', sceneRef: '030' })], '050');
        expect(ids(next)).toEqual(['other', 'new1']);
    });

    it('keeps manual, pinned and arc facts of the chapter', () => {
        const reg = register([
            entry({ id: 'edited', chapterId: 'CH02', source: 'manual' }),
            entry({ id: 'pinned', chapterId: 'CH02', pinned: true }),
            entry({ id: 'arc', chapterId: 'arc:a1', sceneRef: '035' }),
            entry({ id: 'auto', chapterId: 'CH02' }),
        ]);
        const next = replaceChapterFacts(reg, 'CH02', [entry({ id: 'new1', chapterId: 'CH02' })], '050');
        expect(ids(next)).toEqual(['edited', 'pinned', 'arc', 'new1']);
    });

    it('leaves the register untouched when the extraction came back empty', () => {
        const reg = register([entry({ id: 'old1', chapterId: 'CH02' })]);
        expect(replaceChapterFacts(reg, 'CH02', [], '050')).toBe(reg);
    });

    it('reactivates the value a replaced fact had superseded when the new extraction drops that slot', () => {
        const reg = register([
            entry({ id: 'ch1key', chapterId: 'CH01', sceneRef: '005', stateKey: 'item:moon-key:holder', status: 'superseded', supersededBy: 'ch2key' }),
            entry({ id: 'ch2key', chapterId: 'CH02', sceneRef: '030', stateKey: 'item:moon-key:holder', status: 'active' }),
        ]);
        const next = replaceChapterFacts(reg, 'CH02', [entry({ id: 'loose', chapterId: 'CH02', sceneRef: '030' })], '050');
        expect(byId(next, 'ch1key')).toMatchObject({ status: 'active' });
        expect(byId(next, 'ch1key').supersededBy).toBeUndefined();
    });

    it('a re-extracted slot value supersedes the restored older one again', () => {
        const reg = register([
            entry({ id: 'ch1key', chapterId: 'CH01', sceneRef: '005', stateKey: 'item:moon-key:holder', status: 'superseded', supersededBy: 'ch2key' }),
            entry({ id: 'ch2key', chapterId: 'CH02', sceneRef: '030', stateKey: 'item:moon-key:holder', status: 'active' }),
        ]);
        const next = replaceChapterFacts(reg, 'CH02', [entry({ id: 'ch2key_v2', chapterId: 'CH02', sceneRef: '031', stateKey: 'item:moon-key:holder' })], '050');
        expect(byId(next, 'ch1key')).toMatchObject({ status: 'superseded', supersededBy: 'ch2key_v2' });
        expect(byId(next, 'ch2key_v2')).toMatchObject({ status: 'active' });
    });
});

describe('removeFactsFromScene (rollback)', () => {
    it('drops auto facts from the deleted scenes, including arc facts, and keeps manual ones', () => {
        const reg = register([
            entry({ id: 'before', sceneRef: '040' }),
            entry({ id: 'at', sceneRef: '041' }),
            entry({ id: 'after', chapterId: 'CH03', sceneRef: '060' }),
            entry({ id: 'arc', chapterId: 'arc:a1', sceneRef: '045' }),
            entry({ id: 'mine', sceneRef: '050', source: 'manual' }),
        ]);
        const { register: next, removed } = removeFactsFromScene(reg, '041');
        expect(removed).toBe(3);
        expect(ids(next)).toEqual(['before', 'mine']);
    });

    it('restores the slot value from before the rolled-back scenes', () => {
        const reg = register([
            entry({ id: 'old', sceneRef: '010', stateKey: 'npc:mira:location', status: 'superseded', supersededBy: 'new' }),
            entry({ id: 'new', sceneRef: '045', stateKey: 'npc:mira:location', status: 'active' }),
        ]);
        const { register: next } = removeFactsFromScene(reg, '041');
        expect(ids(next)).toEqual(['old']);
        expect(isFactActive(byId(next, 'old'))).toBe(true);
    });

    it('does not reactivate a value when a newer surviving fact still holds the slot', () => {
        // old ← superseded by the deleted fact; a manual fact in the same slot is newer.
        const reg = register([
            entry({ id: 'old', sceneRef: '010', stateKey: 'npc:mira:location', status: 'superseded', supersededBy: 'gone' }),
            entry({ id: 'gone', sceneRef: '045', stateKey: 'npc:mira:location', status: 'superseded', supersededBy: 'mine' }),
            entry({ id: 'mine', sceneRef: '046', stateKey: 'npc:mira:location', status: 'active', source: 'manual' }),
        ]);
        const { register: next } = removeFactsFromScene(reg, '041');
        expect(byId(next, 'old')).toMatchObject({ status: 'superseded', supersededBy: 'mine' });
        expect(isFactActive(byId(next, 'mine'))).toBe(true);
    });

    it('is a no-op when nothing came from the deleted scenes', () => {
        const reg = register([entry({ id: 'before', sceneRef: '040' })]);
        expect(removeFactsFromScene(reg, '041')).toEqual({ register: reg, removed: 0 });
    });
});

describe('relabelChapterFacts (merge / split)', () => {
    it('moves a merged-away chapter onto the surviving id and drops its toggles', () => {
        const reg: DivergenceRegister = {
            ...register([entry({ id: 'a', chapterId: 'CH02' }), entry({ id: 'b', chapterId: 'CH03' })]),
            chapterToggles: { CH03: false },
        };
        const next = relabelChapterFacts(reg, 'CH03', () => 'CH02');
        expect(next.entries.map(e => e.chapterId)).toEqual(['CH02', 'CH02']);
        expect(next.chapterToggles).toEqual({ CH02: false });
    });

    it('splits facts by scene and gives both halves the original toggles', () => {
        const reg: DivergenceRegister = {
            ...register([entry({ id: 'early', chapterId: 'CH03', sceneRef: '051' }), entry({ id: 'late', chapterId: 'CH03', sceneRef: '070' })]),
            chapterToggles: { CH03: false },
        };
        const next = relabelChapterFacts(reg, 'CH03', e => parseInt(e.sceneRef, 10) >= 60 ? 'CH03B' : 'CH03A');
        expect(byId(next, 'early').chapterId).toBe('CH03A');
        expect(byId(next, 'late').chapterId).toBe('CH03B');
        expect(next.chapterToggles).toEqual({ CH03A: false, CH03B: false });
    });
});
