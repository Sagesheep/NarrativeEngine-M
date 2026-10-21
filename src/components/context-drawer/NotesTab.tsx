import { useState, useMemo } from 'react';
import { NotebookPen, Plus, Trash2, CornerUpRight, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { appConfirm } from '../ConfirmSheet';
import { makePlayerNote } from '../../utils/playerNotes';
import type { PlayerNote } from '../../types';

function formatDate(ts: number): string {
    try {
        return new Date(ts).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    } catch {
        return '';
    }
}

/** Read the latest notes at write time so quick edits never clobber each other. */
function writeNotes(fn: (notes: PlayerNote[]) => PlayerNote[]) {
    const { context, updateContext } = useAppStore.getState();
    updateContext({ playerNotes: fn(context.playerNotes ?? []) });
}

/** The player's own notes. Nothing here is sent to the GM or any other AI call. */
export function NotesTab() {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const notes = useAppStore(s => s.context.playerNotes);
    const messages = useAppStore(s => s.messages);
    const drawerOpen = useAppStore(s => s.drawerOpen);
    const toggleDrawer = useAppStore(s => s.toggleDrawer);
    const setMobileView = useAppStore(s => s.setMobileView);

    const [query, setQuery] = useState('');
    const [openId, setOpenId] = useState<string | null>(null);

    const visible = useMemo(() => {
        const list = [...(notes ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
        const q = query.trim().toLowerCase();
        if (!q) return list;
        return list.filter(n => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q));
    }, [notes, query]);

    const handleNew = () => {
        const note = makePlayerNote('', '');
        writeNotes(list => [note, ...list]);
        setQuery('');
        setOpenId(note.id);
    };

    const handleChange = (id: string, patch: Partial<Pick<PlayerNote, 'title' | 'body'>>) => {
        writeNotes(list => list.map(n => (n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n)));
    };

    const handleDelete = async (note: PlayerNote) => {
        if (await appConfirm({
            title: 'Delete note',
            body: `Delete "${note.title || 'Untitled'}"? This cannot be undone.`,
            confirmLabel: 'Delete',
            danger: true,
        })) {
            writeNotes(list => list.filter(n => n.id !== note.id));
            if (openId === note.id) setOpenId(null);
        }
    };

    const handleJump = (messageId: string) => {
        if (drawerOpen) toggleDrawer();
        setMobileView('chat');
        setTimeout(() => {
            const el = document.querySelector(`[data-message-id="${messageId}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 150);
    };

    if (!activeCampaignId) {
        return (
            <div className="p-6 text-center text-text-dim text-xs uppercase tracking-wider">
                No active campaign.
            </div>
        );
    }

    return (
        <div className="p-3">
            <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-bold uppercase tracking-widest text-terminal">
                    ◆ My Notes
                </span>
                <button
                    onClick={handleNew}
                    className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal transition-colors min-h-[32px] px-2"
                >
                    <Plus size={13} /> New
                </button>
            </div>
            <p className="text-[10px] text-text-dim leading-relaxed mb-3 opacity-70">
                Just for you — the GM never sees these. Save any chat message here with its notebook icon.
            </p>

            {(notes?.length ?? 0) > 0 && (
                <div className="relative mb-3">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-dim" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search notes"
                        className="w-full bg-void-darker border border-border rounded pl-7 pr-2 py-1.5 text-xs text-text-primary placeholder:text-text-dim focus:outline-none focus:border-terminal/50"
                    />
                </div>
            )}

            {(notes?.length ?? 0) === 0 && (
                <div className="p-6 text-center text-text-dim">
                    <NotebookPen size={28} className="mx-auto mb-3 opacity-50" />
                    <p className="text-xs uppercase tracking-wider mb-1">No notes yet</p>
                    <p className="text-[11px] leading-relaxed opacity-70">
                        Tap New, or tap the notebook icon on a message to save it — handy for answers to your OOC questions.
                    </p>
                </div>
            )}

            {(notes?.length ?? 0) > 0 && visible.length === 0 && (
                <p className="text-[11px] text-text-dim text-center py-4">No notes match.</p>
            )}

            <div className="flex flex-col gap-2">
                {visible.map(note => {
                    const isOpen = openId === note.id;
                    const sourceExists = !!note.sourceMessageId && messages.some(m => m.id === note.sourceMessageId);
                    return (
                        <div key={note.id} className="border border-border rounded bg-void-darker">
                            <button
                                onClick={() => setOpenId(isOpen ? null : note.id)}
                                className="w-full flex items-start gap-1.5 p-2 text-left"
                            >
                                {isOpen
                                    ? <ChevronDown size={13} className="mt-0.5 flex-shrink-0 text-terminal" />
                                    : <ChevronRight size={13} className="mt-0.5 flex-shrink-0 text-text-dim" />}
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs text-text-primary truncate">{note.title || 'Untitled'}</div>
                                    {!isOpen && note.body && (
                                        <div className="text-[11px] text-text-dim line-clamp-2 whitespace-pre-wrap">{note.body}</div>
                                    )}
                                    <div className="text-[9px] text-text-dim uppercase tracking-wider mt-0.5">{formatDate(note.updatedAt)}</div>
                                </div>
                            </button>

                            {isOpen && (
                                <div className="px-2 pb-2 flex flex-col gap-2">
                                    <input
                                        value={note.title}
                                        onChange={e => handleChange(note.id, { title: e.target.value })}
                                        placeholder="Title"
                                        className="w-full bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-dim focus:outline-none focus:border-terminal/50"
                                    />
                                    <textarea
                                        value={note.body}
                                        onChange={e => handleChange(note.id, { body: e.target.value })}
                                        placeholder="Write anything…"
                                        rows={8}
                                        className="w-full bg-void border border-border rounded px-2 py-1.5 text-xs text-text-primary leading-relaxed placeholder:text-text-dim focus:outline-none focus:border-terminal/50 resize-y"
                                    />
                                    <div className="flex items-center justify-end gap-3">
                                        {sourceExists && (
                                            <button
                                                onClick={() => handleJump(note.sourceMessageId!)}
                                                className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim hover:text-ice transition-colors min-h-[32px]"
                                            >
                                                <CornerUpRight size={13} /> Jump to message
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleDelete(note)}
                                            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim hover:text-red-400 transition-colors min-h-[32px]"
                                        >
                                            <Trash2 size={13} /> Delete
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
