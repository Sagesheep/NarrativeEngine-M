import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveChapter, ChatMessage } from '../../types';

// AUDIT F1 — when gatherContext loses its race with the chapter funnel it aborts
// the funnel so its remaining per-chapter validation LLM calls stop spending.
// These tests pin the abort plumbing at the iterativeChapterFilter seam.

const mockLlmCall = vi.fn((..._args: unknown[]) => Promise.resolve('YES'));
vi.mock('../../utils/llmCall', () => ({
    llmCall: (...args: unknown[]) => mockLlmCall(...args),
}));

import { iterativeChapterFilter, MAX_CONFIRMED_CHAPTERS } from '../archive/archiveChapterEngine';

function makeChapter(id: string): ArchiveChapter {
    return {
        chapterId: id,
        title: `Chapter ${id}`,
        sceneRange: ['001', '010'],
        sceneIds: [],
        summary: `Summary of ${id}`,
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 10,
    };
}

const ranked = [makeChapter('CH01'), makeChapter('CH02'), makeChapter('CH03'), makeChapter('CH04')];
const provider = { id: 'u', endpoint: 'http://x', modelName: 'm', apiKey: '' } as never;
const messages: ChatMessage[] = [];

describe('iterativeChapterFilter abort plumbing (AUDIT F1)', () => {
    beforeEach(() => {
        mockLlmCall.mockClear();
        mockLlmCall.mockResolvedValue('YES');
    });

    it('issues validation calls when not aborted', async () => {
        const confirmed = await iterativeChapterFilter(ranked, 'q', messages, provider);
        expect(mockLlmCall).toHaveBeenCalled();
        expect(confirmed.length).toBeGreaterThan(0);
        expect(confirmed.length).toBeLessThanOrEqual(MAX_CONFIRMED_CHAPTERS);
    });

    it('makes zero LLM calls when the signal is already aborted', async () => {
        const confirmed = await iterativeChapterFilter(
            ranked, 'q', messages, provider, AbortSignal.abort()
        );
        expect(mockLlmCall).not.toHaveBeenCalled();
        expect(confirmed).toEqual([]);
    });

    it('stops spending once the signal aborts mid-run', async () => {
        const controller = new AbortController();
        // Abort as soon as the first validation call is issued.
        mockLlmCall.mockImplementationOnce(() => {
            controller.abort();
            return Promise.resolve('NO');
        });

        await iterativeChapterFilter(ranked, 'q', messages, provider, controller.signal);

        // First call fired (NO → not confirmed); loop then sees aborted and breaks.
        expect(mockLlmCall).toHaveBeenCalledTimes(1);
    });
});
