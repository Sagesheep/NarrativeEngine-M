/**
 * sceneNotebookMaintenance.ts — the auxiliary model keeps the Scene Notebook.
 *
 * The story model used to edit the notebook through an update_scene_notebook
 * tool. A notebook-only reply cost a second full story request (the whole
 * ~58k-token payload again) just to get the prose. Now the auxiliary model gets
 * a small prompt — the current notebook, the player's message and the finished
 * GM reply — and answers with edits in the same `{ actions: [...] }` schema,
 * validated and applied by toolHandlers.parseNotebookActions/applyNotebookActions.
 *
 * Lifecycle (swipe-safe): a reply is not canon until its turn commits.
 * - When a variant finishes (swipe 1, swipes 2–5, a Smart Retry), the edits are
 *   requested in the background (`prefetchNotebookUpdate`) and only held here.
 * - At commit, the job for the committed text is taken (`takeNotebookJob`) and
 *   applied; every other job is aborted and its result dropped. If no job
 *   matches (the player edited the text, or the app restarted), commit starts one.
 * - Commit waits up to NOTEBOOK_COMMIT_WAIT_MS so the next story turn sees the
 *   new notebook; a slower result still applies when it lands, unless the
 *   campaign changed. Failures only log: the story reply is never touched.
 */
import type { LLMProvider, NotebookNote } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { storeAccess } from '../ports/store';
import {
    parseNotebookActions,
    applyNotebookActions,
    MAX_NOTEBOOK_OPS,
    MAX_NOTEBOOK_NOTES,
    type NotebookAction,
} from './toolHandlers';

/** Hard cap on one auxiliary notebook call; the job is aborted after this. */
export const NOTEBOOK_JOB_TIMEOUT_MS = 60_000;
/** How long commit waits for the edits before letting the next turn go ahead. */
export const NOTEBOOK_COMMIT_WAIT_MS = 10_000;

// Bound the prompt; a GM reply is normally far below these.
const MAX_USER_CHARS = 4_000;
const MAX_STORY_CHARS = 12_000;

export interface NotebookPromptInput {
    notebook: NotebookNote[];
    userMessage: string;
    storyText: string;
}

export function buildNotebookMaintenancePrompt({ notebook, userMessage, storyText }: NotebookPromptInput): string {
    const notes = notebook.length > 0
        ? notebook.map(n => `- ${n.text}`).join('\n')
        : '(empty)';
    return [
        'You keep the SCENE NOTEBOOK for an interactive story: a short list of volatile facts about the current scene that the storyteller must keep consistent — active spells and effects, timers and countdowns, where NPCs and objects are, environmental conditions, temporary injuries or statuses.',
        '',
        'Update it for the turn below.',
        '- add: a volatile fact this turn established or changed. One short line, present tense.',
        '- remove: a note that is now false, finished or replaced. Give the note\'s text. To change a note, remove the old one and add the new one.',
        '- clear: only when the scene has clearly ended (travel, time skip, new location) and no note still applies. You may add the new scene\'s facts after it.',
        '- Keep every note that is still true. Use only what the PLAYER and GM text says; never invent facts. Leave out permanent lore, backstory and plot summary.',
        `- At most ${MAX_NOTEBOOK_OPS} actions; the notebook holds at most ${MAX_NOTEBOOK_NOTES} notes. If nothing changed, return no actions.`,
        '',
        'CURRENT NOTEBOOK:',
        notes,
        '',
        'PLAYER:',
        userMessage.trim().slice(0, MAX_USER_CHARS) || '(none)',
        '',
        'GM:',
        storyText.trim().slice(0, MAX_STORY_CHARS),
        '',
        'Reply with JSON only, no prose:',
        '{"actions":[{"op":"add","text":"..."},{"op":"remove","text":"..."}]}',
    ].join('\n');
}

export interface NotebookRequestInput extends NotebookPromptInput {
    provider: LLMProvider;
    signal?: AbortSignal;
}

/** One auxiliary call. Rejects on transport failure; unparseable output yields no actions. */
export async function requestNotebookActions(input: NotebookRequestInput): Promise<NotebookAction[]> {
    const raw = await llmCall(input.provider, buildNotebookMaintenancePrompt(input), {
        signal: input.signal,
        maxTokens: 512,
        temperature: 0.2,
        priority: 'normal',
        // Bookkeeping, not prose: thinking only adds latency (as for the Director Brief).
        thinkingEffort: 'off',
    });
    const { value, parseOk } = extractJsonRobust<unknown>(raw, null);
    if (!parseOk) console.warn('[SceneNotebook] auxiliary reply was not JSON; no notebook edits');
    return parseNotebookActions(value);
}

