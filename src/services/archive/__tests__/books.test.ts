import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn() }));

import { reconcileBooks, unbookedSealed, enforceBreaks, rankBooks, rankBooksByHits, bookOfScene, isBookPickConfident, makeBook, nextBookId, bookOf, BOOK_AUTO_CLOSE_CHAPTERS } from '../bookEngine';
import { boostBookChapters } from '../archiveChapterEngine';
import { renderLodChapters } from '../../payload/lodRenderer';
import type { ArchiveBook, ArchiveChapter, ChatMessage } from '../../../types';

const pad = (n: number) => String(n).padStart(3, '0');
function chapter(n: number, from: number, to: number, over: Partial<ArchiveChapter> = {}): ArchiveChapter {
    const id = `CH${String(n).padStart(2, '0')}`;
    return {
        chapterId: id, title: `Title ${id}`, sceneRange: [pad(from), pad(to)], sceneIds: [],
        summary: `First of ${id}. Detail of ${id}.`, keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
        tone: '', themes: [], sceneCount: to - from + 1, sealedAt: 1, ...over,
    };
}
function book(id: string, from: number, to: number, over: Partial<ArchiveBook> = {}): ArchiveBook {
    return {
        bookId: id, title: `Book ${id}`, sceneRange: [pad(from), pad(to)], summary: `Opening of ${id}. Middle of ${id}.`,
        keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], createdAt: 0, ...over,
    };
}
/** Chapters of 5 scenes each: CH01 = 1-5, CH02 = 6-10, … the last one open. */
const run = (count: number, openLast = true) => Array.from({ length: count }, (_, i) =>
    chapter(i + 1, i * 5 + 1, i * 5 + 5, openLast && i === count - 1 ? { sealedAt: undefined } : {}));

describe('book membership', () => {
    it('a chapter belongs to the book holding its first scene', () => {
        const books = [book('BK01', 1, 15)];
        expect(bookOf(chapter(2, 6, 10), books)?.bookId).toBe('BK01');
        expect(bookOf(chapter(4, 16, 20), books)).toBeUndefined();
    });

    it('unbookedSealed is the sealed chapters after the last book, oldest first', () => {
        const chapters = run(6);
        expect(unbookedSealed(chapters, [book('BK01', 1, 10)]).map(c => c.chapterId)).toEqual(['CH03', 'CH04', 'CH05']);
    });

    it('next book id is one past the highest', () => {
        expect(nextBookId([])).toBe('BK01');
        expect(nextBookId([book('BK01', 1, 5), book('BK03', 6, 10)])).toBe('BK04');
    });

    it('makeBook spans its chapters and falls back to a stand-in summary', () => {
        const b = makeBook([], run(3, false), null, 'P3 · 2009');
        expect(b).toMatchObject({ bookId: 'BK01', sceneRange: ['001', '015'], era: 'P3 · 2009', summaryPending: true });
        expect(b.summary).toContain('CH01 Title CH01.');
    });
});

describe('reconcileBooks', () => {
    it('keeps books whose chapters still exist', () => {
        const books = [book('BK01', 1, 10), book('BK02', 11, 20)];
        expect(reconcileBooks(books, run(6))).toEqual(books);
    });

    it('drops a book (and later ones) once rollback reopened a chapter in it', () => {
        // Rolled back to scene 8: CH02 reopened and takes new scenes; CH03+ deleted.
        const chapters = [chapter(1, 1, 5), chapter(2, 6, 7, { sealedAt: undefined })];
        expect(reconcileBooks([book('BK01', 1, 10), book('BK02', 11, 20)], chapters)).toEqual([]);
    });

    it('keeps a book when a single old scene delete reopened one of its chapters', () => {
        const chapters = run(6);
        chapters[1] = { ...chapters[1], sealedAt: undefined, invalidated: true };
        expect(reconcileBooks([book('BK01', 1, 10)], chapters).map(b => b.bookId)).toEqual(['BK01']);
    });

    it('drops books whose chapters are gone (restore of an older backup)', () => {
        expect(reconcileBooks([book('BK01', 1, 10), book('BK02', 11, 20)], run(3)).map(b => b.bookId)).toEqual(['BK01']);
    });
});

