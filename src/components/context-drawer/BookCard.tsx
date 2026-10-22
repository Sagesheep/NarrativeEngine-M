import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Library, RefreshCcw, Unlink, Check, Loader2 } from 'lucide-react';
import type { ArchiveBook } from '../../types';

/**
 * A book: a run of sealed chapters with its own summary. Collapsed it shows the
 * title, era and range; expanded it shows the summary, era editing and its
 * chapters (passed as children).
 */
export function BookCard({ book, chapterCount, children, isLast, busy, onSetEra, onRegenerate, onUnbind }: {
    book: ArchiveBook;
    chapterCount: number;
    children: ReactNode;
    /** Only the newest book can be unbound — books stay contiguous. */
    isLast: boolean;
    busy: boolean;
    onSetEra: (era: string) => void;
    onRegenerate: () => void;
    onUnbind: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [showChapters, setShowChapters] = useState(false);
    const [era, setEra] = useState(book.era ?? '');

    return (
        <div className="border border-amber-500/30 rounded bg-amber-500/5">
            <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-2 py-1.5 text-left">
                <Library size={14} className="text-amber-400 shrink-0" />
                <span className="flex-1 min-w-0">
                    <span className="text-xs font-bold text-text-primary">{book.title}</span>
                    {book.era && <span className="ml-1.5 text-[9px] font-mono text-amber-400 bg-amber-500/10 px-1 rounded">{book.era}</span>}
                    {book.summaryPending && <span className="ml-1.5 text-[9px] uppercase font-bold text-ice">summary pending</span>}
                    <span className="block text-[9px] font-mono text-text-dim">
                        {book.bookId} · {chapterCount} chapter{chapterCount === 1 ? '' : 's'} · scenes {book.sceneRange[0]}–{book.sceneRange[1]}
                    </span>
                </span>
                {open ? <ChevronUp size={14} className="text-text-dim" /> : <ChevronDown size={14} className="text-text-dim" />}
            </button>

            {open && (
                <div className="px-2 pb-2 space-y-2">
                    <p className="text-[11px] text-text-secondary whitespace-pre-wrap">{book.summary}</p>
                    {book.unresolvedThreads.length > 0 && (
                        <div className="text-[10px] text-text-dim">
                            <span className="uppercase font-bold">Open at the end: </span>{book.unresolvedThreads.join(' · ')}
                        </div>
                    )}

                    <div className="flex items-center gap-1">
                        <span className="text-[9px] uppercase text-text-dim">Era</span>
                        <input
                            type="text"
                            value={era}
                            onChange={e => setEra(e.target.value)}
                            placeholder="e.g. P3 · 2009"
                            className="flex-1 min-w-0 bg-void border border-border text-text-primary text-[16px] md:text-[11px] px-1.5 py-0.5 rounded outline-none focus:border-amber-500"
                        />
                        <button
                            onClick={() => onSetEra(era.trim())}
                            disabled={era.trim() === (book.era ?? '')}
                            className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-30"
                            title="Save era"
                        >
                            <Check size={12} />
                        </button>
                    </div>

                    <div className="flex items-center gap-1 flex-wrap">
                        <button
                            onClick={onRegenerate}
                            disabled={busy}
                            className="touch-btn flex items-center gap-1 px-2 py-1 rounded bg-void-dark border border-border hover:border-terminal hover:text-terminal text-text-secondary text-[10px] font-bold uppercase disabled:opacity-50"
                        >
                            {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCcw size={11} />}
                            <span>Rewrite Summary</span>
                        </button>
                        {isLast && (
                            <button
                                onClick={onUnbind}
                                disabled={busy}
                                className="touch-btn flex items-center gap-1 px-2 py-1 rounded bg-void-dark border border-border hover:border-red-400 hover:text-red-400 text-text-secondary text-[10px] font-bold uppercase disabled:opacity-50"
                                title="Unbind this book: its chapters become loose again"
                            >
                                <Unlink size={11} />
                                <span>Unbind</span>
                            </button>
                        )}
                        <button
                            onClick={() => setShowChapters(!showChapters)}
                            className="ml-auto text-[10px] uppercase font-bold text-terminal hover:underline"
                        >
                            {showChapters ? 'Hide chapters' : `Show ${chapterCount} chapters`}
                        </button>
                    </div>

                    {showChapters && <div className="space-y-2 pl-2 border-l border-amber-500/20">{children}</div>}
                </div>
            )}
        </div>
    );
}
