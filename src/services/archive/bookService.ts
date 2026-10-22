/**
 * Book persistence + orchestration (the pure logic is in bookEngine.ts).
 */
import type { ArchiveBook, ArchiveChapter, LLMProvider } from '../../types';
import { api } from '../apiClient';
import { BOOK_AUTO_CLOSE_CHAPTERS, makeBook, summarizeBook, unbookedSealed, proposeBookBreaks, chaptersInBook } from './bookEngine';

/**
 * Close a book ending at `throughChapterId`: every sealed chapter after the last
 * book, up to and including it. Returns the updated book list, or null when
 * there is nothing to bind (no such unbooked chapter).
 */
export async function closeBookThrough(
    campaignId: string,
    throughChapterId: string,
    provider: LLMProvider | undefined,
    era?: string,
): Promise<ArchiveBook[] | null> {
    const [books, chapters] = await Promise.all([api.books.list(campaignId), api.chapters.list(campaignId)]);
    const candidates = unbookedSealed(chapters, books);
    const endAt = candidates.findIndex(c => c.chapterId === throughChapterId);
    if (endAt < 0) return null;
    const group = candidates.slice(0, endAt + 1);
    // A new book inherits the previous book's era unless one is given.
    const bookEra = era ?? books[books.length - 1]?.era;
    const summary = provider ? await summarizeBook(provider, group, bookEra) : null;
    const next = [...books, makeBook(books, group, summary, bookEra)];
    await api.books.save(campaignId, next);
    return next;
}

/** After a seal: bind a book once BOOK_AUTO_CLOSE_CHAPTERS sealed chapters sit outside one. */
export async function autoCloseBookIfDue(campaignId: string, chapters: ArchiveChapter[], provider: LLMProvider | undefined): Promise<ArchiveBook[] | null> {
    const books = await api.books.list(campaignId);
    const candidates = unbookedSealed(chapters, books);
    if (candidates.length < BOOK_AUTO_CLOSE_CHAPTERS) return null;
    return closeBookThrough(campaignId, candidates[BOOK_AUTO_CLOSE_CHAPTERS - 1].chapterId, provider);
}

/** "Build Books" step 1: the AI's proposed book ends for chapters not yet in a book. */
export async function proposeBooksForExisting(campaignId: string, provider: LLMProvider | undefined): Promise<{ candidates: ArchiveChapter[]; breaks: string[] }> {
    const [books, chapters] = await Promise.all([api.books.list(campaignId), api.chapters.list(campaignId)]);
    const candidates = unbookedSealed(chapters, books);
    return { candidates, breaks: await proposeBookBreaks(provider, candidates) };
}

/** "Build Books" step 2: bind a book at each confirmed break, oldest first. */
export async function buildBooks(
    campaignId: string,
    breaks: string[],
    provider: LLMProvider | undefined,
    onStatus: (msg: string) => void,
): Promise<ArchiveBook[]> {
    let books = await api.books.list(campaignId);
    for (let i = 0; i < breaks.length; i++) {
        onStatus(`Writing book ${i + 1}/${breaks.length}…`);
        books = (await closeBookThrough(campaignId, breaks[i], provider)) ?? books;
    }
    return books;
}

/** Rewrite one book's summary (after a failed call, or to refresh it). */
export async function regenerateBook(campaignId: string, bookId: string, provider: LLMProvider): Promise<ArchiveBook[] | null> {
    const [books, chapters] = await Promise.all([api.books.list(campaignId), api.chapters.list(campaignId)]);
    const idx = books.findIndex(b => b.bookId === bookId);
    if (idx < 0) return null;
    const book = books[idx];
    const summary = await summarizeBook(provider, chaptersInBook(book, chapters), book.era);
    if (!summary) return null;
    const { summaryPending: _p, ...rest } = book;
    const next = books.map((b, i) => i === idx ? { ...rest, ...summary } : b);
    await api.books.save(campaignId, next);
    return next;
}

/** Edit a book's era label / title by hand. */
export async function updateBook(campaignId: string, bookId: string, patch: Partial<Pick<ArchiveBook, 'era' | 'title'>>): Promise<ArchiveBook[]> {
    const books = await api.books.list(campaignId);
    const next = books.map(b => b.bookId === bookId ? { ...b, ...patch } : b);
    await api.books.save(campaignId, next);
    return next;
}

/** Unbind the newest book (its chapters go back to being loose). Only the last can go — books stay contiguous. */
export async function removeLastBook(campaignId: string): Promise<ArchiveBook[]> {
    const books = await api.books.list(campaignId);
    const next = books.slice(0, -1);
    await api.books.save(campaignId, next);
    return next;
}
