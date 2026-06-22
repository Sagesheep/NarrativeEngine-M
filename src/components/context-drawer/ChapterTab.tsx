import { useState, useEffect, useCallback, useMemo } from 'react';
import { BookOpen, Plus, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../../services/apiClient';
import { ChapterCard } from './ChapterCard';
import { toast } from '../Toast';
import { countTokens } from '../../services/infrastructure';
import { runCombinedSeal } from '../../services/turn';
import { mergeSealEntries } from '../../services/campaign-state';
import type { ArchiveChapter } from '../../types';

export function ChapterTab() {
    const {
        chapters,
        setChapters,
        activeCampaignId,
        pinnedChapterIds,
        pinChapter,
    } = useAppStore(useShallow(s => ({
        chapters: s.chapters,
        setChapters: s.setChapters,
        activeCampaignId: s.activeCampaignId,
        pinnedChapterIds: s.pinnedChapterIds,
        pinChapter: s.pinChapter,
    })));

    const context = useAppStore(s => s.context);
    const settings = useAppStore(s => s.settings);
    const messageContents = useAppStore(useShallow(s => {
        const activeMessages = (s.condenser.condensedUpToIndex !== undefined && s.condenser.condensedUpToIndex >= 0)
            ? s.messages.slice(s.condenser.condensedUpToIndex + 1)
            : s.messages;
        return activeMessages.map(m => m.content || '');
    }));

    const ctxPct = useMemo(() => {
        const sysText = [
            context.loreRaw,
            context.rulesRaw,
            context.starterActive ? context.starter : '',
            context.continuePromptActive ? context.continuePrompt : '',
            context.characterProfileActive ? (
                context.characterProfile.identity.name
                    ? `${context.characterProfile.identity.name}${context.characterProfile.activeTraits.filter(t => !t.superseded).length > 0 ? ` (${context.characterProfile.activeTraits.filter(t => !t.superseded).length} traits)` : ''}`
                    : ''
            ) : '',
            context.inventoryActive ? context.inventory : '',
        ].filter(Boolean).join('\n\n');
        const histText = messageContents.join('');
        const used = countTokens(sysText) + countTokens(histText);
        return Math.round((used / settings.contextLimit) * 100);
    }, [context, messageContents, settings.contextLimit]);

    const ctxColor = ctxPct >= 90 ? 'text-danger' : ctxPct >= 75 ? 'text-ember' : 'text-terminal';

    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [isRegenerating, setIsRegenerating] = useState<string | null>(null);
    const [isCreating, setIsCreating] = useState(false);

    const refreshChapters = useCallback(async () => {
        if (!activeCampaignId) return;
        const fresh = await api.chapters.list(activeCampaignId);
        setChapters(fresh);
    }, [activeCampaignId, setChapters]);

    useEffect(() => {
        refreshChapters();
    }, [refreshChapters]);

    const handleSeal = useCallback(async () => {
        if (!activeCampaignId) return;
        setIsCreating(true);
        try {
            const result = await api.chapters.seal(activeCampaignId);
            if (result) {
                await refreshChapters();
                toast.success('Chapter sealed');
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to seal chapter');
        } finally {
            setIsCreating(false);
        }
    }, [activeCampaignId, refreshChapters]);

    const handleRename = useCallback(async (chapterId: string, newTitle: string) => {
        if (!activeCampaignId) return;
        await api.chapters.update(activeCampaignId, chapterId, { title: newTitle });
        await refreshChapters();
    }, [activeCampaignId, refreshChapters]);

    const handleMerge = useCallback(async (idA: string, idB: string) => {
        if (!activeCampaignId) return;
        try {
            const merged = await api.chapters.merge(activeCampaignId, idA, idB);
            if (merged) {
                await refreshChapters();
                toast.success('Chapters merged');
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to merge chapters');
        }
    }, [activeCampaignId, refreshChapters]);

    const handleSplit = useCallback(async (chapterId: string, atSceneId: string) => {
        if (!activeCampaignId) return;
        try {
            const result = await api.chapters.split(activeCampaignId, chapterId, atSceneId);
            if (result) {
                await refreshChapters();
                toast.success('Chapter split');
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to split chapter');
        }
    }, [activeCampaignId, refreshChapters]);

    const handleNewChapter = useCallback(async () => {
        if (!activeCampaignId) return;
        setIsCreating(true);
        try {
            await api.chapters.create(activeCampaignId);
            await refreshChapters();
            toast.success('New chapter created');
        } catch {
            toast.error('Failed to create chapter');
        } finally {
            setIsCreating(false);
        }
    }, [activeCampaignId, refreshChapters]);

    const handleRegenerate = useCallback(async (chapter: ArchiveChapter) => {
        if (!activeCampaignId) return;
        setIsRegenerating(chapter.chapterId);
        try {
            const provider = useAppStore.getState().getActiveUtilityEndpoint()
                ?? useAppStore.getState().getActiveStoryEndpoint();
            if (!provider) {
                toast.error('No AI provider available');
                return;
            }

            const npcLedger = useAppStore.getState().npcLedger ?? [];
            const sealResult = await runCombinedSeal(activeCampaignId, chapter, provider, npcLedger);

            if (sealResult.summary) {
                await api.chapters.update(activeCampaignId, chapter.chapterId, {
                    title: sealResult.summary.title,
                    summary: sealResult.summary.summary,
                    keywords: sealResult.summary.keywords,
                    npcs: sealResult.summary.npcs,
                    majorEvents: sealResult.summary.majorEvents,
                    unresolvedThreads: sealResult.summary.unresolvedThreads,
                    tone: sealResult.summary.tone,
                    themes: sealResult.summary.themes,
                    invalidated: false,
                    ...(sealResult.summary.npcInnerState && { npcInnerState: sealResult.summary.npcInnerState }),
                });
            }

            if (sealResult.divergences.length > 0) {
                const liveRegister = useAppStore.getState().divergenceRegister;
                if (liveRegister) {
                    const sceneIds = chapter.sceneIds?.length
                        ? chapter.sceneIds
                        : [chapter.sceneRange[1]];
                    const merged = mergeSealEntries(liveRegister, sealResult.divergences, sceneIds[sceneIds.length - 1] ?? '000');
                    useAppStore.getState().setDivergenceRegister(merged);
                    toast.info(`${sealResult.divergences.length} divergence facts extracted`);
                }
            } else if (sealResult.divergenceParseError) {
                toast.warning('Chapter sealed but divergence facts failed to parse — try regenerating later');
            }

            await refreshChapters();

            if (sealResult.summary) {
                toast.success(`Regenerated ${chapter.title}`);
            } else {
                toast.error(`Failed to regenerate ${chapter.title}`);
            }
        } catch (err) {
            console.error(err);
            toast.error(`Failed to regenerate ${chapter.title}`);
        } finally {
            setIsRegenerating(prev => prev === chapter.chapterId ? null : prev);
        }
    }, [activeCampaignId, refreshChapters]);

    const handleDismissThread = useCallback(async (chapterId: string, threadText: string) => {
        if (!activeCampaignId) return;
        const chapter = chapters.find(c => c.chapterId === chapterId);
        if (!chapter) return;
        const existing = chapter.resolvedThreads ?? [];
        if (existing.includes(threadText)) return;
        const updated = [...existing, threadText];
        await api.chapters.update(activeCampaignId, chapterId, { resolvedThreads: updated });
        await refreshChapters();
    }, [activeCampaignId, chapters, refreshChapters]);

    return (
        <div className="flex flex-col gap-3 p-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                    <BookOpen size={16} className="text-terminal" />
                    <h3 className="text-sm font-bold uppercase tracking-wider text-terminal">
                        Chapters
                    </h3>
                    <span className="text-[10px] bg-void-dark px-1.5 py-0.5 rounded border border-border text-text-muted font-mono">
                        {chapters.length}
                    </span>
                    <span className={`text-[10px] font-mono ${ctxColor}`}>
                        CTX {ctxPct}%
                    </span>
                    {pinnedChapterIds.length > 0 && (
                        <span className="text-[10px] font-bold uppercase text-amber-400 bg-amber-400/10 border border-amber-400/30 px-1.5 py-0.5 rounded font-mono">
                            {pinnedChapterIds.length} PINNED
                        </span>
                    )}
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={handleSeal}
                        disabled={isCreating}
                        className="touch-btn flex items-center gap-1 px-2 py-1.5 rounded bg-ember/20 border border-ember/30 text-ember hover:bg-ember/30 transition-colors text-[10px] font-bold uppercase disabled:opacity-50"
                    >
                        <BookOpen size={12} />
                        <span>Seal</span>
                    </button>
                    <button
                        onClick={handleNewChapter}
                        disabled={isCreating}
                        className="touch-btn flex items-center gap-1 px-2 py-1.5 rounded bg-terminal/10 border border-terminal/30 text-terminal hover:bg-terminal/20 transition-colors text-[10px] font-bold uppercase disabled:opacity-50"
                    >
                        {isCreating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                        <span>New</span>
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2">
                {chapters.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center space-y-3 opacity-40">
                        <BookOpen size={48} strokeWidth={1} />
                        <p className="text-xs font-mono uppercase tracking-tighter">No chapters yet</p>
                        <p className="text-[10px]">Archive scenes to auto-generate chapters</p>
                    </div>
                ) : (
                    chapters.map((ch, idx) => {
                        const isNextAdjacent = idx < chapters.length - 1;
                        const nextChapter = chapters[idx + 1];

                        return (
                            <ChapterCard
                                key={ch.chapterId}
                                chapter={ch}
                                expanded={expandedId === ch.chapterId}
                                onToggle={() => setExpandedId(expandedId === ch.chapterId ? null : ch.chapterId)}
                                onSeal={handleSeal}
                                onRegenerate={() => handleRegenerate(ch)}
                                onRename={(title) => handleRename(ch.chapterId, title)}
                                onSplit={(sceneId) => handleSplit(ch.chapterId, sceneId)}
                                isNextAdjacent={isNextAdjacent}
                                onMergeWithNext={() => nextChapter && handleMerge(ch.chapterId, nextChapter.chapterId)}
                                isProcessing={isRegenerating === ch.chapterId}
                                isPinned={pinnedChapterIds.includes(ch.chapterId)}
                                onTogglePin={() => pinChapter(ch.chapterId)}
                                onDismissThread={(threadText) => handleDismissThread(ch.chapterId, threadText)}
                            />
                        );
                    })
                )}
            </div>
        </div>
    );
}