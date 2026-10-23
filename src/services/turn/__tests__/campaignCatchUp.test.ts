import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveBook, ArchiveChapter, LLMProvider, NPCEntry } from '../../../types';

let chapters: ArchiveChapter[] = [];
let books: ArchiveBook[] = [];
let scenes: { sceneId: string; content: string }[] = [];

vi.mock('../../apiClient', () => ({
    api: {
        chapters: { list: async () => chapters.map(c => ({ ...c })) },
        books: { list: async () => books.map(b => ({ ...b })) },
        archive: {
            getIndex: async () => scenes.map(s => ({ sceneId: s.sceneId })),
            getScenes: async (_c: string, ids: string[]) => scenes.filter(s => ids.includes(s.sceneId)),
        },
    },
}));

const sealCalls: { chapterId: string; provider: LLMProvider }[] = [];
let failChapter = '';
vi.mock('../postTurn/sealStage', () => ({
    buildSealInputs: () => ({ openThreads: [], existingTokens: undefined, currentFacts: [] }),
    runCombinedSeal: async (_c: string, chapter: ArchiveChapter, provider: LLMProvider) => {
        sealCalls.push({ chapterId: chapter.chapterId, provider });
        return chapter.chapterId === failChapter ? { summary: null, divergences: [] } : { summary: { summary: `sum ${chapter.chapterId}` }, divergences: [] };
    },
    applySealResult: async (_c: string, chapter: ArchiveChapter, result: { summary: { summary: string } | null }) => {
        chapters = chapters.map(c => c.chapterId !== chapter.chapterId ? c
            : result.summary ? { ...c, summary: result.summary.summary, invalidated: false } : { ...c, invalidated: true });
        return { merged: 0, closed: 0 };
    },
}));

const validateProviders: LLMProvider[] = [];
vi.mock('../../npc', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../npc')>()),
    validateNPCCandidates: async (provider: LLMProvider, names: string[]) => { validateProviders.push(provider); return names.filter(n => n !== 'Thursday'); },
}));

const scanProviders: LLMProvider[] = [];
vi.mock('../../campaign-state', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../campaign-state')>()),
    scanCharacterProfileWithPcState: async (provider: LLMProvider, _m: unknown, profile: unknown) => { scanProviders.push(provider); return { profile, pcStateUpdate: null }; },
    scanInventory: async (provider: LLMProvider) => { scanProviders.push(provider); return 'rope'; },
}));

const bookProviders: LLMProvider[] = [];
vi.mock('../../archive/bookService', () => ({
    regenerateBook: async (_c: string, bookId: string, provider: LLMProvider) => {
        bookProviders.push(provider);
        books = books.map(b => b.bookId === bookId ? { ...b, summaryPending: undefined, summary: 'book' } : b);
        return books;
    },
}));

import { needsCatchUp, collectNpcCandidates, runCatchUp, planCatchUp, type CatchUpDeps } from '../campaignCatchUp';

const ch = (id: string, start: number, over: Partial<ArchiveChapter> = {}): ArchiveChapter => ({
    chapterId: id, title: id, sceneRange: [String(start).padStart(3, '0'), String(start + 9).padStart(3, '0')], sceneIds: [],
    summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 10, sealedAt: 1, ...over,
});

const utility = { id: 'util', endpoint: 'http://u', modelName: 'small' } as unknown as LLMProvider;

function deps(over: Partial<CatchUpDeps> = {}): CatchUpDeps {
    return {
        campaignId: 'c', provider: utility, sceneBudgetSettings: undefined,
        getNpcLedger: () => [], getNpc: () => undefined, updateNPC: vi.fn(),
        getRegister: () => undefined, setRegister: vi.fn(),
        getArchiveIndex: () => [], setArchiveIndex: vi.fn(),
        setChapters: vi.fn(), setBooks: vi.fn(), addNpcSuggestions: vi.fn(),
        getMessages: () => [{ id: 'm', role: 'assistant', content: 'x', timestamp: 0 }],
        getContext: () => ({ characterProfileActive: true, characterProfile: { identity: {}, activeTraits: [] }, inventoryActive: true, inventory: '' }) as never,
        updateContext: vi.fn(),
        ...over,
    };
}

