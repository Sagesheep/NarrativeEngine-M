/* eslint-disable @typescript-eslint/no-explicit-any */
// The auxiliary model keeps the Scene Notebook: the story model no longer has
// an update_scene_notebook tool. Covers the edit schema/validation, the prompt
// (notebook + player message + GM reply only), job lifecycle and failures.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotebookNote } from '../../../types';

const llmCallMock = vi.fn();
vi.mock('../../../utils/llmCall', () => ({
    llmCall: (...args: unknown[]) => llmCallMock(...args),
}));

let fakeState: any;
vi.mock('../../ports/store', () => ({
    storeAccess: () => ({ getState: () => fakeState, setState: vi.fn() }),
}));

import { getToolDefinitions, parseNotebookActions, applyNotebookActions, MAX_NOTEBOOK_NOTES } from '../toolHandlers';
import {
    buildNotebookMaintenancePrompt,
    requestNotebookActions,
    startNotebookJob,
    prefetchNotebookUpdate,
    takeNotebookJob,
    cancelNotebookJobs,
    pendingNotebookJobCount,
    settleNotebookJob,
    applyNotebookUpdateToStore,
} from '../sceneNotebookMaintenance';

const AUX = { id: 'aux', endpoint: 'http://aux', modelName: 'cheap-aux', apiKey: '' } as any;
const note = (text: string): NotebookNote => ({ id: `n_${text}`, text, timestamp: 1 });

function makeStore(notebook: NotebookNote[] = [], campaignId = 'camp') {
    fakeState = {
        activeCampaignId: campaignId,
        context: { notebook, notebookActive: true },
        updateContext: vi.fn((patch: any) => { fakeState.context = { ...fakeState.context, ...patch }; }),
    };
}

const jobInput = (storyText: string, over: Record<string, unknown> = {}) => ({
    snapshotId: 'snap1',
    campaignId: 'camp',
    storyText,
    userMessage: 'I light the torch.',
    notebook: [] as NotebookNote[],
    getProvider: () => AUX,
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    cancelNotebookJobs();
    makeStore();
});

describe('story tools', () => {
    it('never offer update_scene_notebook; lore and dice stay', () => {
        for (const allowDiceTool of [false, true]) {
            const names = getToolDefinitions({ allowDiceTool }).map(t => t.function.name);
            expect(names).not.toContain('update_scene_notebook');
            expect(names).toContain('query_campaign_lore');
            expect(names.includes('roll_dice')).toBe(allowDiceTool);
        }
    });
});

describe('parseNotebookActions', () => {
    it('keeps valid add/remove/clear and drops malformed entries', () => {
        const actions = parseNotebookActions({
            actions: [
                { op: 'add', text: '  Torch lit  ' },
                { op: 'add' },
                { op: 'remove', text: '   ' },
                { op: 'rename', text: 'x' },
                null,
                { op: 'clear', text: 'ignored' },
                { op: 'remove', text: 'door' },
            ],
        });
        expect(actions).toEqual([
            { op: 'add', text: 'Torch lit' },
            { op: 'clear' },
            { op: 'remove', text: 'door' },
        ]);
    });

    it('caps at 5 actions and accepts a JSON string', () => {
        const raw = JSON.stringify({ actions: Array.from({ length: 8 }, (_, i) => ({ op: 'add', text: `n${i}` })) });
        expect(parseNotebookActions(raw)).toHaveLength(5);
    });

    it('returns nothing for garbage', () => {
        expect(parseNotebookActions('not json')).toEqual([]);
        expect(parseNotebookActions(null)).toEqual([]);
        expect(parseNotebookActions({ actions: 'add' })).toEqual([]);
    });
});

describe('applyNotebookActions', () => {
    it('applies in order without mutating the input, keeping untouched notes', () => {
        const before = [note('Guard asleep at the gate'), note('Rain falling')];
        const after = applyNotebookActions(before, [
            { op: 'remove', text: 'guard asleep' },
            { op: 'add', text: 'Guard awake and alert' },
        ]);
        expect(before).toHaveLength(2);
        expect(after.map(n => n.text)).toEqual(['Rain falling', 'Guard awake and alert']);
        expect(after[0]).toBe(before[1]);
    });

    it('prefers an exact match on remove over a substring match', () => {
        const after = applyNotebookActions([note('Door locked (east wing)'), note('Door locked')], [{ op: 'remove', text: 'door locked' }]);
        expect(after.map(n => n.text)).toEqual(['Door locked (east wing)']);
    });

    it('skips duplicates and respects the note cap', () => {
        expect(applyNotebookActions([note('Rain falling')], [{ op: 'add', text: 'rain falling' }])).toHaveLength(1);
        const full = Array.from({ length: MAX_NOTEBOOK_NOTES }, (_, i) => note(`n${i}`));
        expect(applyNotebookActions(full, [{ op: 'add', text: 'one more' }])).toHaveLength(MAX_NOTEBOOK_NOTES);
    });

    it('clear then add starts a new scene', () => {
        const after = applyNotebookActions([note('a'), note('b')], [{ op: 'clear' }, { op: 'add', text: 'At the docks' }]);
        expect(after.map(n => n.text)).toEqual(['At the docks']);
    });
});

