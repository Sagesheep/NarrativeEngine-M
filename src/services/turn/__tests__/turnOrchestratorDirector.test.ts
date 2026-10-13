/* eslint-disable @typescript-eslint/no-explicit-any */
// WO-A §3.3: focused `runTurn` call-site tests for the Director Brief tier gate.
//
// Asserts that `turnOrchestrator.ts` owns the tier gate for `runDirectorBrief`:
//   - lite tier completes the pre-payload path without invoking runDirectorBrief
//   - pro tier invokes runDirectorBrief exactly once
//   - max tier invokes runDirectorBrief exactly once
//
// The service itself is ungated (its tests cover its own contract). This file
// mocks heavy collaborators (`gatherContext`, `sendMessage`,
// `buildWatchdogDossier`, `capturePendingTurnSnapshot`, the engine rolls, the
// loot engine, `notify`, `sanitizePayloadForApi`,
// `extractAndStripSceneStakes`, tool handlers) so the test reaches the gate
// without any real I/O. The real `aiTier.tierAllows` is used — the gate's
// behavior is the SUT, not a mock.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings, GameContext, ChatMessage, NPCEntry, CondenserState, ArchiveIndexEntry, ArchiveChapter, DivergenceRegister, LLMProvider, PinnedExcerpt, TimelineEvent, SemanticFact, ManualRollRequest } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';

// ── Mocks (hoisted by vitest) ────────────────────────────────────────────────

// The Director service mock — tracks invocations.
const runDirectorBriefMock = vi.fn(async (_input: unknown) => null as string | null);
const lastAssistantContentMock = vi.fn((_messages: unknown[]) => 'LAST_GM_TEXT');
vi.mock('../directorBrief', () => ({
    runDirectorBrief: (input: unknown) => runDirectorBriefMock(input),
    lastAssistantContent: (messages: unknown[]) => lastAssistantContentMock(messages),
    clearDirectorBriefCache: vi.fn(),
}));

// The watchdog dossier mock — returns an empty dossier so the orchestrator's
// `watchdogNudge` is undefined (no nudge in the payload; irrelevant to the gate).
vi.mock('../directorWatchdog', () => ({
    buildWatchdogDossier: vi.fn(() => ({ signals: [], dossierText: '', nudgeText: null })),
}));

// pendingCommit mock — capturePendingTurnSnapshot + getActiveSnapshotId.
vi.mock('../pendingCommit', () => ({
    capturePendingTurnSnapshot: vi.fn(),
    getActiveSnapshotId: vi.fn(() => null),
}));

// gatherContext mock — returns the minimal GatheredContext shape.
vi.mock('../turnContext', () => ({
    gatherContext: vi.fn(async () => ({
        relevantLore: undefined,
        relevantRules: undefined,
        sceneNumber: undefined,
        archiveRecall: undefined,
        semanticArchiveHits: [],
        semanticFactText: '',
        recommendedNPCNames: undefined,
        deepContextSummary: undefined,
        payloadResult: { messages: [{ role: 'user', content: 'hello' }], trace: [] },
    })),
    // re-export the type name for the orchestrator's `import type` line.
}));

