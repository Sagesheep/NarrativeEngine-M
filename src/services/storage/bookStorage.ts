import type { ArchiveBook, ArchiveChapter } from '../../types';
import { getList, setList, k } from './_helpers';
import { reconcileBooks } from '../archive/bookEngine';

export const bookStorage = {
    /** Books, with any that no longer match the chapters (rollback, restore) dropped. */
    async list(cid: string): Promise<ArchiveBook[]> {
        const books = await getList<ArchiveBook>(k(cid, 'books'));
        if (books.length === 0) return books;
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const valid = reconcileBooks(books, chapters);
        if (valid.length !== books.length) {
            await setList(k(cid, 'books'), valid);
            console.log(`[Books] Dropped ${books.length - valid.length} book(s) whose chapters changed`);
        }
        return valid;
    },

    async save(cid: string, books: ArchiveBook[]): Promise<void> {
        await setList(k(cid, 'books'), books);
    },
};
