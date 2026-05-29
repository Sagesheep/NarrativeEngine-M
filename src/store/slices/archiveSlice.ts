import type { StateCreator } from 'zustand';
import type { ArchiveIndexEntry, ArchiveChapter, SemanticFact, TimelineEvent, EntityEntry } from '../../types';

// ── Slice type ─────────────────────────────────────────────────────────

export type ArchiveSlice = {
    archiveIndex: ArchiveIndexEntry[];
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;

    // Chapters & semantic facts
    chapters: ArchiveChapter[];
    semanticFacts: SemanticFact[];
    setChapters: (chapters: ArchiveChapter[]) => void;
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
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createArchiveSlice: StateCreator<ArchiveSlice, [], [], ArchiveSlice> = (set) => ({
    archiveIndex: [],
    setArchiveIndex: (entries) => set({ archiveIndex: entries }),

    chapters: [],
    semanticFacts: [],
    setChapters: (chapters) => set({ chapters }),
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
});
