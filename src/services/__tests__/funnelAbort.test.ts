import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveChapter, ChatMessage } from '../../types';

// AUDIT F1 — when gatherContext loses its race with the chapter funnel it aborts
// the funnel so its chapter check stops spending. These tests pin the abort
// plumbing and the answer handling at the batchChapterFilter seam.

const mockLlmCall = vi.fn((..._args: unknown[]) => Promise.resolve('["CH01"]'));
vi.mock('../../utils/llmCall', () => ({
    llmCall: (...args: unknown[]) => mockLlmCall(...args),
}));

import { batchChapterFilter, parseChapterPicks, fuseChapterHits, MAX_CONFIRMED_CHAPTERS, CHAPTER_CHECK_CANDIDATES } from '../archive/archiveChapterEngine';

function makeChapter(id: string, from = '001', to = '010'): ArchiveChapter {
    return {
        chapterId: id,
        title: `Chapter ${id}`,
        sceneRange: [from, to],
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

const ranked = Array.from({ length: 8 }, (_, i) => makeChapter(`CH0${i + 1}`));
const ids = (chs: ArchiveChapter[]) => chs.map(c => c.chapterId);
const provider = { id: 'u', endpoint: 'http://x', modelName: 'm', apiKey: '' } as never;
const messages: ChatMessage[] = [];

describe('batchChapterFilter: one call', () => {
    beforeEach(() => {
        mockLlmCall.mockReset();
        mockLlmCall.mockResolvedValue('["CH01"]');
    });

    it('makes exactly one call over the top candidates, thinking off', async () => {
        await batchChapterFilter(ranked, 'q', messages, provider);
        expect(mockLlmCall).toHaveBeenCalledTimes(1);
        const [, prompt, opts] = mockLlmCall.mock.calls[0] as [unknown, string, Record<string, unknown>];
        expect(opts).toMatchObject({ thinkingEffort: 'off' });
        expect(prompt).toContain(`CH0${CHAPTER_CHECK_CANDIDATES}`);
        expect(prompt).not.toContain(`CH0${CHAPTER_CHECK_CANDIDATES + 1}`);
    });

    it('returns the picked chapters in the order the check gave', async () => {
        mockLlmCall.mockResolvedValue('["CH05", "CH02"]');
        expect(ids(await batchChapterFilter(ranked, 'q', messages, provider))).toEqual(['CH05', 'CH02']);
    });

    it('a clear "none" is a real no', async () => {
        mockLlmCall.mockResolvedValue('[]');
        expect(await batchChapterFilter(ranked, 'q', messages, provider)).toEqual([]);
    });

    it('an empty or unreadable answer is a failed call (fail-open to the top by rank)', async () => {
        mockLlmCall.mockResolvedValue('');
        expect(ids(await batchChapterFilter(ranked, 'q', messages, provider))).toEqual(['CH01', 'CH02', 'CH03']);
        mockLlmCall.mockResolvedValue('I think the second one');
        expect(await batchChapterFilter(ranked, 'q', messages, provider)).toHaveLength(MAX_CONFIRMED_CHAPTERS);
    });

    it('an error fails open too', async () => {
        mockLlmCall.mockRejectedValue(new Error('timeout'));
        expect(await batchChapterFilter(ranked, 'q', messages, provider)).toHaveLength(MAX_CONFIRMED_CHAPTERS);
    });

    it('no utility AI: top by rank, no call', async () => {
        expect(ids(await batchChapterFilter(ranked, 'q', messages, undefined))).toEqual(['CH01', 'CH02', 'CH03']);
        expect(mockLlmCall).not.toHaveBeenCalled();
    });
});

describe('batchChapterFilter abort plumbing (AUDIT F1)', () => {
    beforeEach(() => mockLlmCall.mockReset());

    it('makes no call when the signal is already aborted', async () => {
        expect(await batchChapterFilter(ranked, 'q', messages, provider, AbortSignal.abort())).toEqual([]);
        expect(mockLlmCall).not.toHaveBeenCalled();
    });

    it('passes an abort through to the call and returns nothing', async () => {
        const controller = new AbortController();
        mockLlmCall.mockImplementationOnce((...args: unknown[]) => new Promise((_, reject) => {
            const opts = args[2] as { signal: AbortSignal };
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
            controller.abort();
        }));
        expect(await batchChapterFilter(ranked, 'q', messages, provider, controller.signal)).toEqual([]);
        expect(mockLlmCall).toHaveBeenCalledTimes(1);
    });
});

describe('parseChapterPicks', () => {
    const cands = ['CH01', 'CH02', 'CH03A', 'CH04', 'CH05'];
    it('reads JSON, prose and split ids; drops unknown ids and repeats; caps at the max', () => {
        expect(parseChapterPicks('["ch02","CH09","CH02"]', cands)).toEqual(['CH02']);
        expect(parseChapterPicks('CH03A and CH01', cands)).toEqual(['CH03A', 'CH01']);
        expect(parseChapterPicks('["CH01","CH02","CH04","CH05"]', cands)).toHaveLength(MAX_CONFIRMED_CHAPTERS);
    });
    it('"none" or [] is an empty pick; anything else unreadable is null', () => {
        expect(parseChapterPicks('[]', cands)).toEqual([]);
        expect(parseChapterPicks('None of these.', cands)).toEqual([]);
        expect(parseChapterPicks('', cands)).toBeNull();
        expect(parseChapterPicks('["CH99"]', cands)).toBeNull();
    });
});

describe('fuseChapterHits', () => {
    const chs = [makeChapter('CH01', '001', '010'), makeChapter('CH02', '011', '020'), makeChapter('CH03', '021', '030'), makeChapter('CH04', '031', '040')];
    it('a chapter the vectors point at moves up; nothing is dropped', () => {
        const out = ids(fuseChapterHits(chs, [{ id: '035', score: 0.8 }]));
        expect(out[0]).toBe('CH04');
        expect(out).toHaveLength(4);
    });
    it('no hits leaves the order alone', () => {
        expect(ids(fuseChapterHits(chs, []))).toEqual(['CH01', 'CH02', 'CH03', 'CH04']);
        expect(ids(fuseChapterHits(chs, undefined))).toEqual(['CH01', 'CH02', 'CH03', 'CH04']);
    });
});
