import { describe, it, expect, vi } from 'vitest';

const chaptersUpdate = vi.fn(async () => {});
vi.mock('../../apiClient', () => ({
    api: {
        chapters: { update: (...a: unknown[]) => chaptersUpdate(...(a as [])) },
        archive: { getIndex: async () => [] },
    },
}));

import { applySealResult } from '../postTurn/sealStage';
import { EMPTY_REGISTER } from '../../campaign-state';
import type { ArchiveChapter, DivergenceEntry, DivergenceRegister } from '../../../types';

const chapter: ArchiveChapter = {
    chapterId: 'CH02', title: 'Two', sceneRange: ['026', '050'], sceneIds: ['026', '050'],
    summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 25, sealedAt: 1,
};
const fact = (id: string, over: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id, chapterId: 'CH02', category: 'world_state', text: id, sceneRef: '040', npcIds: [], pinned: false, source: 'auto', ...over,
});
const summary = { title: 'T', summary: 'S', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [] };

describe('applySealResult', () => {
    it('merges into the register as it is at merge time, not a pre-call snapshot', async () => {
        let live: DivergenceRegister = { ...EMPTY_REGISTER, entries: [] };
        // Written while the seal AI call was running (arc tick, Knowledge-tab edit).
        live = { ...live, entries: [fact('arc', { chapterId: 'arc:a1' }), fact('mine', { chapterId: 'CH01', source: 'manual' })] };
        const setRegister = vi.fn((r: DivergenceRegister) => { live = r; });

        const merged = await applySealResult('c', chapter, { summary, divergences: [fact('sealed')] }, {
            npcLedger: [], getRegister: () => live, setRegister, setArchiveIndex: vi.fn(),
        });

        expect(merged).toBe(1);
        expect(live.entries.map(e => e.id)).toEqual(['arc', 'mine', 'sealed']);
    });

    it('flags the chapter for Regenerate when the summary is missing', async () => {
        chaptersUpdate.mockClear();
        await applySealResult('c', chapter, { summary: null, divergences: [] }, {
            npcLedger: [], getRegister: () => undefined, setArchiveIndex: vi.fn(),
        });
        expect(chaptersUpdate).toHaveBeenCalledWith('c', 'CH02', { invalidated: true });
    });
});