describe('buildNotebookMaintenancePrompt / requestNotebookActions', () => {
    it('sends only the notebook, the player message and the GM reply', async () => {
        llmCallMock.mockResolvedValueOnce('```json\n{"actions":[{"op":"add","text":"Torch lit"}]}\n```');
        const actions = await requestNotebookActions({
            provider: AUX,
            notebook: [note('Cellar is dark')],
            userMessage: 'I light the torch.',
            storyText: 'The torch flares to life.',
        });
        expect(actions).toEqual([{ op: 'add', text: 'Torch lit' }]);
        const [provider, prompt, opts] = llmCallMock.mock.calls[0];
        expect(provider).toBe(AUX);
        expect(prompt).toContain('- Cellar is dark');
        expect(prompt).toContain('I light the torch.');
        expect(prompt).toContain('The torch flares to life.');
        expect(opts).toMatchObject({ thinkingEffort: 'off' });
    });

    it('marks an empty notebook and bounds a huge reply', () => {
        const prompt = buildNotebookMaintenancePrompt({ notebook: [], userMessage: '', storyText: 'x'.repeat(50_000) });
        expect(prompt).toContain('CURRENT NOTEBOOK:\n(empty)');
        expect(prompt.length).toBeLessThan(20_000);
    });

    it('yields no actions when the reply is not JSON', async () => {
        llmCallMock.mockResolvedValueOnce('Sure! The torch is lit.');
        await expect(requestNotebookActions({ provider: AUX, notebook: [], userMessage: 'a', storyText: 'b' })).resolves.toEqual([]);
    });
});

describe('notebook jobs', () => {
    it('a failed auxiliary call resolves to null and never throws', async () => {
        llmCallMock.mockRejectedValueOnce(new Error('503'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(startNotebookJob(jobInput('GM text')).result).resolves.toBeNull();
        warn.mockRestore();
    });

    it('no auxiliary provider: no call, null result', async () => {
        await expect(startNotebookJob(jobInput('GM text', { getProvider: () => undefined })).result).resolves.toBeNull();
        expect(llmCallMock).not.toHaveBeenCalled();
    });

    it('prefetch dedupes by text, and a new pending turn aborts the old turn jobs', () => {
        llmCallMock.mockReturnValue(new Promise(() => {}));
        prefetchNotebookUpdate(jobInput('A'));
        prefetchNotebookUpdate(jobInput('A'));
        prefetchNotebookUpdate(jobInput('B'));
        expect(pendingNotebookJobCount()).toBe(2);
        const oldSignal = llmCallMock.mock.calls[0][2].signal as AbortSignal;
        prefetchNotebookUpdate(jobInput('C', { snapshotId: 'snap2' }));
        expect(oldSignal.aborted).toBe(true);
        expect(pendingNotebookJobCount()).toBe(1);
    });

    it('take returns the committed text job and aborts the rest', () => {
        llmCallMock.mockReturnValue(new Promise(() => {}));
        prefetchNotebookUpdate(jobInput('swipe one'));
        prefetchNotebookUpdate(jobInput('swipe two'));
        const [sigOne, sigTwo] = llmCallMock.mock.calls.map(c => c[2].signal as AbortSignal);
        const job = takeNotebookJob('snap1', 'swipe two');
        expect(job?.storyText).toBe('swipe two');
        expect(sigOne.aborted).toBe(true);
        expect(sigTwo.aborted).toBe(false);
        expect(pendingNotebookJobCount()).toBe(0);
        expect(takeNotebookJob('snap1', 'swipe two')).toBeUndefined();
    });
});

describe('settleNotebookJob / applyNotebookUpdateToStore', () => {
    it('applies a finished job to the live notebook', async () => {
        makeStore([note('Cellar is dark')]);
        llmCallMock.mockResolvedValueOnce('{"actions":[{"op":"remove","text":"cellar is dark"},{"op":"add","text":"Torch lit"}]}');
        await settleNotebookJob(startNotebookJob(jobInput('GM')));
        expect(fakeState.context.notebook.map((n: NotebookNote) => n.text)).toEqual(['Torch lit']);
    });

    it('stops waiting at the deadline, then applies the late result', async () => {
        let finish!: (raw: string) => void;
        llmCallMock.mockReturnValueOnce(new Promise<string>(r => { finish = r; }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const job = startNotebookJob(jobInput('GM'));
        await settleNotebookJob(job, 5);
        expect(fakeState.updateContext).not.toHaveBeenCalled();
        finish('{"actions":[{"op":"add","text":"Late note"}]}');
        await job.result;
        await Promise.resolve();
        expect(fakeState.context.notebook.map((n: NotebookNote) => n.text)).toEqual(['Late note']);
        warn.mockRestore();
    });

    it('drops edits when another campaign is open, or the notebook is off', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        makeStore([], 'other');
        expect(applyNotebookUpdateToStore('camp', [{ op: 'add', text: 'x' }])).toBe(false);
        makeStore([], 'camp');
        fakeState.context.notebookActive = false;
        expect(applyNotebookUpdateToStore('camp', [{ op: 'add', text: 'x' }])).toBe(false);
        expect(fakeState.updateContext).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('a failed job leaves the notebook alone', async () => {
        makeStore([note('Keep me')]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        llmCallMock.mockRejectedValueOnce(new Error('timeout'));
        await settleNotebookJob(startNotebookJob(jobInput('GM')));
        expect(fakeState.updateContext).not.toHaveBeenCalled();
        expect(fakeState.context.notebook.map((n: NotebookNote) => n.text)).toEqual(['Keep me']);
        warn.mockRestore();
    });
});
