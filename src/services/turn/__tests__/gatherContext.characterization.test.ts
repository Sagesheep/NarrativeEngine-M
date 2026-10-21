import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TurnState, TurnCallbacks, UtilityLLM } from '../turnTypes';
import type { ArchiveChapter, LLMProvider } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Plan 4.2 — Characterization tests for gatherContext.
//
// These pin the OBSERVABLE behavior of gatherContext (what it returns and what
// it feeds buildPayload) across the core retrieval scenarios, using the new
// UtilityLLM port with scripted responses instead of network mocking. They are
// the safety net for the stage-extraction refactor (4.3–4.6) and MUST NOT change
// in those steps — if a refactor changes them, the refactor changed behavior.
//
// Collaborators are mocked at the module-barrel boundary so the test exercises
// gatherContext's own sequencing/gating logic, not the retrieval internals.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
    buildPayload: vi.fn(),
    retrieveRelevantLore: vi.fn(),
    retrieveRelevantRules: vi.fn(),
    chunkLoreFile: vi.fn(),
    recallArchiveScenes: vi.fn(),
    retrieveArchiveMemory: vi.fn(),
    fetchArchiveScenes: vi.fn(),
    deepArchiveScanV2: vi.fn(),
    recallWithChapterFunnel: vi.fn(),
    recommendContext: vi.fn(),
    rerankCandidates: vi.fn(),
    queryFacts: vi.fn(),
    formatFactsForContext: vi.fn(),
    formatResolvedForContext: vi.fn(),
    getDivergenceSceneIds: vi.fn(),
    resolveTimeline: vi.fn(),
    semanticSearch: vi.fn(),
    semanticSearchScored: vi.fn(),
    isEmbedderReady: vi.fn(),
}));

vi.mock('../../chatEngine', () => ({ buildPayload: h.buildPayload }));
vi.mock('../../lore', () => ({
    retrieveRelevantLore: h.retrieveRelevantLore,
    retrieveRelevantRules: h.retrieveRelevantRules,
    chunkLoreFile: h.chunkLoreFile,
}));
vi.mock('../../archive', () => ({
    recallArchiveScenes: h.recallArchiveScenes,
    retrieveArchiveMemory: h.retrieveArchiveMemory,
    fetchArchiveScenes: h.fetchArchiveScenes,
    deepArchiveScanV2: h.deepArchiveScanV2,
    recallWithChapterFunnel: h.recallWithChapterFunnel,
}));
vi.mock('../../payload', () => ({ recommendContext: h.recommendContext, rerankCandidates: h.rerankCandidates }));
vi.mock('../../campaign-state', () => ({
    queryFacts: h.queryFacts,
    formatFactsForContext: h.formatFactsForContext,
    formatResolvedForContext: h.formatResolvedForContext,
    getDivergenceSceneIds: h.getDivergenceSceneIds,
    EMPTY_REGISTER: {},
    resolveTimeline: h.resolveTimeline,
}));
vi.mock('../../embedding', () => ({
    semanticSearch: h.semanticSearch,
    semanticSearchScored: h.semanticSearchScored,
    isEmbedderReady: h.isEmbedderReady,
}));
// The chapter funnel is off in every tier (desktop port, 2026-10). Tests 3–4
// still pin its code path, so they force it on through this switch.
const tierOverride = vi.hoisted(() => ({ forceFunnel: false }));
vi.mock('../aiTier', async (importOriginal) => {
    const real = await importOriginal<typeof import('../aiTier')>();
    return {
        ...real,
        tierAllows: (tier: Parameters<typeof real.tierAllows>[0], f: Parameters<typeof real.tierAllows>[1]) =>
            (f === 'archiveFunnel' && tierOverride.forceFunnel) || real.tierAllows(tier, f),
    };
});

import { gatherContext } from '../turnContext';

const provider: LLMProvider = { id: 'u', endpoint: 'http://x', modelName: 'm', apiKey: '' } as never;

function makeChapter(id: string, sealed = true): ArchiveChapter {
    return {
        chapterId: id,
        title: `Chapter ${id}`,
        sceneRange: ['001', '010'],
        sceneIds: ['001', '002'],
        summary: `Summary of ${id}`,
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 2,
        ...(sealed ? { sealedAt: Date.now() } : {}),
    } as ArchiveChapter;
}

