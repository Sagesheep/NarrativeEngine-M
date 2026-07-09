/**
 * chapterRepositoryAdapter — wires campaignStore behind the
 * ChapterRepositoryPort.
 */

import { loadChapters } from '../store/campaignStore';
import { registerChapterRepository, type ChapterRepositoryPort } from '../ports/chapterRepository';

export const chapterRepositoryAdapter: ChapterRepositoryPort = {
    loadChapters: (id) => loadChapters(id),
};

export function wireChapterRepository(): void {
    registerChapterRepository(chapterRepositoryAdapter);
}
