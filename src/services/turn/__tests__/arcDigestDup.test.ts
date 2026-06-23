import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, TurnCallbacks } from '../turnTypes';
import type { ArcRecord, ArcStage, GameContext, AppSettings, LLMProvider } from '../../../types';

// B1 — arcDigest was concatenating onto the prior digest each tick, so stale rung
// lines piled up. The fix rebuilds fresh from THIS tick's surface lines (with a
// Set dedupe safety net). These tests drive runArcTick twice on the same arc/rung
// and assert the digest stays single-line.

const h = vi.hoisted(() => ({
    rollArcTick: vi.fn(),
    rollArcOutcome: vi.fn(),
    advanceRung: vi.fn(),
    arcSurfaceLine: vi.fn(),
    scanArcStance: vi.fn(),
}));

vi.mock('../../arc', () => ({
    rollArcTick: h.rollArcTick,
    rollArcOutcome: h.rollArcOutcome,
    advanceRung: h.advanceRung,
    arcSurfaceLine: h.arcSurfaceLine,
    scanArcStance: h.scanArcStance,
}));

import { runArcTick } from '../turnPostProcess';

const provider: LLMProvider = { id: 'u', endpoint: 'http://x', modelName: 'm', apiKey: '' } as never;

function makeArc(over: Partial<ArcRecord> = {}): ArcRecord {
    return {
        id: 'arc-1',
        type: 'world' as ArcRecord['type'],
        title: 'Test arc',
        seed: 'the ore remembers',
        ladder: [
            { surface: 'ambient', label: 'rung 0 — the ore remembers' } as ArcStage,
            { surface: 'direct', label: 'rung 1 — crisis' } as ArcStage,
        ],
        currentRung: 0,
        tickDC: 5,
        stance: 'unaware',
        status: 'active',
        bornScene: '001',
        lastTickScene: '001',
        ...over,
    } as ArcRecord;
}

function makeState(arcDigest: string, arcs: ArcRecord[]): TurnState {
    return {
        input: '',
        displayInput: '',
        settings: { aiTier: 'pro', contextLimit: 8192, rulesBudgetPct: 0.10, utilityTimeoutSeconds: 45 } as AppSettings,
        context: { arcDigest, arcs } as unknown as GameContext,
        messages: [],
        condenser: { condensedUpToIndex: 0 },
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [{ sceneId: '010', userSnippet: 's', keywords: [], npcsMentioned: [], npcsWitnessed: [], events: [], timestamp: 0 }],
        semanticFacts: [],
        chapters: [],
        activeCampaignId: 'camp1',
        provider,
        getMessages: () => [],
        getFreshProvider: () => provider,
        incrementBookkeepingTurnCounter: () => 1,
        autoBookkeepingInterval: 5,
        resetBookkeepingTurnCounter: () => {},
        timeline: [],
        pinnedChapterIds: [],
        clearPinnedChapters: vi.fn(),
    } as unknown as TurnState;
}

function makeCallbacks(): TurnCallbacks & { _digest: string } {
    const cb: any = { _digest: '' };
    cb.updateContext = vi.fn((patch: Partial<GameContext>) => {
        if (patch.arcDigest !== undefined) cb._digest = patch.arcDigest as string;
    });
    cb.setArchiveIndex = vi.fn();
    cb.setDivergenceRegister = vi.fn();
    return cb;
}

describe('B1 — arcDigest does not accumulate duplicate rung lines across ticks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Tempo always fires so a surface line is produced each tick.
        h.rollArcTick.mockReturnValue({ fired: true, nextDc: 5 });
        // Outcome stays neutral so the rung never advances — same rung both ticks.
        h.rollArcOutcome.mockReturnValue({ band: 'neutral' as const });
        h.advanceRung.mockImplementation((arc: ArcRecord) => arc); // no rung change
        // Stance scan returns nothing (keeps prior 'unaware').
        h.scanArcStance.mockReturnValue([]);
        // Surface line is deterministic for the fixed rung.
        h.arcSurfaceLine.mockReturnValue('[WORLD/ambient] rung 0 — the ore remembers');
    });

    it('two consecutive ticks on the same arc/rung produce a single digest line, not two', () => {
        const arc = makeArc();
        const state1 = makeState('', [arc]);
        const cb1 = makeCallbacks();
        runArcTick(state1, cb1, '', '');
        const firstDigest = cb1._digest;
        expect(firstDigest.split('\n').length).toBe(1);

        // Second tick: prior digest is now what the first tick wrote. Pre-fix, the
        // fold would concat and double the line. Post-fix, it rebuilds fresh.
        const state2 = makeState(firstDigest, [arc]);
        const cb2 = makeCallbacks();
        runArcTick(state2, cb2, '', '');
        expect(cb2._digest.split('\n').length).toBe(1);
        expect(cb2._digest).toBe('[WORLD/ambient] rung 0 — the ore remembers');
    });

    it('does not carry over stale lines from the prior digest', () => {
        const arc = makeArc();
        // Simulate a prior digest polluted with three copies of the rung line (the bug).
        const polluted = '[WORLD/ambient] rung 0 — the ore remembers\n'
            + '[WORLD/ambient] rung 0 — the ore remembers\n'
            + '[WORLD/ambient] rung 0 — the ore remembers';
        const state = makeState(polluted, [arc]);
        const cb = makeCallbacks();
        runArcTick(state, cb, '', '');
        expect(cb._digest.split('\n').length).toBe(1);
        expect(cb._digest).toBe('[WORLD/ambient] rung 0 — the ore remembers');
    });
});