function makeIndexEntry(sceneId: string) {
    return { sceneId, userSnippet: `snippet ${sceneId}`, keywords: [], npcsMentioned: [], npcsWitnessed: [], events: [], timestamp: 0 };
}

function makeState(over: Partial<TurnState> = {}): TurnState {
    return {
        input: '',
        displayInput: '',
        settings: { aiTier: 'pro', contextLimit: 8192, rulesBudgetPct: 0.10, utilityTimeoutSeconds: 45 },
        context: { rulesRaw: '' },
        messages: [],
        condenser: { condensedUpToIndex: 0 },
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [makeIndexEntry('010')],
        semanticFacts: [],
        chapters: [],
        activeCampaignId: 'camp1',
        provider,
        getMessages: () => [],
        getFreshProvider: () => provider,
        getUtilityEndpoint: () => provider,
        incrementBookkeepingTurnCounter: () => 1,
        autoBookkeepingInterval: 5,
        resetBookkeepingTurnCounter: () => {},
        timeline: [],
        pinnedChapterIds: [],
        clearPinnedChapters: vi.fn(),
        deepContextSearch: false,
        onStageNpcIds: [],
        pinnedExcerpts: [],
        ...over,
    } as unknown as TurnState;
}

function makePort(): UtilityLLM {
    return { call: vi.fn().mockResolvedValue('{}'), endpoint: vi.fn(() => provider) };
}

function makeCallbacks(): TurnCallbacks {
    return { setLoadingStatus: vi.fn() } as unknown as TurnCallbacks;
}

beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    tierOverride.forceFunnel = false;
    h.isEmbedderReady.mockReturnValue(true);
    h.semanticSearchScored.mockResolvedValue([{ id: '001', score: 0.9 }, { id: '002', score: 0.8 }]);
    h.semanticSearch.mockResolvedValue([]);
    h.retrieveRelevantLore.mockReturnValue([]);
    h.retrieveRelevantRules.mockReturnValue([]);
    h.recallArchiveScenes.mockResolvedValue([{ sceneId: '010', content: 'flat scene', tokens: 5 }]);
    h.retrieveArchiveMemory.mockReturnValue([]);
    h.fetchArchiveScenes.mockResolvedValue([]);
    h.deepArchiveScanV2.mockResolvedValue('');
    h.recallWithChapterFunnel.mockResolvedValue({ scenes: '', usedTokens: 0 });
    h.recommendContext.mockResolvedValue({ relevantNPCNames: [], relevantLoreIds: [] });
    h.rerankCandidates.mockResolvedValue([]);
    h.queryFacts.mockReturnValue([]);
    h.formatFactsForContext.mockReturnValue('');
    h.formatResolvedForContext.mockReturnValue('');
    h.getDivergenceSceneIds.mockReturnValue(new Set());
    h.resolveTimeline.mockReturnValue([]);
    h.buildPayload.mockReturnValue({ messages: [], _sentinel: true });
});

