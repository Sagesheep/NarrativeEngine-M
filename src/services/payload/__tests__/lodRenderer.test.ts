import { describe, it, expect } from 'vitest';
import { renderLodChapters, buildChapterRecapBlock } from '../lodRenderer';
import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage } from '../../../types';

const pad = (n: number) => String(n).padStart(3, '0');

function chapter(id: string, from: number, to: number, over: Partial<ArchiveChapter> = {}): ArchiveChapter {
    const sceneIds = Array.from({ length: to - from + 1 }, (_, i) => pad(from + i));
    return {
        chapterId: id, title: `Title ${id}`, sceneRange: [pad(from), pad(to)], sceneIds,
        summary: `First sentence of ${id}. More detail about ${id}.`,
        keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [],
        sceneCount: sceneIds.length, sealedAt: 1, ...over,
    };
}

/** user + assistant + scene-marker per scene, the shape mobile's chat log has. */
function transcript(scenes: number): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let n = 1; n <= scenes; n++) {
        out.push({ id: `u${n}`, role: 'user', content: `player ${n}`, timestamp: 0 });
        out.push({ id: `a${n}`, role: 'assistant', content: `gm ${n}`, timestamp: 0 });
        out.push({ id: `m${n}`, role: 'system', name: 'scene-marker', content: `Scene ${pad(n)}`, timestamp: 0 });
    }
    return out;
}
/** Index of scene n's marker: everything up to and including scene n is condensed. */
const boundaryAfterScene = (n: number) => n * 3 - 1;

const four = [chapter('CH01', 1, 3), chapter('CH02', 4, 6), chapter('CH03', 7, 9), chapter('CH04', 10, 12)];
const msgs = transcript(14);
const big = 100000;

describe('renderLodChapters', () => {
    it('newest chapters render as summary, older as a one-line synopsis', () => {
        const r = renderLodChapters({
            chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(12),
            budgetTokens: big, config: { summaryChapters: 2, importanceBonus: 0 },
        });
        expect(r.tierByChapterId).toEqual({ CH01: 'synopsis', CH02: 'synopsis', CH03: 'summary', CH04: 'summary' });
        expect(r.text).toContain('Chapter CH01 — Title CH01\nFirst sentence of CH01.');
        expect(r.text).not.toContain('More detail about CH01');
        expect(r.text).toContain('More detail about CH04');
        expect(r.text.indexOf('CH01')).toBeLessThan(r.text.indexOf('CH04'));
    });

    it('a high-importance scene keeps an older chapter at summary tier', () => {
        const archiveIndex = [{ sceneId: '002', timestamp: 0, keywords: [], npcsMentioned: [], userSnippet: '', importance: 9 }] as ArchiveIndexEntry[];
        const r = renderLodChapters({
            chapters: four, archiveIndex, messages: msgs, condensedUpToIndex: boundaryAfterScene(12),
            budgetTokens: big, config: { summaryChapters: 2, importanceBonus: 3 },
        });
        expect(r.tierByChapterId.CH01).toBe('summary');
    });

    it('a chapter straddling the boundary is included; one wholly after it is not', () => {
        const r = renderLodChapters({ chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(7), budgetTokens: big });
        expect(Object.keys(r.tierByChapterId)).toEqual(['CH01', 'CH02', 'CH03']);
    });

    it('renders nothing when nothing is condensed, or for unsealed/invalidated chapters', () => {
        expect(renderLodChapters({ chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: -1, budgetTokens: big }).text).toBe('');
        const r = renderLodChapters({
            chapters: [chapter('CH01', 1, 3, { sealedAt: undefined }), chapter('CH02', 4, 6, { invalidated: true }), chapter('CH03', 7, 9)],
            archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(12), budgetTokens: big,
        });
        expect(Object.keys(r.tierByChapterId)).toEqual(['CH03']);
    });

    it('refuses to guess with no scene markers at all', () => {
        const bare = msgs.filter(m => m.name !== 'scene-marker');
        expect(renderLodChapters({ chapters: four, archiveIndex: [], messages: bare, condensedUpToIndex: 20, budgetTokens: big }).text).toBe('');
    });

    it('over budget: demotes oldest summaries first, then drops oldest synopses', () => {
        const full = renderLodChapters({ chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(12), budgetTokens: big });
        const tight = renderLodChapters({ chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(12), budgetTokens: Math.floor(full.tokens * 0.8) });
        expect(tight.tierByChapterId.CH01).toBe('synopsis');
        expect(tight.tierByChapterId.CH04).toBe('summary');
        const tiny = renderLodChapters({ chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(12), budgetTokens: 20 });
        expect(tiny.tierByChapterId.CH01).toBe('dropped');
        expect(tiny.tokens).toBeLessThanOrEqual(20);
    });

    it('is deterministic for identical input', () => {
        const input = { chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(12), budgetTokens: big };
        expect(renderLodChapters(input).text).toBe(renderLodChapters({ ...input, chapters: [...four].reverse() }).text);
    });
});

describe('buildChapterRecapBlock', () => {
    it('wraps the recap in its envelope and stays within half the history budget', () => {
        const block = buildChapterRecapBlock({ chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: boundaryAfterScene(12), historyBudget: 4000 });
        expect(block.content.startsWith('[LOD HISTORY — CONDENSED CHAPTERS]\n')).toBe(true);
        expect(block.content.endsWith('\n[END LOD HISTORY]')).toBe(true);
        expect(block.tokens).toBeLessThanOrEqual(2000);
    });

    it('is empty with no chapters or nothing condensed', () => {
        expect(buildChapterRecapBlock({ chapters: [], archiveIndex: [], messages: msgs, condensedUpToIndex: 30, historyBudget: 4000 }).content).toBe('');
        expect(buildChapterRecapBlock({ chapters: four, archiveIndex: [], messages: msgs, condensedUpToIndex: -1, historyBudget: 4000 }).content).toBe('');
    });
});
