import { useState, useEffect, useCallback, useMemo } from 'react';
import { BookOpen, Plus, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/apiClient';
import { ChapterCard } from './ChapterCard';
import { toast } from '../Toast';
import { countTokens } from '../../services/tokenizer';
import type { ArchiveChapter } from '../../types';

export function ChapterTab() {
    const { chapters, setChapters, activeCampaignId, context, messages, settings, condenser } = useAppStore();

    const ctxPct = useMemo(() => {
        const sysText = [
            context.loreRaw,
            context.rulesRaw,
            context.canonStateActive ? context.canonState : '',
            context.headerIndexActive ? context.headerIndex : '',
            context.starterActive ? context.starter : '',
            context.continuePromptActive ? context.continuePrompt : '',
            context.characterProfileActive ? context.characterProfile : '',
            context.inventoryActive ? context.inventory : '',
            condenser.condensedSummary,
        ].filter(Boolean).join('\n\n');
        const activeMessages = (condenser.condensedUpToIndex !== undefined && condenser.condensedUpToIndex >= 0)
            ? messages.slice(condenser.condensedUpToIndex + 1)
            : messages;
        const histText = activeMessages.map(m => m.content || '').join('');
        const used = countTokens(sysText) + countTokens(histText);
        return Math.round((used / settings.contextLimit) * 100);
    }, [context, messages, settings.contextLimit, condenser]);

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
        } catch (err) {
            toast.error('Failed to create chapter');
        } finally {
            setIsCreating(false);
        }
    }, [activeCampaignId, refreshChapters]);

    const handleRegenerate = useCallback(async (chapter: ArchiveChapter) => {
        if (!activeCampaignId) return;
        setIsRegenerating(chapter.chapterId);
        try {
            await api.chapters.update(activeCampaignId, chapter.chapterId, { invalidated: false });
            await refreshChapters();
            toast.success(`Summary refreshed for ${chapter.title}`);
        } catch (err) {
            console.error(err);
            toast.error(`Failed to regenerate summary for ${chapter.title}`);
        } finally {
            setIsRegenerating(prev => prev === chapter.chapterId ? null : prev);
        }
    }, [activeCampaignId, refreshChapters]);

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
                            />
                        );
                    })
                )}
            </div>
        </div>
    );
}