describe('gatherContext characterization', () => {
    it('1. no-embedder path: skips semantic search, recalls via flat archive', async () => {
        h.isEmbedderReady.mockReturnValue(false);
        const port = makePort();
        const result = await gatherContext(makeState({ chapters: [] }), makeCallbacks(), 'what happened at the gate yesterday', 'u1', port);

        expect(h.semanticSearchScored).not.toHaveBeenCalled();
        expect(result.semanticArchiveHits).toEqual([]);
        expect(h.recallArchiveScenes).toHaveBeenCalled();
        expect(result.archiveRecall).toEqual([{ sceneId: '010', content: 'flat scene', tokens: 5 }]);
        expect(result.payloadResult).toEqual({ messages: [], _sentinel: true });
    });

    it('2. tier-low (lite): all LLM stages gated off, pure semantic+flat path', async () => {
        const port = makePort();
        const result = await gatherContext(
            makeState({ settings: { aiTier: 'lite', contextLimit: 8192, rulesBudgetPct: 0.10, utilityTimeoutSeconds: 45 } as never, chapters: [makeChapter('CH01')] }),
            makeCallbacks(), 'a reasonably long user message about the tavern brawl', 'u1', port,
        );

        // planner + expandQuery are the only port.call users; both gated off in lite.
        expect(port.call).not.toHaveBeenCalled();
        expect(h.recommendContext).not.toHaveBeenCalled();        // recommender gated
        expect(h.recallWithChapterFunnel).not.toHaveBeenCalled(); // archiveFunnel gated
        // semantic search is NOT tier-gated — runs whenever the embedder is ready.
        expect(h.semanticSearchScored).toHaveBeenCalled();
        expect(result.semanticArchiveHits.map(x => x.id)).toEqual(['001', '002']);
        expect(h.recallArchiveScenes).toHaveBeenCalled();
        expect(result.archiveRecall).toEqual([{ sceneId: '010', content: 'flat scene', tokens: 5 }]);
    });

    it('2b. pro with sealed chapters: funnel off by default, archive-wide flat recall', async () => {
        const port = makePort();
        const result = await gatherContext(makeState({ chapters: [makeChapter('CH01')] }), makeCallbacks(), 'tell me about the gate', 'u1', port);

        expect(h.recallWithChapterFunnel).not.toHaveBeenCalled();
        expect(h.recallArchiveScenes).toHaveBeenCalled();
        expect(result.archiveRecall).toEqual([{ sceneId: '010', content: 'flat scene', tokens: 5 }]);
    });

    it('3. funnel path: parses funnel scene string, skips flat recall', async () => {
        tierOverride.forceFunnel = true;
        h.recallWithChapterFunnel.mockResolvedValue({ scenes: '\n--- SCENE 001 ---\nThe gate fell.', usedTokens: 12 });
        const port = makePort();
        const result = await gatherContext(makeState({ chapters: [makeChapter('CH01')] }), makeCallbacks(), 'tell me about the gate', 'u1', port);

        expect(h.recallWithChapterFunnel).toHaveBeenCalled();
        expect(h.recallArchiveScenes).not.toHaveBeenCalled();
        expect(result.archiveRecall).toEqual([{ sceneId: '001', content: 'The gate fell.', tokens: expect.any(Number) }]);
    });

    it('4. funnel-timeout fallback: aborts funnel, falls back to flat recall (AUDIT F1)', async () => {
        vi.useFakeTimers();
        tierOverride.forceFunnel = true;
        try {
            h.recallWithChapterFunnel.mockReturnValue(new Promise<never>(() => {})); // never resolves
            const port = makePort();
            const p = gatherContext(makeState({ chapters: [makeChapter('CH01')] }), makeCallbacks(), 'tell me about the gate', 'u1', port);
            await vi.advanceTimersByTimeAsync(5100); // past FUNNEL_RACE_TIMEOUT_MS (5000)
            const result = await p;

            expect(h.recallWithChapterFunnel).toHaveBeenCalled();
            expect(h.recallArchiveScenes).toHaveBeenCalled(); // fallback fired
            expect(result.archiveRecall).toEqual([{ sceneId: '010', content: 'flat scene', tokens: 5 }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('5. pinned chapters: injects scored pinned scenes and clears the pin set', async () => {
        h.retrieveArchiveMemory.mockReturnValue(['005']);
        h.fetchArchiveScenes.mockResolvedValue([{ sceneId: '005', content: 'pinned scene', tokens: 5 }]);
        const ch01 = makeChapter('CH01');
        const state = makeState({ chapters: [ch01], pinnedChapterIds: ['CH01'] });
        const port = makePort();

        const result = await gatherContext(state, makeCallbacks(), 'tell me about the gate', 'u1', port);

        expect(h.fetchArchiveScenes).toHaveBeenCalled();
        const fetchArgs = h.fetchArchiveScenes.mock.calls[0];
        expect(fetchArgs[0]).toBe('camp1');
        expect(fetchArgs[1]).toEqual(['005']);
        expect(state.clearPinnedChapters).toHaveBeenCalled();
        expect(result.archiveRecall?.some(s => s.sceneId === '005')).toBe(true);
    });

    it('6. recommender injection: surfaces NPC names and injects missed lore chunks', async () => {
        const loreChunks = [
            { id: 'lore_1', header: 'L1', content: 'a', summary: '', tokens: 40 },
            { id: 'lore_2', header: 'L2', content: 'b', summary: '', tokens: 50 },
        ];
        h.retrieveRelevantLore.mockReturnValue([loreChunks[0]]);
        h.recommendContext.mockResolvedValue({ relevantNPCNames: ['Astarion'], relevantLoreIds: ['lore_2'] });
        const port = makePort();

        const result = await gatherContext(makeState({ chapters: [], loreChunks: loreChunks as never }), makeCallbacks(), 'who is around', 'u1', port);

        expect(h.recommendContext).toHaveBeenCalled();
        expect(result.recommendedNPCNames).toEqual(['Astarion']);
        // lore_2 was missed by retrieval but recommended → injected into relevantLore.
        expect(result.relevantLore?.map(c => c.id)).toContain('lore_2');
    });

    it('6b. recommender detail levels reach the payload; a failed call leaves them undefined (all full)', async () => {
        h.recommendContext.mockResolvedValue({ relevantNPCNames: ['Astarion'], relevantLoreIds: [], npcDetail: { n1: 'brief' } });
        const loreChunks = [{ id: 'lore_1', header: 'L1', content: 'a', summary: '', tokens: 40 }] as never;
        await gatherContext(makeState({ onStageNpcIds: ['n1'], loreChunks } as never), makeCallbacks(), 'who is around', 'u1', makePort());
        expect(h.recommendContext.mock.calls[0][7]).toEqual(['n1']);
        expect(h.buildPayload.mock.calls.at(-1)![0].recommendedNPCDetail).toEqual({ n1: 'brief' });

        h.recommendContext.mockRejectedValue(new Error('timeout'));
        await gatherContext(makeState({ loreChunks }), makeCallbacks(), 'who is around', 'u1', makePort());
        expect(h.recommendContext).toHaveBeenCalledTimes(2);
        const opts = h.buildPayload.mock.calls.at(-1)![0];
        expect(opts.recommendedNPCDetail).toBeUndefined();
        expect(opts.recommendedNPCNames).toBeUndefined();
    });

    it('7. recommender starts alongside the memory search, not after it', async () => {
        let finishSearch!: (hits: unknown) => void;
        h.semanticSearchScored.mockReturnValue(new Promise(resolve => { finishSearch = resolve; }));
        const loreChunks = [{ id: 'lore_1', header: 'L1', content: 'a', summary: '', tokens: 40 }];
        const port = makePort();

        const p = gatherContext(makeState({ loreChunks: loreChunks as never }), makeCallbacks(), 'who is around', 'u1', port);
        await Promise.resolve();
        await Promise.resolve();
        // The search has not finished, and the recommender call is already out.
        expect(h.recommendContext).toHaveBeenCalled();
        expect(h.recallArchiveScenes).not.toHaveBeenCalled();

        finishSearch([{ id: '001', score: 0.9 }]);
        const result = await p;
        expect(result.archiveRecall).toEqual([{ sceneId: '010', content: 'flat scene', tokens: 5 }]);
    });

    it('8. recommender is skipped when there is nothing for it to pick', async () => {
        const port = makePort();
        await gatherContext(makeState({ npcLedger: [], loreChunks: [], pinnedChapterIds: [] }), makeCallbacks(), 'I wake up', 'u1', port);
        expect(h.recommendContext).not.toHaveBeenCalled();
    });

    it('9. a still-running Director call is awaited and its Brief reaches the payload', async () => {
        let finishDirector!: (brief: string | undefined) => void;
        const directorBrief = new Promise<string | undefined>(resolve => { finishDirector = resolve; });
        const port = makePort();

        const p = gatherContext(makeState(), makeCallbacks(), 'tell me about the gate', 'u1', port, { directorBrief });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(h.buildPayload).not.toHaveBeenCalled();

        finishDirector('WRITER BRIEF: keep the gate shut');
        await p;
        expect(h.buildPayload).toHaveBeenCalledWith(expect.objectContaining({ directorBrief: 'WRITER BRIEF: keep the gate shut' }));
    });
});

afterEach(() => {
    vi.useRealTimers();
});
