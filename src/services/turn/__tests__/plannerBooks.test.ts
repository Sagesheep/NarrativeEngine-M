import { describe, it, expect, vi } from 'vitest';
import { runPlannerCall, buildPlannerBookList } from '../stages/plannerStage';
import type { UtilityLLM } from '../turnTypes';
import type { ArchiveBook } from '../../../types';

function book(id: string, from: string, to: string, over: Partial<ArchiveBook> = {}): ArchiveBook {
    return {
        bookId: id, title: `Book ${id}`, sceneRange: [from, to], summary: '', keywords: [], npcs: [],
        majorEvents: [], unresolvedThreads: [], createdAt: 0, ...over,
    };
}

const books = [
    book('BK01', '001', '120', { title: 'The Ashen Road', era: 'Year of Frost', npcs: ['Kael', 'Mirel'], keywords: ['old fort'] }),
    book('BK02', '121', '240', { title: 'Salt and Iron' }),
];

describe('planner book picks', () => {
    it('lists each book on one line with what tells it apart', () => {
        const list = buildPlannerBookList(books).split('\n');
        expect(list[0]).toBe('BK01 "The Ashen Road" [Year of Frost] scenes 001-120 — Kael, Mirel, old fort');
        expect(list[1]).toBe('BK02 "Salt and Iron" scenes 121-240');
    });

    it('sends the book list and keeps only real book ids, at most 2', async () => {
        const call = vi.fn().mockResolvedValue('{"filters":{},"books":["bk02","BK09","CH03","BK01","BK02"]}');
        const llm: UtilityLLM = { call, endpoint: () => undefined };

        const out = await runPlannerCall('back at the old fort', [], [], undefined, llm, 10, books);

        expect(out?.books).toEqual(['BK02', 'BK01']);
        expect(call.mock.calls[0][0]).toContain('BOOK LIST');
        expect(call.mock.calls[0][0]).toContain('BK01 "The Ashen Road"');
    });

    it('no books field (or no books) means no picks', async () => {
        const llm: UtilityLLM = { call: vi.fn().mockResolvedValue('{"filters":{}}'), endpoint: () => undefined };
        expect((await runPlannerCall('hi', [], [], undefined, llm, 10, books))?.books).toEqual([]);
        expect((await runPlannerCall('hi', [], [], undefined, llm, 10))?.books).toEqual([]);
    });
});
