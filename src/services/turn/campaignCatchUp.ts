/**
 * Campaign catch-up — runs the bookkeeping a Lite-tier campaign skipped, over
 * the history already played. Lite still archives every scene and seals chapters
 * on schedule, but writes no chapter summaries, story facts, NPC suggestions, PC
 * facts or book summaries. This pass fills them in, in story order:
 *
 *   1. Chapters: every sealed chapter without a summary (or flagged invalidated)
 *      gets the same combined seal as a Pro auto-seal. Oldest first, re-reading
 *      the chapter list each time so a chapter sees the threads its predecessors
 *      left open.
 *   2. NPCs: names the archived scenes mention at least twice, not yet on the
 *      ledger, filtered by the NPC validator and added as suggestions (the player
 *      accepts them from the NPC ledger; nothing is created here).
 *   3. PC: one profile + PC-fact scan and one inventory scan over recent messages.
 *   4. Books: books bound without a summary get one.
 *
 * Every model call goes to the caller's provider, meant to be the utility slot —
 * never the story model. Already-done work is skipped, so a cancelled or failed
 * run picks up where it stopped when started again.
 */

import type { ArchiveBook, ArchiveChapter, ArchiveIndexEntry, CharacterProfileState, ChatMessage, DivergenceRegister, GameContext, LLMProvider, NPCEntry } from '../../types';
import type { TurnCallbacks } from './turnTypes';
import { api } from '../apiClient';
import { sealSceneBudget } from '../archive';
import { regenerateBook } from '../archive/bookService';
import { scanCharacterProfileWithPcState, scanInventory } from '../campaign-state';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates, isFactMaintenanceEligible, resolvePcStateUpdate, buildPcStateSection } from '../npc';
import { runCombinedSeal, buildSealInputs, applySealResult } from './postTurn/sealStage';
import { applyPcFactPatch } from './postTurn/bookkeepingStage';

/** A name must appear in this many scenes to be suggested. */
const NPC_MIN_SCENES = 2;
/** Cap on names sent to the validator, most-mentioned first. */
const NPC_MAX_CANDIDATES = 60;
/** Names per validator call; small enough that every name's snippet fits its context window. */
const NPC_VALIDATE_BATCH = 12;
const SCENE_FETCH_BATCH = 50;

export type CatchUpStep = 'chapters' | 'npcs' | 'pc' | 'books';

export type CatchUpProgress = { step: CatchUpStep; label: string; done: number; total: number };

export type CatchUpPlan = {
    chapters: ArchiveChapter[];
    books: ArchiveBook[];
    sceneCount: number;
};

export type CatchUpReport = {
    chaptersDone: number;
    chaptersFailed: number;
    npcsSuggested: number;
    pcScanned: boolean;
    inventoryScanned: boolean;
    booksDone: number;
    booksFailed: number;
    cancelled: boolean;
};

export type CatchUpCancel = { cancelled: boolean };

export type CatchUpDeps = {
    campaignId: string;
    provider: LLMProvider;
    sceneBudgetSettings: Parameters<typeof sealSceneBudget>[0];
    getNpcLedger: () => NPCEntry[];
    getRegister: () => DivergenceRegister | undefined;
    setRegister: (register: DivergenceRegister) => void;
    getArchiveIndex: () => ArchiveIndexEntry[];
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    setChapters: (chapters: ArchiveChapter[]) => void;
    setBooks: (books: ArchiveBook[]) => void;
    addNpcSuggestions: (names: string[], context?: string) => void;
    getMessages: () => ChatMessage[];
    getContext: () => GameContext;
    updateContext: (patch: Partial<GameContext>) => void;
} & Pick<TurnCallbacks, 'updateNPC' | 'getNpc'>;

/** A sealed chapter Lite left without a summary, or one whose AI pass failed. */
export function needsCatchUp(chapter: ArchiveChapter): boolean {
    return !!chapter.sealedAt && (!!chapter.invalidated || !chapter.summary?.trim());
}

function byStart(a: ArchiveChapter, b: ArchiveChapter): number {
    return parseInt(a.sceneRange[0], 10) - parseInt(b.sceneRange[0], 10);
}

