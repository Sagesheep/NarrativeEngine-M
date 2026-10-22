import type { ArchiveChapter } from '../types';

/**
 * Next free chapter number: one past the highest existing `CH<n>` id (split
 * halves like `CH03A` count as 3). Never `chapters.length + 1` — after a merge
 * that would reuse a live id, and updates by id would hit the wrong chapter.
 */
export function nextChapterNumber(chapters: ArchiveChapter[]): number {
    let max = 0;
    for (const ch of chapters) {
        const m = /^CH(\d+)/.exec(ch.chapterId);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
}

export function chapterIdFor(num: number): string {
    return `CH${String(num).padStart(2, '0')}`;
}
