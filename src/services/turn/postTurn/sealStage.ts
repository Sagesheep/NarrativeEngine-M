/**
 * Seal stage — extracted from turnPostProcess.ts (W10).
 */

import type { NPCEntry, ArchiveChapter, ArchiveIndexEntry, DivergenceEntry, DivergenceRegister, LLMProvider, WitnessSource } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnTypes';
import { api } from '../../apiClient';
import { notify } from '../../ports/notify';
import { shouldAutoSeal, sealChapter, sealChapterCombined, sealSceneBudget, type CombinedSealResult } from '../../archive';
import { computeOpenThreads } from '../../payload/payloadWorldContext';
import { replaceChapterFacts, resolvePromises } from '../../campaign-state';
import { tierAllows } from '../aiTier';
import { tryWithFallback } from './witnessStage';
import { autoCloseBookIfDue } from '../../archive/bookService';

export async function runCombinedSeal(
    activeCampaignId: string, chapter: ArchiveChapter, provider: LLMProvider,
    npcLedger: NPCEntry[], archiveIndex?: ArchiveIndexEntry[], openThreads?: string[], existingSubjectTokens?: string[],
    activeStateFacts: DivergenceEntry[] = [],
    sceneBudget?: number,
): Promise<CombinedSealResult> {
    const allScenes = await api.archive.getIndex(activeCampaignId);
    const startNum = parseInt(chapter.sceneRange[0], 10);
    const endNum = parseInt(chapter.sceneRange[1], 10);
    const chapterScenes = allScenes.filter(s => { const sn = parseInt(s.sceneId); return sn >= startNum && sn <= endNum; });
    if (chapterScenes.length === 0) return { summary: null, divergences: [] };
    const chapterSceneIds = chapterScenes.map(s => s.sceneId);
    const fullScenes = await api.archive.getScenes(activeCampaignId, chapterSceneIds);
    const contentById = new Map(fullScenes.map(s => [s.sceneId, s.content]));
    const scenesContent = chapterScenes.map(s => ({ sceneId: s.sceneId, content: contentById.get(s.sceneId) ?? s.userSnippet ?? '' }));
    const sceneIds = chapter.sceneIds?.length ? chapter.sceneIds : Array.from({ length: endNum - startNum + 1 }, (_, i) => String(startNum + i).padStart(3, '0'));
    const npcInfo = npcLedger.map(n => ({ id: n.id, name: n.name, aliases: n.aliases ?? '' }));
    const indexEntries = archiveIndex ? archiveIndex.filter(e => { const sn = parseInt(e.sceneId); return sn >= startNum && sn <= endNum; }).map(e => ({ sceneId: e.sceneId, npcsWitnessed: e.npcsWitnessed })) : undefined;
    return sealChapterCombined(provider, scenesContent, chapter.chapterId, chapter.title, sceneIds, npcInfo, indexEntries, 2, openThreads, existingSubjectTokens, activeStateFacts, sceneBudget);
}

/** Prompt inputs beyond the scenes: threads left open by EARLIER sealed chapters,
 *  the register's subject tokens, and the current facts (for slot keys). Shared by
 *  the auto-seal and the Chapters tab's Regenerate so both send the same prompt. */
export function buildSealInputs(chapter: ArchiveChapter, chapters: ArchiveChapter[], register: DivergenceRegister | undefined) {
    const start = parseInt(chapter.sceneRange[0], 10);
    const earlierSealed = chapters.filter(c => c.sealedAt && c.chapterId !== chapter.chapterId && parseInt(c.sceneRange[0], 10) < start);
    const entries = register?.entries ?? [];
    const tokens = Array.from(new Set(entries.map(e => e.subjectToken).filter((t): t is string => typeof t === 'string' && t.length > 0)));
    return {
        openThreads: computeOpenThreads(earlierSealed).map(t => t.text),
        existingTokens: register ? tokens : undefined,
        currentFacts: entries,
    };
}

export type SealApplyDeps = {
    npcLedger: NPCEntry[];
    /** Read at merge time — never a snapshot from before the AI call. */
    getRegister: () => DivergenceRegister | undefined;
    setRegister?: (register: DivergenceRegister) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
};

/**
 * Persist a seal result: chapter summary, witness corrections, scene events, and
 * the chapter's facts (replacing its previous auto facts, so a re-seal or
 * Regenerate never duplicates them). A missing summary marks the chapter
 * invalidated so the Chapters tab offers Regenerate. Earlier promises the
 * chapter settled are closed. Returns facts merged and promises closed.
 */
