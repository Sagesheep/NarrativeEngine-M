/* eslint-disable @typescript-eslint/no-explicit-any */
// The story request carries no Scene Notebook tool, and a finished reply hands
// its text to the auxiliary notebook prefetch — once, and only on success.
// Lore and dice tool calls keep their loop. Uses the real tool definitions.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';

const prefetchMock = vi.fn();
vi.mock('../pendingCommit', () => ({
    capturePendingTurnSnapshot: vi.fn(),
    getActiveSnapshotId: vi.fn(() => 'snap'),
    prefetchNotebookForPendingVariant: (...a: unknown[]) => prefetchMock(...a),
}));
vi.mock('../directorBrief', () => ({ runDirectorBrief: vi.fn(async () => null), lastAssistantContent: vi.fn(() => '') }));
vi.mock('../directorWatchdog', () => ({ buildWatchdogDossier: vi.fn(() => ({ signals: [], dossierText: '' })) }));
vi.mock('../turnContext', () => ({
    gatherContext: vi.fn(async () => ({ semanticArchiveHits: [], payloadResult: { messages: [{ role: 'user', content: 'hello' }], trace: [] } })),
}));
const sendMessageMock = vi.fn();
const manualRollMock = vi.fn();
vi.mock('../../chatEngine', () => ({ sendMessage: (...a: unknown[]) => sendMessageMock(...a) }));
vi.mock('../../llm/payloadSanitizer', () => ({ sanitizePayloadForApi: (p: unknown) => p }));
vi.mock('../../ports/notify', () => ({ notify: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));
const loreSearchMock = vi.fn<(...args: unknown[]) => { header: string; content: string }[]>(
    () => [{ header: 'Gate', content: 'The gate is iron.' }],
);
vi.mock('../../lore', () => ({ searchLoreByQuery: (...a: unknown[]) => loreSearchMock(...a) }));
vi.mock('../../engine', () => ({
    rollEngines: vi.fn(() => ({ appendToInput: '', updatedDCs: {} })),
    rollDiceFairness: vi.fn(() => ''),
    rollCharacterIntroEngine: vi.fn(),
    resolveManualRoll: (...a: unknown[]) => manualRollMock(...a),
    resolveLootDrop: vi.fn(() => ({ appendToInput: '' })),
    mapTier: vi.fn(() => 'Success'),
}));
vi.mock('../../engine/lootDropTelemetry', () => ({ recordLootDrop: vi.fn() }));

import { runTurn } from '../turnOrchestrator';

function makeTurn() {
    const messages: any[] = [];
    const state = {
        input: 'I open the gate.',
        displayInput: 'I open the gate.',
        settings: { aiTier: 'lite', debugMode: false, presets: [], activePresetId: '' },
        context: { notebook: [], notebookActive: true, diceFairnessActive: false, sceneNoteActive: false },
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [],
        semanticFacts: [],
        chapters: [],
        activeCampaignId: 'camp',
        provider: { id: 'p', endpoint: 'http://story', modelName: 'story', apiKey: '' },
        getMessages: () => messages,
        getFreshProvider: () => undefined,
        incrementBookkeepingTurnCounter: () => 0,
        autoBookkeepingInterval: 5,
        resetBookkeepingTurnCounter: () => {},
        timeline: [],
        pinnedChapterIds: [],
        clearPinnedChapters: () => {},
    } as any as TurnState;
    const last = () => messages[messages.length - 1];
    const callbacks = {
        onCheckingNotes: () => {},
        addMessage: (m: any) => messages.push(m),
        updateLastAssistant: (c: string) => { last().content = c; },
        updateLastMessage: (p: any) => Object.assign(last(), p),
        updateContext: vi.fn(),
        setArchiveIndex: () => {},
        updateNPC: () => {},
        addNPC: () => {},
        setCondensed: () => {},
        setStreaming: () => {},
    } as any as TurnCallbacks;
    return { state, callbacks, messages };
}

type Reply = { text: string; toolCall?: { id: string; name: string; arguments: string } } | { error: string };
function script(replies: Reply[]) {
    let i = 0;
    sendMessageMock.mockImplementation((_p: unknown, _m: unknown, _c: unknown, onDone: any, onError: any) => {
        const r = replies[i++];
        Promise.resolve().then(() => ('error' in r ? onError(r.error) : onDone(r.text, r.toolCall, undefined)));
        return Promise.resolve();
    });
}
const flush = (ms = 50) => new Promise(r => setTimeout(r, ms));

beforeEach(() => vi.clearAllMocks());

describe('runTurn — Scene Notebook moved to the auxiliary model', () => {
    it('offers lore and dice tools but not update_scene_notebook', async () => {
        script([{ text: 'The gate creaks open.' }]);
        const { state, callbacks } = makeTurn();
        await runTurn(state, callbacks, new AbortController());
        const tools = sendMessageMock.mock.calls[0][5] as any[];
        const names = tools.map(t => t.function.name);
        expect(names).toEqual(expect.arrayContaining(['query_campaign_lore', 'roll_dice']));
        expect(names).not.toContain('update_scene_notebook');
    });

    it('a finished reply is handed to the notebook prefetch once, with the story untouched', async () => {
        script([{ text: 'The gate creaks open.' }]);
        const { state, callbacks, messages } = makeTurn();
        await runTurn(state, callbacks, new AbortController());
        await flush();
        expect(prefetchMock).toHaveBeenCalledTimes(1);
        expect(prefetchMock).toHaveBeenCalledWith('The gate creaks open.');
        expect(sendMessageMock).toHaveBeenCalledTimes(1); // no notebook round trip
        expect(callbacks.updateContext).not.toHaveBeenCalledWith(expect.objectContaining({ notebook: expect.anything() }));
        const gm = messages.filter(m => m.role === 'assistant').pop();
        expect(gm.content).toBe('The gate creaks open.');
        expect(gm.pendingCommit).toBe(true);
    });

    it.each([
        { enabled: false, pool: false, diceExpected: false },
        { enabled: true, pool: false, diceExpected: true },
        { enabled: undefined, pool: false, diceExpected: true },
        { enabled: true, pool: true, diceExpected: false },
        { enabled: false, pool: true, diceExpected: false },
    ])('keeps lore available with dice enabled=$enabled and pool=$pool', async ({ enabled, pool, diceExpected }) => {
        script([{ text: 'The gate creaks open.' }]);
        const { state, callbacks } = makeTurn();
        state.context.diceToolEnabled = enabled;
        state.context.diceFairnessActive = pool;
        await runTurn(state, callbacks, new AbortController());
        const names = (sendMessageMock.mock.calls[0][5] as any[]).map(t => t.function.name);
        expect(names).toContain('query_campaign_lore');
        expect(names.includes('roll_dice')).toBe(diceExpected);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('still resolves a manual roll with AI dice tools enabled=%s', async enabled => {
        script([{ text: 'You force the gate open.' }]);
        manualRollMock.mockReturnValueOnce({ rolls: [12], tier: 'Success', faceValue: 12, detail: '1d20' });
        const { state, callbacks, messages } = makeTurn();
        state.context.diceToolEnabled = enabled;
        state.armedRoll = '1d20';
        await runTurn(state, callbacks, new AbortController());
        expect(manualRollMock).toHaveBeenCalledWith('1d20', state.context.diceSystem);
        expect(messages[0].content).toContain('[RESOLVED ROLL');
        expect(messages[0].content).toContain('Success (12)');
        expect((sendMessageMock.mock.calls[0][5] as any[]).map(t => t.function.name)).toEqual(['query_campaign_lore']);
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('can still look up lore with AI dice tools disabled', async () => {
        script([
            { text: '', toolCall: { id: 'lore', name: 'query_campaign_lore', arguments: '{"query":"gate"}' } },
            { text: 'The iron gate creaks open.' },
        ]);
        const { state, callbacks } = makeTurn();
        state.context.diceToolEnabled = false;
        await runTurn(state, callbacks, new AbortController());
        await flush(700);
        expect(sendMessageMock).toHaveBeenCalledTimes(2);
        expect(loreSearchMock).toHaveBeenCalledWith(state.loreChunks, 'gate', 4000);
        for (const call of sendMessageMock.mock.calls) {
            expect((call[5] as any[]).map(t => t.function.name)).toEqual(['query_campaign_lore']);
        }
    });

    it('lore and dice calls still loop back to the story model before the prefetch', async () => {
        script([
            { text: '', toolCall: { id: 't1', name: 'query_campaign_lore', arguments: '{"query":"gate","max_tokens":8000}' } },
            { text: '', toolCall: { id: 't2', name: 'roll_dice', arguments: '{"dice":"1d20","reason":"Force the gate"}' } },
            { text: 'You heave the iron gate aside.' },
        ]);
        const { state, callbacks, messages } = makeTurn();
        await runTurn(state, callbacks, new AbortController());
        await flush(700); // the lore branch dwells 400 ms on its 'checking notes' state
        expect(sendMessageMock).toHaveBeenCalledTimes(3);
        expect(loreSearchMock).toHaveBeenCalledWith(state.loreChunks, 'gate', 8000);
        const toolMsgs = messages.filter(m => m.role === 'tool');
        expect(toolMsgs.map(m => m.name)).toEqual(['query_campaign_lore', 'roll_dice']);
        expect(toolMsgs[0].content).toContain('The gate is iron.');
        expect(JSON.parse(toolMsgs[1].content)).toMatchObject({ dice: '1d20', reason: 'Force the gate' });
        expect(prefetchMock).toHaveBeenCalledTimes(1);
        expect(prefetchMock).toHaveBeenCalledWith('You heave the iron gate aside.');
    });

    it('an aborted reply requests no notebook update', async () => {
        script([{ error: '__ABORT__' }]);
        const { state, callbacks } = makeTurn();
        await runTurn(state, callbacks, new AbortController());
        await flush();
        expect(prefetchMock).not.toHaveBeenCalled();
    });

    it('a failed reply requests no notebook update after its retries', async () => {
        vi.useFakeTimers();
        script([{ error: 'boom' }, { error: 'boom' }, { error: 'boom' }]);
        const { state, callbacks } = makeTurn();
        await runTurn(state, callbacks, new AbortController());
        await vi.advanceTimersByTimeAsync(5000);
        vi.useRealTimers();
        expect(sendMessageMock).toHaveBeenCalledTimes(3);
        expect(prefetchMock).not.toHaveBeenCalled();
    });
});