export async function planCatchUp(campaignId: string): Promise<CatchUpPlan> {
    const [chapters, books, index] = await Promise.all([
        api.chapters.list(campaignId), api.books.list(campaignId), api.archive.getIndex(campaignId),
    ]);
    return {
        chapters: chapters.filter(needsCatchUp).sort(byStart),
        books: books.filter(b => b.summaryPending),
        sceneCount: index.length,
    };
}

/**
 * Names mentioned in at least NPC_MIN_SCENES scenes and not on the ledger, most
 * mentioned first, each with a short snippet from its first mention.
 */
export function collectNpcCandidates(scenes: { sceneId: string; content: string }[], ledger: NPCEntry[]): { name: string; count: number; snippet: string }[] {
    const tally = new Map<string, { name: string; count: number; snippet: string }>();
    for (const scene of scenes) {
        const { newNames } = classifyNPCNames(extractNPCNames(scene.content), ledger);
        for (const name of new Set(newNames)) {
            const key = name.toLowerCase();
            const hit = tally.get(key);
            if (hit) { hit.count++; continue; }
            const at = Math.max(0, scene.content.indexOf(name));
            const snippet = scene.content.slice(Math.max(0, at - 30), at + name.length + 40).replace(/\s+/g, ' ').trim();
            tally.set(key, { name, count: 1, snippet });
        }
    }
    return [...tally.values()]
        .filter(c => c.count >= NPC_MIN_SCENES)
        .sort((a, b) => b.count - a.count)
        .slice(0, NPC_MAX_CANDIDATES);
}

async function catchUpChapters(deps: CatchUpDeps, cancel: CatchUpCancel, onProgress: (p: CatchUpProgress) => void, report: CatchUpReport): Promise<void> {
    const attempted = new Set<string>();
    let total = (await api.chapters.list(deps.campaignId)).filter(needsCatchUp).length;
    while (!cancel.cancelled) {
        const chapters = await api.chapters.list(deps.campaignId);
        const chapter = chapters.filter(c => needsCatchUp(c) && !attempted.has(c.chapterId)).sort(byStart)[0];
        if (!chapter) break;
        attempted.add(chapter.chapterId);
        total = Math.max(total, attempted.size);
        onProgress({ step: 'chapters', label: `Summarising ${chapter.chapterId} · ${chapter.title}`, done: attempted.size - 1, total });
        try {
            const npcLedger = deps.getNpcLedger();
            const { openThreads, existingTokens, currentFacts } = buildSealInputs(chapter, chapters, deps.getRegister());
            const result = await runCombinedSeal(deps.campaignId, chapter, deps.provider, npcLedger, deps.getArchiveIndex(),
                openThreads, existingTokens, currentFacts, sealSceneBudget(deps.sceneBudgetSettings));
            await applySealResult(deps.campaignId, chapter, result, {
                npcLedger, getRegister: deps.getRegister, setRegister: deps.setRegister, setArchiveIndex: deps.setArchiveIndex,
            });
            if (result.summary) report.chaptersDone++; else report.chaptersFailed++;
        } catch (e) {
            console.warn(`[CatchUp] ${chapter.chapterId} failed:`, e);
            report.chaptersFailed++;
        }
        deps.setChapters(await api.chapters.list(deps.campaignId));
    }
}

