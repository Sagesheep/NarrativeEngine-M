import { useState, useEffect, useCallback, useMemo } from 'react';
import { BookOpen, Plus, Loader2, Library } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../../services/apiClient';
import { ChapterCard } from './ChapterCard';
import { toast } from '../Toast';
import { countTokens } from '../../services/infrastructure';
import { runCombinedSeal, buildSealInputs, applySealResult } from '../../services/turn';
import { sealSceneBudget } from '../../services/archive';
import { relabelChapterFacts } from '../../services/campaign-state';
import type { ArchiveChapter } from '../../types';
import { applyActiveSlotThinking } from '../../store/slices/slotThinking';
import { bookOf, unbookedSealed } from '../../services/archive/bookEngine';
import { closeBookThrough, proposeBooksForExisting, buildBooks, regenerateBook, updateBook, removeLastBook } from '../../services/archive/bookService';
import { BookCard } from './BookCard';
import { appConfirm } from '../ConfirmSheet';

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

    const books = useAppStore(s => s.books);
    const setBooks = useAppStore(s => s.setBooks);
    const [bookBusy, setBookBusy] = useState<string | null>(null);

    const refreshChapters = useCallback(async () => {
        if (!activeCampaignId) return;
        const fresh = await api.chapters.list(activeCampaignId);
        setChapters(fresh);
        // Books are checked against the chapters on read (merge, split, rollback).
        setBooks(await api.books.list(activeCampaignId));
    }, [activeCampaignId, setChapters, setBooks]);

    useEffect(() => {
        refreshChapters();
    }, [refreshChapters]);

    // Book summaries are long-form writing: prefer the summarizer slot.
    const bookProvider = useCallback(() => {
        const live = useAppStore.getState();
        return live.getActiveSummarizerEndpoint?.() ?? live.getActiveUtilityEndpoint()
            ?? applyActiveSlotThinking(live.settings, 'utility', live.getActiveStoryEndpoint());
    }, []);

    // Chapters grouped under their book; chapters after the last book stay loose.
    const { bookGroups, looseChapters, endBookIds } = useMemo(() => {
        const groups = books.map(book => ({ book, chapters: chapters.filter(c => bookOf(c, [book])) }));
        const loose = chapters.filter(c => !bookOf(c, books));
        return { bookGroups: groups, looseChapters: loose, endBookIds: new Set(unbookedSealed(chapters, books).map(c => c.chapterId)) };
    }, [books, chapters]);

    const handleEndBook = useCallback(async (chapter: ArchiveChapter) => {
        if (!activeCampaignId) return;
        const loose = unbookedSealed(chapters, books);
        const count = loose.findIndex(c => c.chapterId === chapter.chapterId) + 1;
        if (!await appConfirm({
            title: 'End book here',
            body: `Bind ${count} chapter${count === 1 ? '' : 's'} (${loose[0]?.chapterId} – ${chapter.chapterId}) into a book. The AI writes the book's summary from the chapter summaries; the GM's recap then shows the book instead of each chapter. Unbind it later from the book card if needed.`,
            confirmLabel: 'Bind book',
        })) return;
        setBookBusy(chapter.chapterId);
        try {
            const next = await closeBookThrough(activeCampaignId, chapter.chapterId, bookProvider());
            if (next) {
                setBooks(next);
                const book = next[next.length - 1];
                if (book.summaryPending) toast.warning('Book bound, but the summary failed — use Rewrite Summary');
                else toast.success(`Book bound: ${book.title}`);
            }
        } catch (err) {
            console.error(err);
            toast.error('Failed to bind book');
        } finally {
            setBookBusy(null);
        }
    }, [activeCampaignId, chapters, books, bookProvider, setBooks]);

    const handleBuildBooks = useCallback(async () => {
        if (!activeCampaignId) return;
        setBookBusy('build');
        try {
            const provider = bookProvider();
            const { candidates, breaks } = await proposeBooksForExisting(activeCampaignId, provider);
            if (breaks.length === 0) {
                toast.info('No book to bind yet');
                return;
            }
            const groups: string[] = [];
            let from = 0;
            for (const end of breaks) {
                const to = candidates.findIndex(c => c.chapterId === end);
                const first = candidates[from];
                const last = candidates[to];
                groups.push(`• ${first.chapterId}–${end} (${to - from + 1}): "${first.title}" → "${last.title}"`);
                from = to + 1;
            }
            const left = candidates.length - from;
            if (!await appConfirm({
                title: `Build ${breaks.length} book${breaks.length === 1 ? '' : 's'}`,
                body: `Suggested books (split at story breaks, max 10 chapters each):\n\n${groups.join('\n')}${left > 0 ? `\n\n${left} newer chapter${left === 1 ? '' : 's'} stay loose until the current arc ends.` : ''}\n\nEach book gets an AI-written summary. You can unbind the newest book later and bind by hand with "End Book Here".`,
                confirmLabel: 'Build',
            })) return;
            const next = await buildBooks(activeCampaignId, breaks, provider, msg => toast.info(msg));
            setBooks(next);
            const pending = next.filter(b => b.summaryPending).length;
            toast.success(`${breaks.length} book${breaks.length === 1 ? '' : 's'} built${pending > 0 ? ` · ${pending} summary failed (Rewrite Summary)` : ''}`);
        } catch (err) {
            console.error(err);
            toast.error('Failed to build books');
        } finally {
            setBookBusy(null);
        }
    }, [activeCampaignId, bookProvider, setBooks]);

    const handleRegenerateBook = useCallback(async (bookId: string) => {
        if (!activeCampaignId) return;
        const provider = bookProvider();
        if (!provider) { toast.error('No AI provider available'); return; }
        setBookBusy(bookId);
        try {
            const next = await regenerateBook(activeCampaignId, bookId, provider);
            if (next) { setBooks(next); toast.success('Book summary rewritten'); }
            else toast.error('Book summary failed');
        } finally {
            setBookBusy(null);
        }
    }, [activeCampaignId, bookProvider, setBooks]);

    const handleSetEra = useCallback(async (bookId: string, era: string) => {
        if (!activeCampaignId) return;
        setBooks(await updateBook(activeCampaignId, bookId, { era: era || undefined }));
    }, [activeCampaignId, setBooks]);

    const handleUnbindBook = useCallback(async () => {
        if (!activeCampaignId) return;
        if (!await appConfirm({ title: 'Unbind book', body: 'Its chapters become loose again and its summary is discarded. The chapters themselves are untouched.', confirmLabel: 'Unbind', danger: true })) return;
        setBooks(await removeLastBook(activeCampaignId));
    }, [activeCampaignId, setBooks]);

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
                const goneId = merged.chapterId === idA ? idB : idA;
                const store = useAppStore.getState();
                store.setDivergenceRegister(relabelChapterFacts(store.divergenceRegister, goneId, () => merged.chapterId));
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
                const { chapterA, chapterB } = result;
                const splitAt = parseInt(chapterB.sceneRange[0], 10);
                const store = useAppStore.getState();
                store.setDivergenceRegister(relabelChapterFacts(store.divergenceRegister, chapterId,
                    e => parseInt(e.sceneRef, 10) >= splitAt ? chapterB.chapterId : chapterA.chapterId));
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
            const live = useAppStore.getState();
            const provider = live.getActiveUtilityEndpoint()
                ?? applyActiveSlotThinking(live.settings, 'utility', live.getActiveStoryEndpoint());
            if (!provider) {
                toast.error('No AI provider available');
                return;
            }

            const npcLedger = live.npcLedger ?? [];
            const { openThreads, existingTokens, currentFacts } = buildSealInputs(chapter, live.chapters, live.divergenceRegister);
            const sealResult = await runCombinedSeal(activeCampaignId, chapter, provider, npcLedger, live.archiveIndex, openThreads, existingTokens, currentFacts, sealSceneBudget(live.settings));

            // Same persistence as the auto-seal: replaces this chapter's old auto facts.
            const { merged, closed } = await applySealResult(activeCampaignId, chapter, sealResult, {
                npcLedger,
                getRegister: () => useAppStore.getState().divergenceRegister,
                setRegister: (reg) => useAppStore.getState().setDivergenceRegister(reg),
                setArchiveIndex: (entries) => useAppStore.getState().setArchiveIndex(entries),
            });

            if (merged > 0 || closed > 0) {
                toast.info(`${merged} facts extracted${closed > 0 ? ` · ${closed} promise${closed === 1 ? '' : 's'} closed` : ''}`);
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

    const renderChapter = (ch: ArchiveChapter) => {
        const idx = chapters.findIndex(c => c.chapterId === ch.chapterId);
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
                isNextAdjacent={idx < chapters.length - 1}
                onMergeWithNext={() => nextChapter && handleMerge(ch.chapterId, nextChapter.chapterId)}
                isProcessing={isRegenerating === ch.chapterId || bookBusy === ch.chapterId}
                isPinned={pinnedChapterIds.includes(ch.chapterId)}
                onTogglePin={() => pinChapter(ch.chapterId)}
                onDismissThread={(threadText) => handleDismissThread(ch.chapterId, threadText)}
                onEndBook={endBookIds.has(ch.chapterId) ? () => handleEndBook(ch) : undefined}
            />
        );
    };

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
                    <>
                        {endBookIds.size > 0 && (
                            <button
                                onClick={handleBuildBooks}
                                disabled={bookBusy !== null}
                                className="touch-btn w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded border border-dashed border-amber-500/40 text-amber-400 hover:bg-amber-500/10 text-[10px] font-bold uppercase disabled:opacity-50"
                                title="Group loose sealed chapters into books at story breaks (the AI suggests, you confirm)"
                            >
                                {bookBusy === 'build' ? <Loader2 size={12} className="animate-spin" /> : <Library size={12} />}
                                <span>Build Books ({endBookIds.size} loose chapter{endBookIds.size === 1 ? '' : 's'})</span>
                            </button>
                        )}
                        {bookGroups.map(({ book, chapters: inBook }, i) => (
                            <BookCard
                                key={book.bookId}
                                book={book}
                                chapterCount={inBook.length}
                                isLast={i === bookGroups.length - 1}
                                busy={bookBusy === book.bookId}
                                onSetEra={(era) => handleSetEra(book.bookId, era)}
                                onRegenerate={() => handleRegenerateBook(book.bookId)}
                                onUnbind={handleUnbindBook}
                            >
                                {inBook.map(renderChapter)}
                            </BookCard>
                        ))}
                        {looseChapters.map(renderChapter)}
                    </>
                )}
            </div>
        </div>
    );
}