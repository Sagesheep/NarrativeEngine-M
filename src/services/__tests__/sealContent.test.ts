import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveChapter } from '../../types';

// AUDIT F3 — chapter seal must work from full verbatim scene content (user + GM),
// not the 120-char index userSnippet. This pins that runCombinedSeal fetches
// real scenes via api.archive.getScenes and feeds their content to the seal LLM.

const getIndex = vi.fn();
const getScenes = vi.fn();
vi.mock('../apiClient', () => ({
    api: { archive: { getIndex: (...a: unknown[]) => getIndex(...a), getScenes: (...a: unknown[]) => getScenes(...a) } },
}));

const sealChapterCombined = vi.fn();
vi.mock('../archive', () => ({
    shouldAutoSeal: vi.fn(),
    sealChapter: vi.fn(),
    sealChapterCombined: (...a: unknown[]) => sealChapterCombined(...a),
    rateImportance: vi.fn(),
}));

import { runCombinedSeal } from '../turn/turnPostProcess';

const chapter: ArchiveChapter = {
    chapterId: 'CH01', title: 'The Dragon', sceneRange: ['001', '002'], sceneIds: ['001', '002'],
    summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 2,
};
const provider = { id: 'u', endpoint: 'http://x', modelName: 'm', apiKey: '' } as never;

describe('runCombinedSeal scene content (AUDIT F3)', () => {
    beforeEach(() => {
        getIndex.mockReset();
        getScenes.mockReset();
        sealChapterCombined.mockReset();
        sealChapterCombined.mockResolvedValue({ summary: null, divergences: [] });
    });

    it('feeds full GM scene content to the seal, not the index snippet', async () => {
        getIndex.mockResolvedValue([
            { sceneId: '001', userSnippet: 'I approach the cave' },
            { sceneId: '002', userSnippet: 'I draw my sword' },
        ]);
        getScenes.mockResolvedValue([
            { sceneId: '001', content: '[USER] I approach the cave\n[GM] The ancient wyrm Volkar stirs.' },
            { sceneId: '002', content: '[USER] I draw my sword\n[GM] Volkar is slain in a burst of fire.' },
        ]);

        await runCombinedSeal('camp1', chapter, provider, []);

        expect(getScenes).toHaveBeenCalledWith('camp1', ['001', '002']);
        const scenesContent = sealChapterCombined.mock.calls[0][1] as { sceneId: string; content: string }[];
        const joined = scenesContent.map(s => s.content).join('\n');
        expect(joined).toContain('Volkar is slain'); // GM narration reached the seal
        expect(joined).not.toContain('I draw my sword\n[END'); // not the bare snippet
    });

    it('falls back to the snippet for a scene the store cannot return', async () => {
        getIndex.mockResolvedValue([{ sceneId: '001', userSnippet: 'snippet only' }]);
        getScenes.mockResolvedValue([]); // store returns nothing

        await runCombinedSeal('camp1', chapter, provider, []);

        const scenesContent = sealChapterCombined.mock.calls[0][1] as { sceneId: string; content: string }[];
        expect(scenesContent[0].content).toBe('snippet only');
    });
});