async function catchUpNpcs(deps: CatchUpDeps, cancel: CatchUpCancel, onProgress: (p: CatchUpProgress) => void, report: CatchUpReport): Promise<void> {
    const index = await api.archive.getIndex(deps.campaignId);
    const scenes: { sceneId: string; content: string }[] = [];
    for (let i = 0; i < index.length && !cancel.cancelled; i += SCENE_FETCH_BATCH) {
        onProgress({ step: 'npcs', label: `Reading scenes ${i + 1}–${Math.min(i + SCENE_FETCH_BATCH, index.length)} / ${index.length}`, done: 0, total: 1 });
        scenes.push(...await api.archive.getScenes(deps.campaignId, index.slice(i, i + SCENE_FETCH_BATCH).map(e => e.sceneId)));
    }
    if (cancel.cancelled) return;
    const candidates = collectNpcCandidates(scenes, deps.getNpcLedger());
    const batches = Math.ceil(candidates.length / NPC_VALIDATE_BATCH);
    for (let b = 0; b < batches && !cancel.cancelled; b++) {
        const batch = candidates.slice(b * NPC_VALIDATE_BATCH, (b + 1) * NPC_VALIDATE_BATCH);
        onProgress({ step: 'npcs', label: `Checking names ${b * NPC_VALIDATE_BATCH + 1}–${b * NPC_VALIDATE_BATCH + batch.length} / ${candidates.length}`, done: b, total: batches });
        try {
            const context = batch.map(c => `${c.name}: …${c.snippet}…`).join('\n');
            const valid = new Set((await validateNPCCandidates(deps.provider, batch.map(c => c.name), context)).map(n => n.toLowerCase()));
            for (const c of batch) {
                if (!valid.has(c.name.toLowerCase())) continue;
                deps.addNpcSuggestions([c.name], c.snippet);
                report.npcsSuggested++;
            }
        } catch (e) {
            console.warn('[CatchUp] NPC validation batch failed:', e);
        }
    }
}

async function catchUpPc(deps: CatchUpDeps, cancel: CatchUpCancel, onProgress: (p: CatchUpProgress) => void, report: CatchUpReport): Promise<void> {
    const messages = deps.getMessages();
    if (messages.length === 0) return;
    const context = deps.getContext();
    const pc = deps.getNpcLedger().find(isFactMaintenanceEligible);
    const profileOn = context.characterProfileActive || (!!pc && !context.characterProfileUserDisabled);
    if (profileOn || pc) {
        onProgress({ step: 'pc', label: 'Updating character profile and PC facts', done: 0, total: 2 });
        try {
            const profile: CharacterProfileState = context.characterProfile ?? { identity: {}, activeTraits: [] };
            const { profile: next, pcStateUpdate } = await scanCharacterProfileWithPcState(
                deps.provider, messages, profile, pc ? buildPcStateSection(pc) : undefined);
            if (profileOn) deps.updateContext({ characterProfile: next });
            if (pc) applyPcFactPatch(pc, resolvePcStateUpdate(pcStateUpdate, pc, messages), deps);
            report.pcScanned = true;
        } catch (e) {
            console.warn('[CatchUp] Profile scan failed:', e);
        }
    }
    if (cancel.cancelled || !context.inventoryActive) return;
    onProgress({ step: 'pc', label: 'Updating inventory', done: 1, total: 2 });
    try {
        const inventory = await scanInventory(deps.provider, messages, deps.getContext().inventory);
        deps.updateContext({ inventory });
        report.inventoryScanned = true;
    } catch (e) {
        console.warn('[CatchUp] Inventory scan failed:', e);
    }
}

async function catchUpBooks(deps: CatchUpDeps, cancel: CatchUpCancel, onProgress: (p: CatchUpProgress) => void, report: CatchUpReport): Promise<void> {
    const pending = (await api.books.list(deps.campaignId)).filter(b => b.summaryPending);
    for (let i = 0; i < pending.length && !cancel.cancelled; i++) {
        onProgress({ step: 'books', label: `Summarising book ${pending[i].title}`, done: i, total: pending.length });
        try {
            const next = await regenerateBook(deps.campaignId, pending[i].bookId, deps.provider);
            if (next) { deps.setBooks(next); report.booksDone++; } else report.booksFailed++;
        } catch (e) {
            console.warn(`[CatchUp] Book ${pending[i].bookId} failed:`, e);
            report.booksFailed++;
        }
    }
}

export async function runCatchUp(deps: CatchUpDeps, cancel: CatchUpCancel, onProgress: (p: CatchUpProgress) => void): Promise<CatchUpReport> {
    const report: CatchUpReport = {
        chaptersDone: 0, chaptersFailed: 0, npcsSuggested: 0, pcScanned: false, inventoryScanned: false,
        booksDone: 0, booksFailed: 0, cancelled: false,
    };
    // Books summarise chapter summaries, so they go after the chapters.
    const steps = [catchUpChapters, catchUpNpcs, catchUpPc, catchUpBooks];
    for (const step of steps) {
        if (cancel.cancelled) break;
        await step(deps, cancel, onProgress, report);
    }
    report.cancelled = cancel.cancelled;
    return report;
}