beforeEach(() => {
    sealCalls.length = 0; validateProviders.length = 0; scanProviders.length = 0; bookProviders.length = 0;
    failChapter = '';
    chapters = []; books = []; scenes = [];
});

describe('needsCatchUp', () => {
    it('picks sealed chapters with no summary or a failed seal, never the open one', () => {
        expect(needsCatchUp(ch('CH01', 1))).toBe(true);
        expect(needsCatchUp(ch('CH02', 11, { summary: 'done', invalidated: true }))).toBe(true);
        expect(needsCatchUp(ch('CH03', 21, { summary: 'done' }))).toBe(false);
        expect(needsCatchUp(ch('CH04', 31, { sealedAt: undefined }))).toBe(false);
    });
});

describe('collectNpcCandidates', () => {
    it('keeps names seen in two or more scenes and not on the ledger', () => {
        const ledger = [{ id: 'n1', name: 'Mira' }] as NPCEntry[];
        const got = collectNpcCandidates([
            { sceneId: '001', content: 'Kestrel Vane said hello. Mira said nothing. Odo muttered.' },
            { sceneId: '002', content: 'Later, Kestrel Vane whispered to Mira.' },
        ], ledger);
        expect(got.map(c => c.name)).toEqual(['Kestrel Vane']);
        expect(got[0].count).toBe(2);
        expect(got[0].snippet).toContain('Kestrel Vane');
    });
});

describe('runCatchUp', () => {
    it('summarises missing chapters oldest first and sends every call to the given provider', async () => {
        chapters = [ch('CH02', 11), ch('CH01', 1), ch('CH03', 21, { summary: 'already' }), ch('CH04', 31, { sealedAt: undefined })];
        books = [{ bookId: 'B1', title: 'One', sceneRange: ['001', '020'], summaryPending: true } as ArchiveBook];
        scenes = [
            { sceneId: '001', content: 'Kestrel Vane said hi. Thursday said no.' },
            { sceneId: '002', content: 'Kestrel Vane asked. Thursday replied.' },
        ];
        const d = deps({ getNpcLedger: () => [{ id: 'pc', name: 'Me', isPC: true } as NPCEntry] });

        const report = await runCatchUp(d, { cancelled: false }, () => {});

        expect(sealCalls.map(c => c.chapterId)).toEqual(['CH01', 'CH02']);
        expect(report).toMatchObject({ chaptersDone: 2, chaptersFailed: 0, npcsSuggested: 1, pcScanned: true, inventoryScanned: true, booksDone: 1, cancelled: false });
        expect(d.addNpcSuggestions).toHaveBeenCalledWith(['Kestrel Vane'], expect.any(String));
        for (const p of [...sealCalls.map(c => c.provider), ...validateProviders, ...scanProviders, ...bookProviders]) expect(p).toBe(utility);
    });

    it('tries a failing chapter once, then moves on', async () => {
        chapters = [ch('CH01', 1), ch('CH02', 11)];
        failChapter = 'CH01';
        const report = await runCatchUp(deps(), { cancelled: false }, () => {});
        expect(sealCalls.map(c => c.chapterId)).toEqual(['CH01', 'CH02']);
        expect(report.chaptersDone).toBe(1);
        expect(report.chaptersFailed).toBe(1);
    });

    it('stops at cancel, and a second run picks up the rest', async () => {
        chapters = [ch('CH01', 1), ch('CH02', 11), ch('CH03', 21)];
        const cancel = { cancelled: false };
        const first = await runCatchUp(deps(), cancel, (p) => { if (p.step === 'chapters' && p.done === 1) cancel.cancelled = true; });
        expect(first.cancelled).toBe(true);
        expect(first.chaptersDone).toBe(2);
        expect(scanProviders).toHaveLength(0);

        expect((await planCatchUp('c')).chapters.map(c => c.chapterId)).toEqual(['CH03']);
        sealCalls.length = 0;
        await runCatchUp(deps(), { cancelled: false }, () => {});
        expect(sealCalls.map(c => c.chapterId)).toEqual(['CH03']);
    });
});
