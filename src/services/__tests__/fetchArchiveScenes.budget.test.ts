import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for value-aware budget packing in fetchArchiveScenes.
 *
 * The key invariant: inclusion order follows RANK (the order of sceneIds),
 * not chronological scene number. Output is still sorted chronologically.
 *
 * We mock the storage layer and countTokens so tests are deterministic
 * and require no real embedder or DB.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../storage', () => ({
    offlineStorage: {
        archive: {
            getScenes: vi.fn(),
        },
    },
}));

vi.mock('../infrastructure', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../infrastructure')>();
    return {
        ...actual,
        countTokens: (text: string) => text.length, // 1 char = 1 token for simplicity
    };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeScene(sceneId: string, chars: number) {
    return { sceneId, content: 'x'.repeat(chars), tokens: chars };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('fetchArchiveScenes — value-aware budget packing', () => {
    let getScenesMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        const { offlineStorage } = await import('../storage');
        getScenesMock = offlineStorage.archive.getScenes as ReturnType<typeof vi.fn>;
        getScenesMock.mockReset();
    });

    it('includes all scenes when they fit within budget', async () => {
        // scenes 001, 002, 003 — total 90 tokens, budget 100
        getScenesMock.mockResolvedValue([
            makeScene('001', 30),
            makeScene('002', 30),
            makeScene('003', 30),
        ]);

        const { fetchArchiveScenes } = await import('../archive');
        const result = await fetchArchiveScenes('campaign-1', ['001', '002', '003'], 100);

        expect(result.map(s => s.sceneId)).toEqual(['001', '002', '003']);
    });

    it('drops the LOWEST-RANKED scene when budget is tight, not the latest sceneId', async () => {
        // Rank order (by relevance): 003, 001, 002
        // sceneIds passed in that order → 003 is highest rank, 002 is lowest
        // Budget = 65, each scene = 30 tokens → room for exactly 2
        // Naive chronological fill would include 001 + 002 (drop 003).
        // Value-aware fill includes 003 + 001 (drop 002, the lowest-ranked).
        getScenesMock.mockResolvedValue([
            makeScene('001', 30),
            makeScene('002', 30),
            makeScene('003', 30),
        ]);

        const { fetchArchiveScenes } = await import('../archive');
        const rankOrder = ['003', '001', '002']; // highest→lowest relevance
        const result = await fetchArchiveScenes('campaign-1', rankOrder, 65);

        const ids = result.map(s => s.sceneId);
        expect(ids).toContain('003'); // highest rank — must be included
        expect(ids).toContain('001'); // second rank — fits
        expect(ids).not.toContain('002'); // lowest rank — dropped
    });

    it('output is sorted chronologically regardless of rank order', async () => {
        // Rank order: 005, 002, 008 — output should be 002, 005, 008
        getScenesMock.mockResolvedValue([
            makeScene('005', 20),
            makeScene('002', 20),
            makeScene('008', 20),
        ]);

        const { fetchArchiveScenes } = await import('../archive');
        const result = await fetchArchiveScenes('campaign-1', ['005', '002', '008'], 200);

        expect(result.map(s => s.sceneId)).toEqual(['002', '005', '008']);
    });

    it('truncates the highest-ranked scene that overflows if meaningful space remains', async () => {
        // Budget = 45. Scene '001' costs 30 (fits). Scene '002' costs 30 (overflows, 15 remaining).
        // 15 < 150 threshold → '002' is dropped, not truncated.
        getScenesMock.mockResolvedValue([
            makeScene('001', 30),
            makeScene('002', 30),
        ]);

        const { fetchArchiveScenes } = await import('../archive');
        const result = await fetchArchiveScenes('campaign-1', ['001', '002'], 45);

        expect(result.map(s => s.sceneId)).toEqual(['001']);
        expect(result[0].content).toBe('x'.repeat(30)); // not truncated
    });

    it('truncates when remaining > 150 chars after first scene', async () => {
        // Budget = 250. Scene '001' costs 50 (fits). Scene '002' costs 300 (overflows, 200 remaining > 150).
        // '002' should be truncated to 200 chars.
        getScenesMock.mockResolvedValue([
            makeScene('001', 50),
            makeScene('002', 300),
        ]);

        const { fetchArchiveScenes } = await import('../archive');
        const result = await fetchArchiveScenes('campaign-1', ['001', '002'], 250);

        expect(result.map(s => s.sceneId)).toEqual(['001', '002']);
        expect(result[1].content).toContain('[...scene truncated for context budget...]');
        // truncated to remaining * 4 chars (200 * 4 = 800) but content is only 300 chars,
        // so the truncation marker is what we check
        expect(result[1].content.length).toBeLessThan(300 + 50); // less than full + marker
    });

    it('skips scenes not returned by storage (missing ids)', async () => {
        // Storage only returns scenes 001 and 003, not 002
        getScenesMock.mockResolvedValue([
            makeScene('001', 20),
            makeScene('003', 20),
        ]);

        const { fetchArchiveScenes } = await import('../archive');
        const result = await fetchArchiveScenes('campaign-1', ['001', '002', '003'], 200);

        expect(result.map(s => s.sceneId)).toEqual(['001', '003']);
    });

    it('respects excludeSceneIds', async () => {
        getScenesMock.mockResolvedValue([
            makeScene('001', 20),
            makeScene('002', 20),
            makeScene('003', 20),
        ]);

        const { fetchArchiveScenes } = await import('../archive');
        const result = await fetchArchiveScenes('campaign-1', ['001', '002', '003'], 200, new Set(['002']));

        expect(result.map(s => s.sceneId)).not.toContain('002');
        expect(result.map(s => s.sceneId)).toContain('001');
        expect(result.map(s => s.sceneId)).toContain('003');
    });

    it('returns empty array for empty sceneIds', async () => {
        const { fetchArchiveScenes } = await import('../archive');
        const result = await fetchArchiveScenes('campaign-1', [], 3000);
        expect(result).toEqual([]);
        expect(getScenesMock).not.toHaveBeenCalled();
    });
});
