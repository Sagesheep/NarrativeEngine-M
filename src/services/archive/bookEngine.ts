/**
 * Books — the level above chapters. A book is a run of sealed chapters with its
 * own summary, written from the chapter summaries (never raw scenes), so closing
 * one is a small AI call. Books are contiguous from the first scene: the next
 * book always starts at the first sealed chapter after the last book.
 *
 * Pure except for the summarizer/proposer LLM calls; persistence lives in
 * bookService.ts so storage can import this file without a cycle.
 */
import type { ArchiveBook, ArchiveChapter, LLMProvider } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    extractJsonRobust,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    TTRPG_PERSONA_ARCHIVIST,
    joinPromptSections,
} from '../infrastructure';

/** A book closes by itself once this many sealed chapters sit outside any book. */
export const BOOK_AUTO_CLOSE_CHAPTERS = 10;

const sceneNum = (id: string) => parseInt(id, 10);
const byStart = (a: ArchiveChapter, b: ArchiveChapter) => sceneNum(a.sceneRange[0]) - sceneNum(b.sceneRange[0]);

export function nextBookId(books: ArchiveBook[]): string {
    let max = 0;
    for (const b of books) {
        const m = /^BK(\d+)/.exec(b.bookId);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `BK${String(max + 1).padStart(2, '0')}`;
}

/** The book a chapter belongs to: the one whose range holds its first scene. */
export function bookOf(chapter: ArchiveChapter, books: ArchiveBook[]): ArchiveBook | undefined {
    const start = sceneNum(chapter.sceneRange[0]);
    return books.find(b => start >= sceneNum(b.sceneRange[0]) && start <= sceneNum(b.sceneRange[1]));
}

export function chaptersInBook(book: ArchiveBook, chapters: ArchiveChapter[]): ArchiveChapter[] {
    return chapters.filter(c => bookOf(c, [book]) !== undefined).sort(byStart);
}

/** Sealed chapters after the last book, oldest first — the next book's candidates. */
export function unbookedSealed(chapters: ArchiveChapter[], books: ArchiveBook[]): ArchiveChapter[] {
    const lastEnd = books.reduce((m, b) => Math.max(m, sceneNum(b.sceneRange[1])), 0);
    return chapters.filter(c => c.sealedAt && sceneNum(c.sceneRange[0]) > lastEnd).sort(byStart);
}

/**
 * Drop books that no longer match the chapters: a book with no chapters left (a
 * rollback or restore removed them), or one holding the chapter that is taking
 * new scenes (a rollback reopened it, so the book would keep growing). Later
 * books go with it, so books stay contiguous. An old chapter reopened by a single
 * scene delete does not dissolve its book.
 */
export function reconcileBooks(books: ArchiveBook[], chapters: ArchiveChapter[]): ArchiveBook[] {
    const ordered = [...books].sort((a, b) => sceneNum(a.sceneRange[0]) - sceneNum(b.sceneRange[0]));
    const growing = chapters.filter(c => !c.sealedAt).sort(byStart).pop();
    const kept: ArchiveBook[] = [];
    for (const book of ordered) {
        if (chaptersInBook(book, chapters).length === 0) break;
        if (growing && bookOf(growing, [book])) break;
        kept.push(book);
    }
    return kept;
}

export type BookSummary = Pick<ArchiveBook, 'title' | 'summary' | 'keywords' | 'npcs' | 'majorEvents' | 'unresolvedThreads'>;

/** Build a book record over `chapters` (oldest first, all sealed). */
export function makeBook(books: ArchiveBook[], chapters: ArchiveChapter[], summary: BookSummary | null, era?: string): ArchiveBook {
    const sorted = [...chapters].sort(byStart);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const fallback: BookSummary = {
        title: `${first.title} – ${last.title}`,
        summary: sorted.map(c => `${c.chapterId} ${c.title}.`).join(' '),
        keywords: [], npcs: uniq(sorted.flatMap(c => c.npcs)).slice(0, 20), majorEvents: [], unresolvedThreads: last.unresolvedThreads ?? [],
    };
    return {
        bookId: nextBookId(books),
        sceneRange: [first.sceneRange[0], last.sceneRange[1]],
        ...(era?.trim() ? { era: era.trim() } : {}),
        ...(summary ?? fallback),
        createdAt: Date.now(),
        ...(summary ? {} : { summaryPending: true }),
    };
}

function uniq(xs: string[]): string[] {
    return Array.from(new Set(xs.map(x => x.trim()).filter(Boolean)));
}

function chapterBlock(c: ArchiveChapter): string {
    const events = (c.majorEvents ?? []).slice(0, 8).join('; ');
    const threads = (c.unresolvedThreads ?? []).join('; ');
    return [
        `${c.chapterId} [scenes ${c.sceneRange[0]}-${c.sceneRange[1]}] "${c.title}"`,
        c.summary.trim(),
        events ? `Events: ${events}` : '',
        threads ? `Open threads: ${threads}` : '',
        c.resolvedThreads?.length ? `Settled threads: ${c.resolvedThreads.join('; ')}` : '',
    ].filter(Boolean).join('\n');
}

/** Write a book summary from its chapters' summaries. Null on any failure. */
export async function summarizeBook(provider: LLMProvider, chapters: ArchiveChapter[], era?: string): Promise<BookSummary | null> {
    const sorted = [...chapters].sort(byStart);
    const prompt = joinPromptSections(
        `${TTRPG_PERSONA_ARCHIVIST} Several chapters of a long campaign are being bound into one BOOK. Write the book's summary from the chapter summaries below.`,

        `OUTPUT FORMAT — a single JSON object:
{
  "title": "2-5 word evocative book title",
  "summary": "150-250 words: the arc of this book as a story — where it started, the turning points, how it ended, and how the main relationships changed",
  "keywords": ["distinctive places, factions, artifacts, concepts"],
  "npcs": ["every named character who mattered in this book"],
  "majorEvents": ["8-12 plot-critical beats, oldest first"],
  "unresolvedThreads": ["hooks still open at the END of the book — leave out ones a later chapter settled"]
}`,

        'Write for a GM who will read only this summary to recall the book. Concrete names and outcomes over mood.',

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        era?.trim() ? `ERA: ${era.trim()}` : '',
        `CHAPTERS (oldest first):\n\n${sorted.map(chapterBlock).join('\n\n')}`,
    );

    try {
        const raw = await llmCall(provider, prompt, { temperature: 0.3, maxTokens: 3000, thinkingEffort: 'off', timeoutMs: 5 * 60 * 1000, trackingLabel: 'book-summary' });
        const { value } = extractJsonRobust<Partial<Record<keyof BookSummary, unknown>>>(raw, {});
        const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
        const list = (v: unknown) => Array.isArray(v) ? uniq(v.filter((x): x is string => typeof x === 'string')) : [];
        const summary = str(value.summary);
        if (!summary) return null;
        return {
            title: str(value.title) || `${sorted[0].title} – ${sorted[sorted.length - 1].title}`,
            summary,
            keywords: list(value.keywords),
            npcs: list(value.npcs),
            majorEvents: list(value.majorEvents),
            unresolvedThreads: list(value.unresolvedThreads),
        };
    } catch (e) {
        console.warn('[Books] Summary failed:', e);
        return null;
    }
}

/**
 * "Build Books": where should existing chapters be split into books? Returns the
 * chapter ids that END a book, in order; every group is at most
 * BOOK_AUTO_CLOSE_CHAPTERS long. Falls back to fixed groups of that size.
 */
export async function proposeBookBreaks(provider: LLMProvider | undefined, chapters: ArchiveChapter[]): Promise<string[]> {
    const sorted = [...chapters].filter(c => c.sealedAt).sort(byStart);
    if (sorted.length === 0) return [];
    let breaks: string[] = [];
    if (provider) {
        const prompt = joinPromptSections(
            `${TTRPG_PERSONA_ARCHIVIST} A long campaign's chapters are being grouped into BOOKS (like the volumes of a novel series). Choose where each book ends.`,
            `OUTPUT FORMAT — a single JSON object:
{"bookEnds":["CH07","CH15"]}`,
            `RULES:
- End a book at a real story break: an arc resolved, a time skip, a change of setting or era, a new status quo.
- A book is 4 to ${BOOK_AUTO_CLOSE_CHAPTERS} chapters. Never more than ${BOOK_AUTO_CLOSE_CHAPTERS}.
- The last chapter listed may stay outside a book if its arc is still running: only list a book end there if the arc clearly ended.`,
            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,
            `CHAPTERS (oldest first):\n${sorted.map(c => `${c.chapterId} "${c.title}": ${c.summary.trim().slice(0, 400)}`).join('\n')}`,
        );
        try {
            const raw = await llmCall(provider, prompt, { temperature: 0.2, maxTokens: 800, thinkingEffort: 'off', timeoutMs: 5 * 60 * 1000, trackingLabel: 'book-breaks' });
            const { value } = extractJsonRobust<{ bookEnds?: unknown }>(raw, {});
            if (Array.isArray(value.bookEnds)) breaks = value.bookEnds.filter((x): x is string => typeof x === 'string').map(x => x.trim().toUpperCase());
        } catch (e) {
            console.warn('[Books] Break proposal failed, using fixed groups:', e);
        }
    }
    return enforceBreaks(sorted, breaks);
}

/** Keep valid, ordered breaks and split any group longer than the max. */
export function enforceBreaks(sorted: ArchiveChapter[], proposed: string[]): string[] {
    const wanted = new Set(proposed);
    const out: string[] = [];
    let run = 0;
    for (const c of sorted) {
        run++;
        if (wanted.has(c.chapterId) || run >= BOOK_AUTO_CLOSE_CHAPTERS) {
            out.push(c.chapterId);
            run = 0;
        }
    }
    return out;
}

/** Books recall keeps for the chapter step (the open, unbooked chapters always stay). */
export const RECALL_BOOKS = 2;

/**
 * Find-then-zoom, step 1: which books is this turn about? Scores each book's
 * keywords and NPCs against the turn's activations, weighting each term by how
 * rare it is across books — by the P5 era a main character appears in every
 * book, so their name alone must not pick one. Deterministic (no AI call): the
 * recall funnel already runs against a short deadline. Null when nothing
 * matches, so the caller falls back to ranking every chapter.
 */
export function shortlistBooks(books: ArchiveBook[], activations: Record<string, number>, max = RECALL_BOOKS): Set<string> | null {
    if (books.length === 0) return null;
    const terms = (b: ArchiveBook) => ({
        keywords: uniq(b.keywords.map(t => t.toLowerCase())),
        npcs: uniq(b.npcs.map(t => t.toLowerCase())),
    });
    const df = new Map<string, number>();
    for (const b of books) {
        const t = terms(b);
        for (const term of new Set([...t.keywords, ...t.npcs])) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const idf = (term: string) => Math.log(1 + books.length / (df.get(term) ?? 1));
    const scored = books.map(b => {
        const t = terms(b);
        let score = 0;
        for (const kw of t.keywords) if (activations[kw]) score += activations[kw] * idf(kw);
        for (const npc of t.npcs) if (activations[npc]) score += activations[npc] * 2 * idf(npc);
        return { id: b.bookId, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    return scored.length > 0 ? new Set(scored.slice(0, max).map(s => s.id)) : null;
}