// ── Job registry ─────────────────────────────────────────────────────────────
// Jobs belong to the pending turn (snapshotId) and to one exact reply text.

export interface NotebookJobInput {
    snapshotId: string;
    campaignId: string;
    storyText: string;
    userMessage: string;
    notebook: NotebookNote[];
    getProvider: () => LLMProvider | undefined;
}

export interface NotebookJob {
    snapshotId: string;
    campaignId: string;
    storyText: string;
    controller: AbortController;
    /** Never rejects: null when the call failed, was aborted, or no provider is set. */
    result: Promise<NotebookAction[] | null>;
}

let jobs: NotebookJob[] = [];

/** Start an auxiliary notebook call without registering it. */
export function startNotebookJob(input: NotebookJobInput): NotebookJob {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTEBOOK_JOB_TIMEOUT_MS);
    const result = (async () => {
        try {
            const provider = input.getProvider();
            if (!provider?.endpoint || !provider.modelName) return null;
            return await requestNotebookActions({
                provider,
                notebook: input.notebook,
                userMessage: input.userMessage,
                storyText: input.storyText,
                signal: controller.signal,
            });
        } catch (err) {
            if (!controller.signal.aborted) console.warn('[SceneNotebook] auxiliary update failed:', err);
            return null;
        } finally {
            clearTimeout(timer);
        }
    })();
    return { snapshotId: input.snapshotId, campaignId: input.campaignId, storyText: input.storyText, controller, result };
}

/**
 * Request the edits for a finished, not yet committed variant. Results are only
 * held; nothing is applied until commit takes the job for the committed text.
 */
export function prefetchNotebookUpdate(input: NotebookJobInput): void {
    if (!input.storyText.trim()) return;
    // A job from an older pending turn can never be committed now.
    for (const j of jobs) if (j.snapshotId !== input.snapshotId) j.controller.abort();
    jobs = jobs.filter(j => j.snapshotId === input.snapshotId);
    if (jobs.some(j => j.storyText === input.storyText)) return;
    jobs.push(startNotebookJob(input));
}

/** Remove and return the job for the committed text; every other job is aborted. */
export function takeNotebookJob(snapshotId: string, storyText: string): NotebookJob | undefined {
    const match = jobs.find(j => j.snapshotId === snapshotId && j.storyText === storyText);
    for (const j of jobs) if (j !== match) j.controller.abort();
    jobs = [];
    return match;
}

/** Drop every pending job (turn discarded, rewound, or a new turn started). */
export function cancelNotebookJobs(): void {
    for (const j of jobs) j.controller.abort();
    jobs = [];
}

export function pendingNotebookJobCount(): number {
    return jobs.length;
}

/**
 * Apply edits to the live notebook of `campaignId`. Skipped when another
 * campaign is open or the notebook is off. Returns whether anything changed.
 */
export function applyNotebookUpdateToStore(campaignId: string, actions: NotebookAction[]): boolean {
    if (actions.length === 0) return false;
    const store = storeAccess().getState();
    if (store.activeCampaignId !== campaignId) {
        console.warn('[SceneNotebook] campaign changed before the notebook update landed; dropped');
        return false;
    }
    if (store.context.notebookActive === false) return false;
    const before = store.context.notebook ?? [];
    const next = applyNotebookActions(before, actions);
    const changed = next.length !== before.length || next.some((n, i) => n !== before[i]);
    if (changed) {
        store.updateContext({ notebook: next });
        console.log(`[SceneNotebook] ${actions.length} edit(s) applied; ${next.length} notes active`);
    }
    return changed;
}

/**
 * Wait for a committed turn's job, up to `waitMs`, and apply its edits. A result
 * that arrives later still applies (to the same campaign only). Never rejects.
 */
export async function settleNotebookJob(job: NotebookJob, waitMs = NOTEBOOK_COMMIT_WAIT_MS): Promise<void> {
    const apply = (actions: NotebookAction[] | null) => {
        if (!actions) return;
        try { applyNotebookUpdateToStore(job.campaignId, actions); }
        catch (err) { console.warn('[SceneNotebook] apply failed:', err); }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), waitMs); });
    const first = await Promise.race([job.result, timedOut]);
    clearTimeout(timer);
    if (first === 'timeout') {
        console.warn('[SceneNotebook] update still running at commit; it will apply when it finishes');
        void job.result.then(apply);
        return;
    }
    apply(first);
}