describe('enforceBreaks', () => {
    it('keeps proposed breaks in order and never lets a book exceed the max', () => {
        const chapters = run(25, false);
        const breaks = enforceBreaks(chapters, ['CH04', 'CH99', 'CH20']);
        expect(breaks).toEqual(['CH04', 'CH14', 'CH20']);
        expect(BOOK_AUTO_CLOSE_CHAPTERS).toBe(10);
    });

    it('falls back to fixed groups with no proposal', () => {
        expect(enforceBreaks(run(21, false), [])).toEqual(['CH10', 'CH20']);
    });
});

describe('rankBooks (find, then zoom)', () => {
    const books = [
        book('BK01', 1, 10, { npcs: ['Mitsuru', 'Junpei'], keywords: ['tartarus'] }),
        book('BK02', 11, 20, { npcs: ['Mitsuru', 'Chihiro'], keywords: ['student council'] }),
        book('BK03', 21, 30, { npcs: ['Mitsuru', 'Elizabeth'], keywords: ['velvet room', 'kyoto'] }),
    ];

    it('a name in every book does not pick one; a rarer term does', () => {
        expect(rankBooks(books, { mitsuru: 1 }, {}, 1)).toHaveLength(1);
        expect(rankBooks(books, { mitsuru: 1, kyoto: 1 }, {}, 1)).toEqual(['BK03']);
        expect(rankBooks(books, { mitsuru: 1, chihiro: 1 }, {}, 1)).toEqual(['BK02']);
    });

    it('empty when nothing points anywhere, so recall ranks every chapter', () => {
        expect(rankBooks(books, { akihiko: 1 })).toEqual([]);
        expect(rankBooks([], { mitsuru: 1 }, { pinnedBookIds: ['BK01'] })).toEqual([]);
    });

    it('scene vector hits roll up to their book with no keyword match', () => {
        const hits = [{ id: '014', score: 0.71 }, { id: '017', score: 0.64 }, { id: '025', score: 0.69 }];
        expect(rankBooksByHits(books, hits)).toEqual(['BK02', 'BK03']);
        expect(rankBooks(books, { akihiko: 1 }, { sceneHits: hits }, 1)).toEqual(['BK02']);
    });

    it('a book with several strong hits beats one with a single slightly better hit', () => {
        const hits = [{ id: '025', score: 0.8 }, { id: '003', score: 0.75 }, { id: '005', score: 0.7 }];
        expect(rankBooksByHits(books, hits)[0]).toBe('BK01');
    });

    it('scene ids outside every book (loose chapters) are ignored', () => {
        expect(rankBooksByHits(books, [{ id: '040', score: 0.9 }])).toEqual([]);
        expect(bookOfScene('040', books)).toBeUndefined();
        expect(bookOfScene('011', books)?.bookId).toBe('BK02');
    });

    it('a planner pick outweighs a keyword match on another book', () => {
        expect(rankBooks(books, { kyoto: 1 }, { plannerBookIds: ['bk01'] }, 1)).toEqual(['BK01']);
    });

    it('planner ids that are not books are ignored', () => {
        expect(rankBooks(books, {}, { plannerBookIds: ['BK09', 'CH03'] })).toEqual([]);
    });

    it('pinned books come first and are kept even past the limit', () => {
        expect(rankBooks(books, { kyoto: 1 }, { pinnedBookIds: ['BK01'] }, 2)).toEqual(['BK01', 'BK03']);
        expect(rankBooks(books, { kyoto: 1 }, { pinnedBookIds: ['BK01', 'BK02'] }, 1)).toEqual(['BK01', 'BK02']);
    });
});