export async function applySealResult(activeCampaignId: string, chapter: ArchiveChapter, sealResult: CombinedSealResult, deps: SealApplyDeps): Promise<{ merged: number; closed: number }> {
    if (sealResult.summary) {
        await api.chapters.update(activeCampaignId, chapter.chapterId, {
            title: sealResult.summary.title, summary: sealResult.summary.summary, keywords: sealResult.summary.keywords,
            npcs: sealResult.summary.npcs, majorEvents: sealResult.summary.majorEvents,
            unresolvedThreads: sealResult.summary.unresolvedThreads, tone: sealResult.summary.tone, themes: sealResult.summary.themes,
            invalidated: false,
            ...(sealResult.summary.npcInnerState && { npcInnerState: sealResult.summary.npcInnerState }),
            ...(sealResult.resolvedThreads && sealResult.resolvedThreads.length > 0 && { resolvedThreads: sealResult.resolvedThreads }),
        });
    } else {
        await api.chapters.update(activeCampaignId, chapter.chapterId, { invalidated: true });
    }

    const corrections = sealResult.witnessCorrections ?? {};
    const sceneEvents = sealResult.sceneEventMap ?? {};
    if (Object.keys(corrections).length > 0 || Object.keys(sceneEvents).length > 0) {
        try {
            const index = await api.archive.getIndex(activeCampaignId);
            let changed = false;
            for (const entry of index) {
                const validIds = (corrections[entry.sceneId] ?? []).filter((id: string) => deps.npcLedger.some(n => n.id === id));
                if (validIds.length > 0) { entry.npcsWitnessed = validIds; entry.witnessSource = 'seal_correction' as WitnessSource; changed = true; }
                const events = sceneEvents[entry.sceneId];
                if (events && events.length > 0) { entry.events = events; changed = true; }
            }
            if (changed) {
                const { offlineStorage } = await import('../../storage');
                await offlineStorage.archive.updateIndex(activeCampaignId, index);
                deps.setArchiveIndex([...index]);
            }
        } catch (e) { console.warn('[Seal] Failed to apply witness corrections / scene events:', e); }
    }

    const liveRegister = deps.getRegister();
    const closures = sealResult.closedPromises ?? [];
    if (!liveRegister || !deps.setRegister || (sealResult.divergences.length === 0 && closures.length === 0)) return { merged: 0, closed: 0 };
    const sceneIds = chapter.sceneIds?.length ? chapter.sceneIds : [chapter.sceneRange[1]];
    const replaced = replaceChapterFacts(liveRegister, chapter.chapterId, sealResult.divergences, sceneIds[sceneIds.length - 1] ?? '000');
    const { register, resolved } = resolvePromises(replaced, closures, chapter.chapterId);
    if (register !== liveRegister) deps.setRegister(register);
    return { merged: sealResult.divergences.length, closed: resolved };
}

export async function handleSealChapter(state: TurnState, callbacks: TurnCallbacks, activeCampaignId: string, loadChapters: (campaignId: string) => Promise<ArchiveChapter[]>): Promise<void> {
    const currentChapters = await loadChapters(activeCampaignId);
    if (currentChapters.length > 0 && shouldAutoSeal(currentChapters).shouldSeal) {
        const getRegister = () => callbacks.getDivergenceRegister?.() ?? state.divergenceRegister;
        let sealed: ArchiveChapter | undefined;
        try {
            const result = sealChapter(currentChapters);
            if (!result) return;
            const chapter = result.sealedChapter;
            await api.chapters.update(activeCampaignId, chapter.chapterId, chapter);
            sealed = chapter;
            await api.chapters.create(activeCampaignId);
            const summarizerProvider = state.getFreshSummarizerProvider?.();
            const storyProvider = state.getFreshProvider();
            const sealProvider = summarizerProvider ?? storyProvider;
            if (sealProvider && tierAllows(state.settings.aiTier, 'sealChapter')) {
                const { openThreads, existingTokens, currentFacts } = buildSealInputs(chapter, currentChapters, getRegister());
                const sceneBudget = sealSceneBudget(state.settings);
                const sealResult = await tryWithFallback('SealChapter',
                    () => runCombinedSeal(activeCampaignId, chapter, summarizerProvider ?? storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreads, existingTokens, currentFacts, sceneBudget),
                    () => runCombinedSeal(activeCampaignId, chapter, storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreads, existingTokens, currentFacts, sceneBudget));
                const { merged } = await applySealResult(activeCampaignId, chapter, sealResult, {
                    npcLedger: state.npcLedger ?? [],
                    getRegister,
                    setRegister: callbacks.setDivergenceRegister,
                    setArchiveIndex: callbacks.setArchiveIndex,
                });
                if (!sealResult.summary) notify.warning('Chapter sealed without a summary — Regenerate it from the Chapters tab');
                else if (merged === 0 && sealResult.divergenceParseError) notify.warning('Chapter sealed but divergence facts failed to parse');
            }
            const updatedChapters = await loadChapters(activeCampaignId);
            if (callbacks.setChapters) callbacks.setChapters(updatedChapters);
            notify.success('Chapter sealed');
            // Same background step as the seal, so the prompt changes once, not twice.
            const aiForBook = sealProvider && tierAllows(state.settings.aiTier, 'sealChapter') ? sealProvider : undefined;
            const books = await autoCloseBookIfDue(activeCampaignId, updatedChapters, aiForBook).catch(e => { console.warn('[Books] Auto-close failed:', e); return null; });
            if (books) {
                callbacks.setBooks?.(books);
                notify.success(`Book closed: ${books[books.length - 1].title}`);
            }
        } catch (err) {
            console.error('[SealChapter] Failed to seal chapter:', err);
            // Sealed but the AI pass failed: flag it so Regenerate is offered instead
            // of an empty summary silently standing in for the chapter.
            if (sealed) {
                await api.chapters.update(activeCampaignId, sealed.chapterId, { invalidated: true }).catch(() => {});
                const updatedChapters = await loadChapters(activeCampaignId).catch(() => null);
                if (updatedChapters && callbacks.setChapters) callbacks.setChapters(updatedChapters);
            }
            notify.error('Failed to seal chapter');
        }
    }
}
