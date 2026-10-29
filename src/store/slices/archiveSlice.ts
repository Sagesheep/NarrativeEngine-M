import type { StateCreator } from 'zustand';
import type { ArchiveIndexEntry, ArchiveChapter, ArchiveBook, SemanticFact, TimelineEvent, EntityEntry } from '../../types';

// ── Slice type ─────────────────────────────────────────────────────────

export type ArchiveSlice = {
    archiveIndex: ArchiveIndexEntry[];
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;

    // Chapters & semantic facts
    chapters: ArchiveChapter[];
    semanticFacts: SemanticFact[];
    setChapters: (chapters: ArchiveChapter[]) => void;
    /** Books: runs of sealed chapters with their own summary (bookEngine.ts). */
    books: ArchiveBook[];
    setBooks: (books: ArchiveBook[]) => void;
    setSemanticFacts: (facts: SemanticFact[]) => void;

    // Timeline / World State
    timeline: TimelineEvent[];
    setTimeline: (events: TimelineEvent[]) => void;
    addTimelineEvent: (event: TimelineEvent) => void;
    removeTimelineEvent: (eventId: string) => void;

    // Entity Registry
    entities: EntityEntry[];
    setEntities: (entities: EntityEntry[]) => void;

    // Pinned Chapters
    pinnedChapterIds: string[];
    pinChapter: (chapterId: string) => void;
    clearPinnedChapters: () => void;

    // Pinned Books — unlike chapter pins they stay until unpinned (or the campaign changes)
    pinnedBookIds: string[];
    pinBook: (bookId: string) => void;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createArchiveSlice: StateCreator<ArchiveSlice, [], [], ArchiveSlice> = (set) => ({
    archiveIndex: [],
    setArchiveIndex: (entries) => set({ archiveIndex: entries }),

    chapters: [],
    semanticFacts: [],
    setChapters: (chapters) => set({ chapters }),
    books: [],
    // A pin on a book that is gone (unbound, rolled back) is dropped, so the next
    // book bound under the same id does not inherit it.
    setBooks: (books) => set((s) => ({
        books,
        pinnedBookIds: s.pinnedBookIds.filter((id) => books.some((b) => b.bookId === id)),
    })),
    setSemanticFacts: (facts) => set({ semanticFacts: facts }),

    timeline: [],
    setTimeline: (events) => set({ timeline: events }),
    addTimelineEvent: (event) => set((s) => ({ timeline: [...s.timeline, event] })),
    removeTimelineEvent: (eventId) => set((s) => ({ timeline: s.timeline.filter((e) => e.id !== eventId) })),

    entities: [],
    setEntities: (entities) => set({ entities }),

    pinnedChapterIds: [],
    pinChapter: (chapterId) => set((s) => {
        const pinned = s.pinnedChapterIds.includes(chapterId)
            ? s.pinnedChapterIds.filter((id) => id !== chapterId)
            : [...s.pinnedChapterIds, chapterId];
        return { pinnedChapterIds: pinned };
    }),
    clearPinnedChapters: () => set({ pinnedChapterIds: [] }),

    pinnedBookIds: [],
    pinBook: (bookId) => set((s) => ({
        pinnedBookIds: s.pinnedBookIds.includes(bookId)
            ? s.pinnedBookIds.filter((id) => id !== bookId)
            : [...s.pinnedBookIds, bookId],
    })),
});