describe('isBookPickConfident (when the chapter check can be skipped)', () => {
    const books = [book('BK01', 1, 10), book('BK02', 11, 20)];
    const hitsOnBK02 = [{ id: '014', score: 0.7 }, { id: '003', score: 0.4 }];

    it('a pinned book is confident', () => {
        expect(isBookPickConfident(books, { pinnedBookIds: ['BK01'] })).toBe(true);
    });

    it('planner and vectors agreeing is confident; disagreeing or one alone is not', () => {
        expect(isBookPickConfident(books, { plannerBookIds: ['BK02'], sceneHits: hitsOnBK02 })).toBe(true);
        expect(isBookPickConfident(books, { plannerBookIds: ['BK01'], sceneHits: hitsOnBK02 })).toBe(false);
        expect(isBookPickConfident(books, { plannerBookIds: ['BK02'] })).toBe(false);
        expect(isBookPickConfident(books, { sceneHits: hitsOnBK02 })).toBe(false);
    });

    it('a pin on a book that is gone is not', () => {
        expect(isBookPickConfident(books, { pinnedBookIds: ['BK07'] })).toBe(false);
    });
});

describe('boostBookChapters (a boost, not a filter)', () => {
    const books = [book('BK01', 1, 10), book('BK02', 11, 20)];
    const chapters = run(5); // CH01 1-5, CH02 6-10 (BK01), CH03 11-15, CH04 16-20 (BK02), CH05 open

    it('puts picked-book and loose chapters first, keeps every chapter', () => {
        const ranked = [chapters[0], chapters[2], chapters[4], chapters[1], chapters[3]];
        const out = boostBookChapters(ranked, books, ['BK02']).map(c => c.chapterId);
        expect(out).toEqual(['CH03', 'CH05', 'CH04', 'CH01', 'CH02']);
    });
});

describe('recap with books', () => {
    function transcript(scenes: number): ChatMessage[] {
        const out: ChatMessage[] = [];
        for (let n = 1; n <= scenes; n++) {
            out.push({ id: `u${n}`, role: 'user', content: `p ${n}`, timestamp: 0 });
            out.push({ id: `m${n}`, role: 'system', name: 'scene-marker', content: `Scene ${pad(n)}`, timestamp: 0 });
        }
        return out;
    }
    const chapters = run(8, false); // scenes 1-40
    const messages = transcript(45);
    const condensed = 40 * 2 - 1; // through scene 40

    it("books replace their chapters; newest book in full, older as one line", () => {
        const books = [book('BK01', 1, 10, { era: 'P3' }), book('BK02', 11, 20), book('BK03', 21, 30)];
        const r = renderLodChapters({ chapters, books, archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000, config: { summaryChapters: 7, importanceBonus: 0, summaryBooks: 2 } });
        expect(r.tierByChapterId).toMatchObject({ BK01: 'synopsis', BK02: 'summary', BK03: 'summary', CH07: 'summary', CH08: 'summary' });
        expect(Object.keys(r.tierByChapterId)).not.toContain('CH01');
        expect(r.text).toContain('Book BK01 — Book BK01 (P3)\nOpening of BK01.');
        expect(r.text).not.toContain('Middle of BK01');
        expect(r.text).toContain('Middle of BK03');
        expect(r.text).not.toContain('Chapter CH01');
        expect(r.text.indexOf('BK03')).toBeLessThan(r.text.indexOf('CH07'));
    });

    it('a pinned old book renders its full summary', () => {
        const books = [book('BK01', 1, 10), book('BK02', 11, 20), book('BK03', 21, 30)];
        const r = renderLodChapters({ chapters, books, pinnedBookIds: ['BK01'], archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000, config: { summaryChapters: 7, importanceBonus: 0, summaryBooks: 2 } });
        expect(r.tierByChapterId).toMatchObject({ BK01: 'summary', BK02: 'summary', BK03: 'summary' });
        expect(r.text).toContain('Middle of BK01');
    });

    it('is identical without books to the old chapter-only recap', () => {
        const a = renderLodChapters({ chapters, archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000 });
        const b = renderLodChapters({ chapters, books: [], archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000 });
        expect(b).toEqual(a);
        expect(Object.keys(a.tierByChapterId)).toHaveLength(8);
    });
});
