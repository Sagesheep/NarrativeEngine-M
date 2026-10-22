import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn() }));

import { reconcileBooks, unbookedSealed, enforceBreaks, shortlistBooks, makeBook, nextBookId, bookOf, BOOK_AUTO_CLOSE_CHAPTERS } from '../bookEngine';
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

describe('shortlistBooks (find, then zoom)', () => {
    const books = [
        book('BK01', 1, 10, { npcs: ['Mitsuru', 'Junpei'], keywords: ['tartarus'] }),
        book('BK02', 11, 20, { npcs: ['Mitsuru', 'Chihiro'], keywords: ['student council'] }),
        book('BK03', 21, 30, { npcs: ['Mitsuru', 'Elizabeth'], keywords: ['velvet room', 'kyoto'] }),
    ];

    it('a name in every book does not pick one; a rarer term does', () => {
        expect(shortlistBooks(books, { mitsuru: 1 }, 1)?.size).toBe(1);
        expect([...shortlistBooks(books, { mitsuru: 1, kyoto: 1 }, 1)!]).toEqual(['BK03']);
        expect([...shortlistBooks(books, { mitsuru: 1, chihiro: 1 }, 1)!]).toEqual(['BK02']);
    });

    it('null when nothing matches, so recall ranks every chapter', () => {
        expect(shortlistBooks(books, { akihiko: 1 })).toBeNull();
        expect(shortlistBooks([], { mitsuru: 1 })).toBeNull();
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

    it('is identical without books to the old chapter-only recap', () => {
        const a = renderLodChapters({ chapters, archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000 });
        const b = renderLodChapters({ chapters, books: [], archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000 });
        expect(b).toEqual(a);
        expect(Object.keys(a.tierByChapterId)).toHaveLength(8);
    });
});
