import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn() }));

import {
    EMPTY_REGISTER, resolvePromises, restoreFact, replaceChapterFacts, removeFactsFromScene, supersedeDuplicates,
    isFactActive, isAlwaysOn, recentWindowStart, renderRegisterForPayload,
} from '../divergenceRegister';
import { parseReview } from '../promiseReviewer';
import { parseCombinedSealOutput, openPromisesForSeal } from '../../archive/divergenceExtractor';
import type { ArchiveChapter, DivergenceEntry, DivergenceRegister } from '../../../types';

function entry(over: Partial<DivergenceEntry> & { id: string }): DivergenceEntry {
    return {
        chapterId: 'CH01', category: 'promises_debts', text: `fact ${over.id}`, sceneRef: '010',
        npcIds: [], pinned: false, source: 'auto', ...over,
    };
}
const register = (entries: DivergenceEntry[]): DivergenceRegister => ({ ...EMPTY_REGISTER, entries });
const byId = (reg: DivergenceRegister, id: string) => reg.entries.find(e => e.id === id)!;
const chapter = (chapterId: string, start: string, end: string, sealed = true): ArchiveChapter => ({
    chapterId, title: chapterId, sceneRange: [start, end], sceneIds: [], summary: `${chapterId} summary.`,
    keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 0,
    ...(sealed ? { sealedAt: 1 } : {}),
});

describe('resolvePromises', () => {
    it('closes active promises only, recording outcome, scene and chapter', () => {
        const reg = register([entry({ id: 'p1' }), entry({ id: 'lore', category: 'rules_lore' })]);
        const { register: next, resolved } = resolvePromises(reg, [
            { factId: 'p1', outcome: 'fulfilled', sceneRef: '030' },
            { factId: 'lore', outcome: 'void' },
            { factId: 'missing', outcome: 'broken' },
        ], 'CH02');
        expect(resolved).toBe(1);
        expect(byId(next, 'p1')).toMatchObject({ status: 'resolved', resolution: 'fulfilled', resolvedAt: '030', resolvedIn: 'CH02' });
        expect(isFactActive(byId(next, 'p1'))).toBe(false);
        expect(isFactActive(byId(next, 'lore'))).toBe(true);
    });

    it('reopen clears the resolution', () => {
        const { register: closed } = resolvePromises(register([entry({ id: 'p1' })]), [{ factId: 'p1', outcome: 'broken', sceneRef: '030' }], 'CH02');
        const reopened = byId(restoreFact(closed, 'p1'), 'p1');
        expect(reopened.status).toBe('active');
        expect(reopened.resolution).toBeUndefined();
        expect(reopened.resolvedIn).toBeUndefined();
    });

    it('re-sealing the closing chapter reopens what it closed before applying the fresh result', () => {
        const { register: closed } = resolvePromises(register([entry({ id: 'p1' })]), [{ factId: 'p1', outcome: 'fulfilled' }], 'CH02');
        const next = replaceChapterFacts(closed, 'CH02', [entry({ id: 'n1', chapterId: 'CH02', category: 'npc_events', sceneRef: '030' })], '040');
        expect(byId(next, 'p1').status).toBe('active');
    });

    it('rollback reopens promises closed in a deleted scene', () => {
        const { register: closed } = resolvePromises(register([entry({ id: 'p1' })]), [{ factId: 'p1', outcome: 'fulfilled', sceneRef: '045' }], 'CH02');
        const { register: next, removed } = removeFactsFromScene(closed, '041');
        expect(removed).toBe(0);
        expect(byId(next, 'p1').status).toBe('active');
    });
});

describe('repeated facts', () => {
    it('a seal does not re-add a promise that is already open in the same words', () => {
        const reg = register([entry({ id: 'p1', text: 'Kotone owes the dorm matcha custard.' })]);
        const next = replaceChapterFacts(reg, 'CH02', [
            entry({ id: 'p2', chapterId: 'CH02', sceneRef: '030', text: 'kotone owes the dorm matcha custard' }),
            entry({ id: 'p3', chapterId: 'CH02', sceneRef: '031', text: 'Minato owes Akihiko a rematch' }),
            entry({ id: 'p4', chapterId: 'CH02', sceneRef: '032', text: 'Minato owes Akihiko a rematch.' }),
        ], '040');
        expect(next.entries.map(e => e.id)).toEqual(['p1', 'p3']);
    });

    it('supersedeDuplicates marks repeats, never a pair marking each other', () => {
        const reg = register([entry({ id: 'a' }), entry({ id: 'b' })]);
        const { register: next, superseded } = supersedeDuplicates(reg, [{ id: 'b', of: 'a' }, { id: 'a', of: 'b' }]);
        expect(superseded).toBe(1);
        expect(byId(next, 'b')).toMatchObject({ status: 'superseded', supersededBy: 'a' });
        expect(isFactActive(byId(next, 'a'))).toBe(true);
    });
});

describe('seal output: closedPromises', () => {
    const facts = [
        entry({ id: 'old1', sceneRef: '005', text: 'Minato promised Chihiro a book trip' }),
        entry({ id: 'old2', sceneRef: '008', text: 'Kotone owes custard' }),
        entry({ id: 'own', sceneRef: '031', chapterId: 'CH02', text: 'made in this chapter' }),
    ];

    it('lists only promises from before the chapter, oldest first', () => {
        expect(openPromisesForSeal(facts, '030').map(p => [p.label, p.fact.id])).toEqual([['P1', 'old1'], ['P2', 'old2']]);
    });

    it('maps P-labels back to fact ids and drops bad outcomes, labels and scenes', () => {
        const raw = JSON.stringify({
            summary: { title: 'T', summary: 'S', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: 'mixed', themes: [] },
            divergences: { promises_debts: [] },
            closedPromises: [
                { id: 'P2', outcome: 'Fulfilled', sceneRef: '031' },
                { id: 'P1', outcome: 'forgotten' },
                { id: 'P9', outcome: 'broken' },
                { id: 'p2', outcome: 'broken' },
            ],
        });
        const result = parseCombinedSealOutput(raw, 'CH02', ['030', '031'], [], undefined, undefined, facts);
        expect(result.closedPromises).toEqual([{ factId: 'old2', outcome: 'fulfilled', sceneRef: '031' }]);
    });
});

