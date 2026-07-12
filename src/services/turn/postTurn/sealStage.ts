/**
 * Seal stage — extracted from turnPostProcess.ts (W10).
 */

import type { NPCEntry, ArchiveChapter, ArchiveIndexEntry, LLMProvider, WitnessSource } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnTypes';
import { api } from '../../apiClient';
import { notify } from '../../ports/notify';
import { shouldAutoSeal, sealChapter, sealChapterCombined, type CombinedSealResult } from '../../archive';
import { computeOpenThreads } from '../../payload/payloadWorldContext';
import { mergeSealEntries } from '../../campaign-state';
import { tierAllows } from '../aiTier';
import { tryWithFallback } from './witnessStage';

export async function runCombinedSeal(
    activeCampaignId: string, chapter: ArchiveChapter, provider: LLMProvider,
    npcLedger: NPCEntry[], archiveIndex?: ArchiveIndexEntry[], openThreads?: string[], existingSubjectTokens?: string[],
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
    return sealChapterCombined(provider, scenesContent, chapter.chapterId, chapter.title, sceneIds, npcInfo, indexEntries, 2, openThreads, existingSubjectTokens);
}

export async function handleSealChapter(state: TurnState, callbacks: TurnCallbacks, activeCampaignId: string, loadChapters: (campaignId: string) => Promise<ArchiveChapter[]>): Promise<void> {
    const currentChapters = await loadChapters(activeCampaignId);
    if (currentChapters.length > 0 && shouldAutoSeal(currentChapters).shouldSeal) {
        try {
            const result = sealChapter(currentChapters);
            if (!result) return;
            const sealed = result.sealedChapter;
            await api.chapters.update(activeCampaignId, sealed.chapterId, sealed);
            await api.chapters.create(activeCampaignId);
            const summarizerProvider = state.getFreshSummarizerProvider?.();
            const storyProvider = state.getFreshProvider();
            const sealProvider = summarizerProvider ?? storyProvider;
            if (sealProvider && tierAllows(state.settings.aiTier, 'sealChapter')) {
                const alreadySealedChapters = currentChapters.filter(c => c.sealedAt && c.chapterId !== sealed.chapterId);
                const openThreadsList = computeOpenThreads(alreadySealedChapters).map(t => t.text);
                const existingTokens = state.divergenceRegister ? Array.from(new Set(state.divergenceRegister.entries.map(e => e.subjectToken).filter((t): t is string => typeof t === 'string' && t.length > 0))) : undefined;
                const sealResult = await tryWithFallback('SealChapter',
                    () => runCombinedSeal(activeCampaignId, sealed, summarizerProvider ?? storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreadsList, existingTokens),
                    () => runCombinedSeal(activeCampaignId, sealed, storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreadsList, existingTokens));
                if (sealResult.summary) {
                    await api.chapters.update(activeCampaignId, sealed.chapterId, {
                        title: sealResult.summary.title, summary: sealResult.summary.summary, keywords: sealResult.summary.keywords,
                        npcs: sealResult.summary.npcs, majorEvents: sealResult.summary.majorEvents,
                        unresolvedThreads: sealResult.summary.unresolvedThreads, tone: sealResult.summary.tone, themes: sealResult.summary.themes,
                        ...(sealResult.summary.npcInnerState && { npcInnerState: sealResult.summary.npcInnerState }),
                        ...(sealResult.resolvedThreads && sealResult.resolvedThreads.length > 0 && { resolvedThreads: sealResult.resolvedThreads }),
                    });
                }
                if (sealResult.witnessCorrections && Object.keys(sealResult.witnessCorrections).length > 0) {
                    try {
                        const index = await api.archive.getIndex(activeCampaignId);
                        let corrected = false;
                        for (const entry of index) {
                            const corrections = sealResult.witnessCorrections[entry.sceneId];
                            if (corrections) {
                                const npcLedger = state.npcLedger ?? [];
                                const validIds = corrections.filter((id: string) => npcLedger.some(n => n.id === id));
                                if (validIds.length > 0) { entry.npcsWitnessed = validIds; entry.witnessSource = 'seal_correction' as WitnessSource; corrected = true; }
                            }
                        }
                        if (corrected) {
                            const { offlineStorage } = await import('../../storage');
                            await offlineStorage.archive.updateIndex(activeCampaignId, index);
                            callbacks.setArchiveIndex([...index]);
                        }
                    } catch (e) { console.warn('[CombinedSeal] Failed to apply witness corrections:', e); }
                }
                if (sealResult.sceneEventMap && Object.keys(sealResult.sceneEventMap).length > 0) {
                    try {
                        const index = await api.archive.getIndex(activeCampaignId);
                        let eventCount = 0;
                        for (const entry of index) {
                            const events = sealResult.sceneEventMap[entry.sceneId];
                            if (events && events.length > 0) { entry.events = events; eventCount++; }
                        }
                        if (eventCount > 0) {
                            const { offlineStorage } = await import('../../storage');
                            await offlineStorage.archive.updateIndex(activeCampaignId, index);
                            callbacks.setArchiveIndex([...index]);
                        }
                    } catch (e) { console.warn('[Seal] Failed to persist scene events:', e); }
                }
                const liveRegister = state.divergenceRegister;
                if (sealResult.divergences.length > 0 && liveRegister && callbacks.setDivergenceRegister) {
                    const sceneIds = sealed.sceneIds?.length ? sealed.sceneIds : [sealed.sceneRange[1]];
                    const merged = mergeSealEntries(liveRegister, sealResult.divergences, sceneIds[sceneIds.length - 1] ?? '000');
                    callbacks.setDivergenceRegister(merged);
                } else if (sealResult.divergenceParseError) {
                    notify.warning('Chapter sealed but divergence facts failed to parse');
                }
            }
            const updatedChapters = await loadChapters(activeCampaignId);
            if (callbacks.setChapters) callbacks.setChapters(updatedChapters);
            notify.success('Chapter sealed');
        } catch (err) {
            console.error('[SealChapter] Failed to seal chapter:', err);
            notify.error('Failed to seal chapter');
        }
    }
}
