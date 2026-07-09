/**
 * ChapterRepositoryPort — persistence seam for archive chapters.
 *
 * turnPostProcess.ts used to import loadChapters directly from
 * store/campaignStore — a runtime leak (services → store).
 *
 * This port flips the arrow, same pattern as LoreRepositoryPort.
 */

import type { ArchiveChapter } from '../types';

export interface ChapterRepositoryPort {
    loadChapters(campaignId: string): Promise<ArchiveChapter[]>;
}

let _impl: ChapterRepositoryPort | null = null;

export function registerChapterRepository(impl: ChapterRepositoryPort): void {
    _impl = impl;
}

function impl(): ChapterRepositoryPort {
    if (!_impl) {
        throw new Error(
            'ChapterRepositoryPort not wired. Call registerChapterRepository() ' +
            'from app bootstrap before any service uses it.'
        );
    }
    return _impl;
}

export const chapterRepository: ChapterRepositoryPort = {
    loadChapters: (id) => impl().loadChapters(id),
};
