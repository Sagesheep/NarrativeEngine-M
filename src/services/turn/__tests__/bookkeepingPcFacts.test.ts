import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, NPCEntry } from '../../../types';
import type { TurnCallbacks, TurnState } from '../turnTypes';

const h = vi.hoisted(() => ({
    scan: vi.fn(),
    scanInventory: vi.fn(),
    tasks: [] as Promise<unknown>[],
}));

vi.mock('../../campaign-state', () => ({
    scanCharacterProfileWithPcState: h.scan,
    scanInventory: h.scanInventory,
}));
vi.mock('../../infrastructure', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../infrastructure')>()),
    backgroundQueue: {
        push: (_label: string, fn: () => Promise<unknown>) => {
            const p = fn();
            h.tasks.push(p.catch(() => {}));
            return p;
        },
    },
}));

import { runBookkeepingScans } from '../postTurn/bookkeepingStage';

const APPEARANCE = 'Lean teenage boy, shaggy dark blue hair falling over one eye, grey eyes, school uniform';
const pc: NPCEntry = {
    id: 'pc1', name: 'Makoto', isPC: true, aliases: '', appearance: APPEARANCE, faction: '', storyRelevance: '',
    disposition: '', status: 'Alive', goals: '', voice: '', personality: 'calm', exampleOutput: '', affinity: 50,
    signatureKit: { equipment: ['Evoker yet to be issued'], abilities: ['Orpheus'] },
} as NPCEntry;
const npc: NPCEntry = { ...pc, id: 'n2', name: 'Junpei', isPC: false };

const SHORT = APPEARANCE.replace('shaggy dark blue hair falling over one eye', 'short-cropped dark blue hair');
const haircutUpdate = {
    appearance: { changed: true, basis: 'completed_change', evidence: 'I get my hair cut short', value: SHORT },
};

function setup(opts: { counter?: number; messages?: ChatMessage[]; live?: NPCEntry; tier?: string } = {}) {
    let counter = opts.counter ?? 0;
    const state = {
        settings: { aiTier: opts.tier ?? 'pro' },
        context: { characterProfileActive: true, characterProfile: { identity: {}, activeTraits: [] }, inventory: '' },
        npcLedger: [npc, pc],
        autoBookkeepingInterval: 5,
        incrementBookkeepingTurnCounter: () => ++counter,
        resetBookkeepingTurnCounter: vi.fn(() => { counter = 0; }),
        getMessages: () => opts.messages ?? [
            { id: 'u', role: 'user', content: 'I get my hair cut short.' },
            { id: 'a', role: 'assistant', content: 'SWIPE ONE: the barber refuses.' },
        ],
        getFreshSummarizerProvider: () => ({ endpoint: 'http://summarizer', modelName: 'deepseek' }),
        getFreshProvider: () => ({ endpoint: 'http://story', modelName: 'gemini' }),
    } as unknown as TurnState;
    const callbacks = {
        updateContext: vi.fn(),
        updateNPC: vi.fn(),
        getNpc: (id: string) => (id === 'pc1' ? (opts.live ?? pc) : npc),
    } as unknown as TurnCallbacks;
    return { state, callbacks };
}

const run = async (s: ReturnType<typeof setup>, committed: string, input = 'I get my hair cut short.') => {
    runBookkeepingScans(s.state, s.callbacks, '012', committed, input, s.state.npcLedger);
    await Promise.all(h.tasks);
};

beforeEach(() => {
    h.scan.mockReset();
    h.scanInventory.mockReset().mockResolvedValue('');
    h.tasks.length = 0;
});

describe('PC fact maintenance on commit', () => {
    it('scans the committed swipe (not swipe 1) with the summarizer and persists the appearance', async () => {
        h.scan.mockResolvedValue({ profile: { identity: {}, activeTraits: [] }, pcStateUpdate: haircutUpdate });
        const s = setup();
        await run(s, 'SWIPE THREE: the barber crops it short.');

        const [provider, messages, , pcSection] = h.scan.mock.calls[0];
        expect(provider.modelName).toBe('deepseek');
        expect(messages.map((m: ChatMessage) => m.content)).toEqual(['I get my hair cut short.', 'SWIPE THREE: the barber crops it short.']);
        expect(pcSection).toContain(APPEARANCE);
        expect(s.callbacks.updateNPC).toHaveBeenCalledWith('pc1', { appearance: SHORT });
    });

    it('a change cue runs the scan before the bookkeeping interval; no cue, no scan', async () => {
        h.scan.mockResolvedValue({ profile: { identity: {}, activeTraits: [] }, pcStateUpdate: undefined });
        const s = setup({ counter: 0 });
        await run(s, 'You chat about exams.', 'Hi Yukari.');
        expect(h.scan).not.toHaveBeenCalled();

        await run(s, 'The barber crops it short.');
        expect(h.scan).toHaveBeenCalledTimes(1);
        expect(h.scanInventory).not.toHaveBeenCalled();          // inventory keeps its interval
        expect(s.state.resetBookkeepingTurnCounter).not.toHaveBeenCalled();
    });

    it('tiers: pro applies PC facts only, max also saves the profile, lite runs nothing', async () => {
        h.scan.mockResolvedValue({ profile: { identity: { name: 'Makoto' }, activeTraits: [] }, pcStateUpdate: haircutUpdate });
        const pro = setup({ tier: 'pro' });
        await run(pro, 'The barber crops it short.');
        expect(pro.callbacks.updateContext).not.toHaveBeenCalled();
        expect(pro.callbacks.updateNPC).toHaveBeenCalledWith('pc1', { appearance: SHORT });

        const max = setup({ tier: 'max' });
        await run(max, 'The barber crops it short.');
        expect(max.callbacks.updateContext).toHaveBeenCalledWith(expect.objectContaining({ characterProfileLastScene: '012' }));
        expect(max.callbacks.updateNPC).toHaveBeenCalledWith('pc1', { appearance: SHORT });

        h.scan.mockClear();
        const lite = setup({ tier: 'lite', counter: 4 });
        await run(lite, 'The barber crops it short.');
        expect(h.scan).not.toHaveBeenCalled();
    });

    it('a failed scan leaves the saved record untouched', async () => {
        h.scan.mockRejectedValue(new Error('timeout'));
        const s = setup();
        await run(s, 'The barber crops it short.');
        expect(s.callbacks.updateNPC).not.toHaveBeenCalled();
    });

    it("a player's edit made while the scan ran wins over the scan", async () => {
        h.scan.mockResolvedValue({ profile: { identity: {}, activeTraits: [] }, pcStateUpdate: haircutUpdate });
        const s = setup({ live: { ...pc, appearance: 'Player typed this themselves' } });
        await run(s, 'The barber crops it short.');
        expect(s.callbacks.updateNPC).not.toHaveBeenCalled();
    });

    it('never touches non-PC NPCs or agency fields', async () => {
        h.scan.mockResolvedValue({
            profile: { identity: {}, activeTraits: [] },
            pcStateUpdate: { ...haircutUpdate, goals: { changed: true, basis: 'completed_change', evidence: 'I get my hair cut short', value: 'x' } },
        });
        const s = setup();
        await run(s, 'The barber crops it short.');
        expect(s.callbacks.updateNPC).toHaveBeenCalledTimes(1);
        expect(s.callbacks.updateNPC).toHaveBeenCalledWith('pc1', { appearance: SHORT });
    });
});
