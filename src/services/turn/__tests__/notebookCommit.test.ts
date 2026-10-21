/* eslint-disable @typescript-eslint/no-explicit-any */
// Scene Notebook × swipe/commit lifecycle. The auxiliary edits are drafted per
// variant before commit, and only the committed variant's edits reach the
// notebook. Discarded turns, edited replies and auxiliary failures are covered.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, NotebookNote } from '../../../types';

const llmCallMock = vi.fn();
vi.mock('../../../utils/llmCall', () => ({
    llmCall: (...args: unknown[]) => llmCallMock(...args),
}));

const handlePostTurnMock = vi.fn(async () => {});
vi.mock('../turnPostProcess', () => ({
    handlePostTurn: (...args: unknown[]) => (handlePostTurnMock as any)(...args),
}));

vi.mock('../../../store/campaignStore', () => ({
    loadChapters: vi.fn(async () => []),
    saveCampaignState: vi.fn(async () => {}),
}));

const notifyError = vi.fn();
vi.mock('../../ports/notify', () => ({
    notify: { warning: vi.fn(), error: (...a: unknown[]) => notifyError(...a), success: vi.fn() },
}));

let fakeState: any;
vi.mock('../../ports/store', () => ({
    storeAccess: () => ({
        getState: () => fakeState,
        setState: (patch: any) => { fakeState = { ...fakeState, ...(typeof patch === 'function' ? patch(fakeState) : patch) }; },
    }),
}));

import {
    capturePendingTurnSnapshot,
    clearPendingTurnSnapshot,
    commitPendingTurn,
    prefetchNotebookForPendingVariant,
} from '../pendingCommit';
import { pendingNotebookJobCount } from '../sceneNotebookMaintenance';
import { saveCampaignState } from '../../../store/campaignStore';
import { getPendingTurnSnapshot, findPendingCommitMessage } from '../pendingCommit';
import { debouncedSaveCampaignState } from '../../../store/slices/campaignSlice';

const AUX = { id: 'aux', endpoint: 'http://aux', modelName: 'cheap-aux', apiKey: '' } as any;
const STORY_SYSTEM_PROMPT = 'HUGE STORY SYSTEM PROMPT AND LORE';

const note = (text: string): NotebookNote => ({ id: `n_${text}`, text, timestamp: 1 });
const texts = () => (fakeState.context.notebook as NotebookNote[]).map(n => n.text);

// llmCall answers by which GM reply the prompt carries.
const replies: Record<string, string> = {
    'Swipe one: the guard wakes.': '{"actions":[{"op":"add","text":"Guard awake"}]}',
    'Swipe two: the guard sleeps on.': '{"actions":[{"op":"add","text":"Guard still asleep"}]}',
    'Edited: the guard is gone.': '{"actions":[{"op":"add","text":"Guard gone"}]}',
};
function wireAux() {
    llmCallMock.mockImplementation(async (_p: unknown, prompt: string) => {
        const hit = Object.keys(replies).find(k => prompt.includes(k));
        return hit ? replies[hit] : '{"actions":[]}';
    });
}

function setup(variants: string[], activeIndex = 0, notebook: NotebookNote[] = [note('Night, raining')]) {
    const userMsg: ChatMessage = { id: 'u1', role: 'user', content: 'I sneak past the guard.', displayContent: 'I sneak past the guard.', timestamp: 1 };
    const gm: ChatMessage = {
        id: 'gm1', role: 'assistant', content: variants[activeIndex], timestamp: 2, pendingCommit: true,
        swipeActiveIndex: activeIndex,
        swipeSet: variants.map((text, i) => ({ id: `v${i}`, text, sceneStakes: 'calm', tagPresent: true })),
    } as any;
    fakeState = {
        activeCampaignId: 'camp',
        messages: [userMsg, gm],
        context: { notebook, notebookActive: true },
        condenser: { condensedUpToIndex: -1 },
        pinnedExcerpts: [],
        settings: { aiTier: 'lite', autoCondenseEnabled: false },
        updateContext: vi.fn((patch: any) => { fakeState.context = { ...fakeState.context, ...patch }; }),
    };
    const turnState: any = {
        activeCampaignId: 'camp',
        settings: fakeState.settings,
        context: fakeState.context,
        npcLedger: [],
        condenser: fakeState.condenser,
        getMessages: () => fakeState.messages,
        getFreshAuxiliaryProvider: () => AUX,
    };
    capturePendingTurnSnapshot(turnState, [{ role: 'system', content: STORY_SYSTEM_PROMPT }], 'I sneak past the guard.');
}