// chatEngine mock — sendMessage invokes the onDone callback synchronously so
// `runTurn` resolves cleanly.
const sendMessageMock = vi.fn();
vi.mock('../../chatEngine', () => ({
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

// payloadSanitizer mock — identity.
vi.mock('../../llm/payloadSanitizer', () => ({
    sanitizePayloadForApi: (p: unknown) => p,
}));

// notify mock — no-op.
vi.mock('../ports/notify', () => ({
    notify: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// sceneStakesTag mock — identity.
vi.mock('../sceneStakesTag', () => ({
    extractAndStripSceneStakes: (text: string) => ({ displayText: text, stakes: 'calm' as const }),
}));

// Tool handlers mock — no tools.
vi.mock('../toolHandlers', () => ({
    getToolDefinitions: vi.fn(() => []),
    handleLoreTool: vi.fn(),
    handleNotebookTool: vi.fn(),
    handleDiceTool: vi.fn(),
}));

// Engine mocks — no-op rolls.
vi.mock('../../engine', () => ({
    rollEngines: vi.fn(() => ({ appendToInput: '', updatedDCs: {} })),
    rollDiceFairness: vi.fn(() => ''),
    rollCharacterIntroEngine: vi.fn(),
    resolveManualRoll: vi.fn(() => ({
        rolls: [10], detail: '1d20', tier: 'Regular', faceValue: '10',
    })),
    resolveLootDrop: vi.fn(() => ({ appendToInput: '' })),
}));
vi.mock('../../engine/lootDropTelemetry', () => ({
    recordLootDrop: vi.fn(),
}));

// uid mock — deterministic.
vi.mock('../../utils/uid', () => ({ uid: vi.fn(() => 'uid_test') }));

// llmMessages mock — the orchestrator imports buildAssistantToolCallMessage +
// buildToolResultMessage; not reached in the success path, but the module
// must resolve.
vi.mock('../../../types/llmMessages', () => ({
    buildAssistantToolCallMessage: vi.fn(),
    buildToolResultMessage: vi.fn(),
}));

// ── SUT import (after mocks are hoisted) ─────────────────────────────────────
import { runTurn } from '../turnOrchestrator';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseSettings(aiTier: 'lite' | 'pro' | 'max'): AppSettings {
    return {
        aiTier,
        contextLimit: 8192,
        debugMode: false,
        matureMode: false,
        rulesBudgetPct: 10,
        presets: [],
        activePresetId: '',
        providers: [],
    } as any as AppSettings;
}

function baseContext(): GameContext {
    return {
        loreRaw: '',
        rulesRaw: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        inventoryLastScene: '',
        characterProfile: { identity: {}, activeTraits: [] },
        characterProfileLastScene: '',
        starterActive: false,
        continuePromptActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        characterProfileUserDisabled: false,
        surpriseEngineActive: false,
        encounterEngineActive: false,
        worldEngineActive: false,
        diceFairnessActive: false,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 0,
        notebook: [],
        notebookActive: false,
    } as any as GameContext;
}

function baseState(aiTier: 'lite' | 'pro' | 'max'): TurnState {
    return {
        input: 'I look around.',
        displayInput: 'I look around.',
        settings: baseSettings(aiTier),
        context: baseContext(),
        messages: [] as ChatMessage[],
        condenser: { condensedUpToIndex: -1 } as any as CondenserState,
        loreChunks: [],
        npcLedger: [] as NPCEntry[],
        archiveIndex: [] as ArchiveIndexEntry[],
        semanticFacts: [] as SemanticFact[],
        chapters: [] as ArchiveChapter[],
        activeCampaignId: 'camp_test',
        provider: { id: 'p', endpoint: 'http://test', modelName: 'story', apiKey: '' } as any as LLMProvider,
        getMessages: () => [] as ChatMessage[],
        getFreshProvider: () => ({ id: 'p', endpoint: 'http://test', modelName: 'story', apiKey: '' } as any),
        getUtilityEndpoint: () => undefined,
        getFreshAuxiliaryProvider: () => undefined,
        incrementBookkeepingTurnCounter: () => 0,
        autoBookkeepingInterval: 5,
        resetBookkeepingTurnCounter: () => {},
        timeline: [] as TimelineEvent[],
        pinnedChapterIds: [],
        clearPinnedChapters: () => {},
        divergenceRegister: undefined as DivergenceRegister | undefined,
        onStageNpcIds: [],
        npcPressure: {},
        pinnedExcerpts: [] as PinnedExcerpt[],
        armedRoll: null as ManualRollRequest | string | null,
        armedLoot: null,
    } as any as TurnState;
}

function baseCallbacks(): TurnCallbacks {
    const noop = () => {};
    return {
        onCheckingNotes: noop,
        addMessage: noop,
        updateLastAssistant: noop,
        updateLastMessage: noop,
        updateContext: noop,
        setArchiveIndex: noop,
        updateNPC: noop,
        addNPC: noop,
        setCondensed: noop,
        setStreaming: noop,
    } as any as TurnCallbacks;
}

/** Configure sendMessage to invoke onDone synchronously with a minimal final text. */
function wireSendMessageToComplete(): void {
    sendMessageMock.mockImplementation(
        (_provider: unknown, _messages: unknown, _onChunk: unknown, onDone: any) => {
            Promise.resolve().then(() => onDone('Final GM text.', undefined, undefined));
            return Promise.resolve();
        },
    );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runTurn — Director Brief tier gate (WO-A §3.3)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        wireSendMessageToComplete();
    });

    it('lite tier completes the pre-payload path without invoking runDirectorBrief', async () => {
        await runTurn(baseState('lite'), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).not.toHaveBeenCalled();
    });

    it('pro tier invokes runDirectorBrief exactly once', async () => {
        await runTurn(baseState('pro'), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(1);
    });

    it('max tier invokes runDirectorBrief exactly once', async () => {
        await runTurn(baseState('max'), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(1);
    });

    it('the gate is owned by turnOrchestrator — runDirectorBrief mock returns null and the turn still completes', async () => {
        runDirectorBriefMock.mockResolvedValueOnce(null);
        await runTurn(baseState('pro'), baseCallbacks(), new AbortController());
        // sendMessage was reached (the turn completed the pre-payload path).
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('pro tier passes the expected inputs to runDirectorBrief (dossier, userMessage, campaignId, provider)', async () => {
        await runTurn(baseState('pro'), baseCallbacks(), new AbortController());
        const call = runDirectorBriefMock.mock.calls[0][0] as any;
        expect(call).toBeDefined();
        expect(call.campaignId).toBe('camp_test');
        expect(call.userMessage).toContain('I look around.');
        expect(call.provider).toBeDefined();
        // The watchdog dossier is empty (mocked) — dossierText is ''.
        expect(call.dossierText).toBe('');
        // lastAssistantContent is mocked to return 'LAST_GM_TEXT'.
        expect(call.lastAssistant).toBe('LAST_GM_TEXT');
    });

    it('an Absolute Command skips the Director, reaches the payload, and stays out of the stored message', async () => {
        const added: any[] = [];
        const callbacks = { ...baseCallbacks(), addMessage: (m: any) => added.push(m) } as any as TurnCallbacks;
        const { gatherContext } = await import('../turnContext');
        await runTurn({ ...baseState('max'), absoluteCommand: 'Skip to morning.' } as any as TurnState, callbacks, new AbortController());
        expect(runDirectorBriefMock).not.toHaveBeenCalled();
        const signals = vi.mocked(gatherContext).mock.calls[0][5] as any;
        expect(signals).toMatchObject({ absoluteCommand: 'Skip to morning.', watchdogNudge: undefined, directorBrief: undefined });
        const userMsg = added.find(m => m.role === 'user');
        expect(userMsg.content).not.toContain('Skip to morning.');
        expect(userMsg.displayContent).toContain('Absolute command issued');
    });

    it('an armed one-shot event rides this turn input and shows on the player bubble', async () => {
        const added: any[] = [];
        const callbacks = { ...baseCallbacks(), addMessage: (m: any) => added.push(m) } as any as TurnCallbacks;
        await runTurn({ ...baseState('lite'), armedOneShot: 'mystery' } as any as TurnState, callbacks, new AbortController());
        const userMsg = added.find(m => m.role === 'user');
        expect(userMsg.content).toContain('[INJECTED EVENT — MYSTERY.');
        expect(userMsg.displayContent).toContain('⚡ Event injected (mystery)');
    });
});