describe('always-on block (design #2)', () => {
    const chapters = [chapter('CH01', '001', '025'), chapter('CH02', '026', '050'), chapter('CH03', '051', '075'), chapter('CH04', '076', '080', false)];

    it('the window starts at the 2nd newest sealed chapter; none before 2 seals', () => {
        expect(recentWindowStart(chapters)).toBe('026');
        expect(recentWindowStart(chapters.slice(0, 1))).toBeUndefined();
    });

    it('keeps state, open promises, lore, pinned and manual facts; old events become history', () => {
        const w = '026';
        expect(isAlwaysOn(entry({ id: 'e', category: 'npc_events', sceneRef: '010' }), w)).toBe(false);
        expect(isAlwaysOn(entry({ id: 'e', category: 'npc_events', sceneRef: '030' }), w)).toBe(true);
        expect(isAlwaysOn(entry({ id: 'p', category: 'promises_debts', sceneRef: '005' }), w)).toBe(true);
        expect(isAlwaysOn(entry({ id: 'l', category: 'rules_lore', sceneRef: '005' }), w)).toBe(true);
        expect(isAlwaysOn(entry({ id: 's', category: 'npc_events', sceneRef: '005', stateKey: 'npc:npc_1:attitude' }), w)).toBe(true);
        expect(isAlwaysOn(entry({ id: 'm', category: 'party_facts', sceneRef: '005', source: 'manual' }), w)).toBe(true);
        expect(isAlwaysOn(entry({ id: 'k', category: 'party_facts', sceneRef: '005', pinned: true }), w)).toBe(true);
    });

    it('renders open promises in their own section and counts held-back history', () => {
        const reg = register([
            entry({ id: 'old', category: 'npc_events', sceneRef: '010', text: 'Junpei met Minato' }),
            entry({ id: 'new', category: 'npc_events', chapterId: 'CH03', sceneRef: '060', text: 'Mitsuru awakened Artemisia' }),
            entry({ id: 'owe', sceneRef: '012', text: 'Minato owes Akihiko a rematch' }),
            entry({ id: 'done', sceneRef: '013', text: 'Coffee at Chagall', status: 'resolved', resolution: 'fulfilled' }),
        ]);
        const out = renderRegisterForPayload(reg, chapters, undefined, undefined, true, true);
        expect(out).toContain('OPEN PROMISES & DEBTS (still owed):\n• Minato owes Akihiko a rematch');
        expect(out).toContain('Mitsuru awakened Artemisia');
        expect(out).not.toContain('Junpei met Minato');
        expect(out).not.toContain('Coffee at Chagall');
        expect(out).toContain('1 older events in chapter recaps/archive');
        // Without the always-on flag (e.g. legacy callers) nothing is held back.
        expect(renderRegisterForPayload(reg, chapters, undefined, undefined, true)).toContain('Junpei met Minato');
    });
});

describe('always-on block is cache-stable', () => {
    it('renders byte-identical while the open chapter grows turn by turn', () => {
        const reg = register([
            entry({ id: 'old', category: 'npc_events', sceneRef: '010', text: 'Junpei met Minato' }),
            entry({ id: 'new', category: 'npc_events', chapterId: 'CH03', sceneRef: '060', text: 'Mitsuru awakened Artemisia' }),
            entry({ id: 'owe', sceneRef: '012', text: 'Minato owes Akihiko a rematch' }),
        ]);
        const sealed = [chapter('CH01', '001', '025'), chapter('CH02', '026', '050'), chapter('CH03', '051', '075')];
        const turnA = renderRegisterForPayload(reg, [...sealed, chapter('CH04', '076', '080', false)], undefined, undefined, true, true);
        const turnB = renderRegisterForPayload(reg, [...sealed, chapter('CH04', '076', '093', false)], undefined, undefined, true, true);
        expect(turnB).toBe(turnA);
    });
});

describe('promise review parsing', () => {
    const promises = [
        { label: 'P1', fact: entry({ id: 'a', sceneRef: '043' }) },
        { label: 'P2', fact: entry({ id: 'b', sceneRef: '043' }) },
        { label: 'P3', fact: entry({ id: 'c', sceneRef: '114' }) },
    ];
    const chapters = [chapter('CH02', '026', '049'), chapter('CH05', '100', '124'), chapter('CH03', '050', '074')];

    it('maps duplicates and closures, rejecting a chapter that ended before the promise', () => {
        const result = parseReview({
            duplicates: [{ id: 'P2', of: 'P1' }],
            closed: [
                { id: 'P2', outcome: 'fulfilled', chapter: 'CH03' }, // already a duplicate
                { id: 'P1', outcome: 'void', chapter: 'ch03' },
                { id: 'P3', outcome: 'fulfilled', chapter: 'CH03' }, // CH03 ends before scene 114
            ],
        }, promises, chapters);
        expect(result.duplicates).toEqual([{ id: 'b', of: 'a' }]);
        expect(result.closures).toEqual([{ factId: 'a', outcome: 'void', sceneRef: '074' }]);
    });
});