beforeEach(() => {
    vi.clearAllMocks();
    clearPendingTurnSnapshot();
    wireAux();
});

describe('Scene Notebook at commit', () => {
    it('replaces an autosave captured before acknowledgement so it cannot restore pendingCommit', async () => {
        vi.useFakeTimers();
        try {
            setup(['Swipe one: the guard wakes.']);
            fakeState.context.notebookActive = false;
            debouncedSaveCampaignState('camp', {
                context: fakeState.context, messages: fakeState.messages,
                condenser: fakeState.condenser, pinnedExcerpts: [],
            });
            await commitPendingTurn();
            await vi.advanceTimersByTimeAsync(1100);
            const saved = vi.mocked(saveCampaignState).mock.calls.at(-1)![1];
            expect(saved.messages[1].pendingCommit).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not archive if persisting the pending recovery marker fails', async () => {
        setup(['Swipe one: the guard wakes.']);
        vi.mocked(saveCampaignState).mockRejectedValueOnce(new Error('Recovery save failed'));
        await expect(commitPendingTurn()).rejects.toThrow('Recovery save failed');
        expect(handlePostTurnMock).not.toHaveBeenCalled();
        expect(fakeState.messages[1].pendingCommit).toBe(true);
        expect(getPendingTurnSnapshot()).not.toBeNull();
    });

    it('retains the pending turn and snapshot on archive failure, without applying notebook edits', async () => {
        setup(['Swipe one: the guard wakes.']);
        handlePostTurnMock.mockRejectedValueOnce(new Error('Storage full'));
        await expect(commitPendingTurn()).rejects.toThrow('Storage full');
        expect(fakeState.messages[1].pendingCommit).toBe(true);
        expect(getPendingTurnSnapshot()).not.toBeNull();
        expect(texts()).toEqual(['Night, raining']);
        expect(saveCampaignState).toHaveBeenCalledWith('camp', expect.objectContaining({
            messages: expect.arrayContaining([expect.objectContaining({ pendingCommit: true })]),
        }));
        await commitPendingTurn();
        expect(fakeState.messages[1].pendingCommit).toBeUndefined();
    });

    it('retains recovery state when the final campaign save fails, and can retry past a scene marker', async () => {
        setup(['Swipe one: the guard wakes.']);
        handlePostTurnMock.mockImplementationOnce(async () => {
            fakeState.messages = [...fakeState.messages, { id: 'marker', role: 'system', name: 'scene-marker', content: 'Scene 001', timestamp: 3 }];
        });
        vi.mocked(saveCampaignState).mockResolvedValueOnce().mockRejectedValueOnce(new Error('Final save failed'));
        await expect(commitPendingTurn()).rejects.toThrow('Final save failed');
        expect(findPendingCommitMessage(fakeState.messages)?.id).toBe('gm1');
        expect(getPendingTurnSnapshot()).not.toBeNull();
        await commitPendingTurn();
        expect(fakeState.messages[1].pendingCommit).toBeUndefined();
        expect((handlePostTurnMock.mock.calls.at(-1) as unknown[])[7]).toBe('gm1');
    });

    it('shares a single in-flight commit between simultaneous callers', async () => {
        setup(['Swipe one: the guard wakes.']);
        const first = commitPendingTurn();
        const second = commitPendingTurn();
        expect(second).toBe(first);
        await Promise.all([first, second]);
        expect(handlePostTurnMock).toHaveBeenCalledTimes(1);
    });

    it('applies only the committed swipe edits; the other swipe job is aborted', async () => {
        setup(['Swipe one: the guard wakes.', 'Swipe two: the guard sleeps on.'], 1);
        prefetchNotebookForPendingVariant('Swipe one: the guard wakes.');
        prefetchNotebookForPendingVariant('Swipe two: the guard sleeps on.');
        expect(pendingNotebookJobCount()).toBe(2);
        // Nothing is applied before commit.
        await Promise.resolve();
        expect(fakeState.updateContext).not.toHaveBeenCalled();

        await commitPendingTurn();

        expect(texts()).toEqual(['Night, raining', 'Guard still asleep']);
        expect(llmCallMock).toHaveBeenCalledTimes(2); // no extra call at commit
        const swipeOneSignal = llmCallMock.mock.calls[0][2].signal as AbortSignal;
        expect(swipeOneSignal.aborted).toBe(true);
        expect(pendingNotebookJobCount()).toBe(0);
        // The committed bubble is a normal message again.
        expect(fakeState.messages[1].pendingCommit).toBeUndefined();
        expect(fakeState.messages[1].content).toBe('Swipe two: the guard sleeps on.');
    });

    it('sends the auxiliary model the notebook, player message and reply — not the story payload', async () => {
        setup(['Swipe one: the guard wakes.']);
        prefetchNotebookForPendingVariant('Swipe one: the guard wakes.');
        await commitPendingTurn();
        const [provider, prompt] = llmCallMock.mock.calls[0];
        expect(provider).toBe(AUX);
        expect(prompt).toContain('- Night, raining');
        expect(prompt).toContain('I sneak past the guard.');
        expect(prompt).toContain('Swipe one: the guard wakes.');
        expect(prompt).not.toContain(STORY_SYSTEM_PROMPT);
    });

    it('an edited reply gets a fresh update for the edited text at commit', async () => {
        setup(['Swipe one: the guard wakes.']);
        prefetchNotebookForPendingVariant('Swipe one: the guard wakes.');
        fakeState.messages[1] = { ...fakeState.messages[1], content: 'Edited: the guard is gone.' };
        await commitPendingTurn();
        expect(texts()).toEqual(['Night, raining', 'Guard gone']);
        expect(llmCallMock).toHaveBeenCalledTimes(2);
    });

    it('with no snapshot (app restart) commit still updates the notebook from the stored turn', async () => {
        setup(['Swipe one: the guard wakes.']);
        clearPendingTurnSnapshot();
        fakeState.messages[1] = { ...fakeState.messages[1], pendingCommit: true, swipeSet: [{ id: 'v0', text: 'Swipe one: the guard wakes.', sceneStakes: 'calm', tagPresent: true }] };
        fakeState.getActiveAuxiliaryEndpoint = () => AUX;
        fakeState.getActiveStoryEndpoint = () => undefined;
        fakeState.getActiveSummarizerEndpoint = () => undefined;
        fakeState.getActiveUtilityEndpoint = () => undefined;
        await commitPendingTurn();
        expect(texts()).toEqual(['Night, raining', 'Guard awake']);
        expect(llmCallMock.mock.calls[0][1]).toContain('I sneak past the guard.');
    });

    it('a discarded turn (delete / rewind) never touches the notebook', async () => {
        let finish!: (raw: string) => void;
        llmCallMock.mockReturnValueOnce(new Promise<string>(r => { finish = r; }));
        setup(['Swipe one: the guard wakes.']);
        prefetchNotebookForPendingVariant('Swipe one: the guard wakes.');
        const signal = llmCallMock.mock.calls[0][2].signal as AbortSignal;

        clearPendingTurnSnapshot();
        expect(signal.aborted).toBe(true);
        finish('{"actions":[{"op":"add","text":"Guard awake"}]}');
        await new Promise(r => setTimeout(r, 0));
        expect(fakeState.updateContext).not.toHaveBeenCalled();
        expect(texts()).toEqual(['Night, raining']);
    });

    it('a new turn starting drops jobs left over from the previous pending turn', () => {
        llmCallMock.mockReturnValue(new Promise(() => {}));
        setup(['Swipe one: the guard wakes.']);
        prefetchNotebookForPendingVariant('Swipe one: the guard wakes.');
        const signal = llmCallMock.mock.calls[0][2].signal as AbortSignal;
        capturePendingTurnSnapshot({ activeCampaignId: 'camp', getMessages: () => [] } as any, [], 'next');
        expect(signal.aborted).toBe(true);
        expect(pendingNotebookJobCount()).toBe(0);
    });

    it('an auxiliary failure keeps the story reply and commits normally', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        llmCallMock.mockRejectedValue(new Error('aux 503'));
        setup(['Swipe one: the guard wakes.']);
        prefetchNotebookForPendingVariant('Swipe one: the guard wakes.');
        await commitPendingTurn();
        expect(texts()).toEqual(['Night, raining']);
        expect(llmCallMock).toHaveBeenCalledTimes(1); // not retried at commit
        expect(handlePostTurnMock).toHaveBeenCalledTimes(1);
        expect((handlePostTurnMock.mock.calls[0] as any[])[5]).toBe('Swipe one: the guard wakes.');
        expect(fakeState.messages[1].content).toBe('Swipe one: the guard wakes.');
        expect(fakeState.messages[1].pendingCommit).toBeUndefined();
        expect(notifyError).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('a notebook switched off makes no auxiliary call', async () => {
        setup(['Swipe one: the guard wakes.']);
        fakeState.context = { ...fakeState.context, notebookActive: false };
        prefetchNotebookForPendingVariant('Swipe one: the guard wakes.');
        await commitPendingTurn();
        expect(llmCallMock).not.toHaveBeenCalled();
    });
});
