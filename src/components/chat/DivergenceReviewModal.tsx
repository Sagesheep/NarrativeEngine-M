import { useState, useEffect, useRef } from 'react';
import { Loader2, Zap, Check, X } from 'lucide-react';
import type { ChatMessage, ArchiveIndexEntry, DivergenceRegister, DivergenceEntry, DivergenceCategory, LLMProvider } from '../../types';
import { extractFromMessageBatch, buildSceneMap } from '../../services/divergenceRegister';
import { uid } from '../../utils/uid';
import { toast } from '../Toast';

type DivergenceReviewModalProps = {
    messages: ChatMessage[];
    archiveIndex: ArchiveIndexEntry[];
    currentRegister: DivergenceRegister;
    provider: LLMProvider;
    onAccept: (entries: DivergenceEntry[]) => void;
    onClose: () => void;
};

type ReviewEntry = DivergenceEntry & {
    accepted: boolean;
};

const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
    canon_override: 'bg-red-900/40 text-red-300 border-red-700/50',
    world_change: 'bg-purple-900/40 text-purple-300 border-purple-700/50',
    entity_state: 'bg-blue-900/40 text-blue-300 border-blue-700/50',
    player_state: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50',
    obligation: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
};

const CATEGORIES: DivergenceCategory[] = ['canon_override', 'world_change', 'entity_state', 'player_state', 'obligation'];

export function DivergenceReviewModal({
    messages,
    archiveIndex,
    currentRegister,
    provider,
    onAccept,
    onClose,
}: DivergenceReviewModalProps) {
    const [status, setStatus] = useState<'loading' | 'editing'>('loading');
    const [entries, setEntries] = useState<ReviewEntry[]>([]);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        abortRef.current = new AbortController();
        const runExtraction = async () => {
            try {
                const { sceneIdsByMessageId } = buildSceneMap(archiveIndex, messages);
                const { newEntries, parseFailures } = await extractFromMessageBatch(
                    provider,
                    messages,
                    sceneIdsByMessageId,
                    currentRegister,
                    8000,
                    abortRef.current?.signal,
                    4000,
                );

                const reviewable: ReviewEntry[] = newEntries.map(e => ({
                    ...e,
                    source: 'manual' as const,
                    accepted: true,
                }));

                setEntries(reviewable);
                setStatus('editing');

                if (parseFailures > 0) {
                    toast.warning(`${parseFailures} entries failed to parse and may need editing`);
                }
            } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') return;
                console.error('[ReviewModal] Extraction failed:', err);
                toast.error('Failed to extract divergences');
                onClose();
            }
        };

        runExtraction();

        return () => {
            if (abortRef.current) {
                abortRef.current.abort();
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleAccept = () => {
        const accepted = entries.filter(e => e.accepted).map(e => {
            const { accepted, ...rest } = e;
            return rest;
        });
        onAccept(accepted);
    };

    const updateEntry = (index: number, patch: Partial<ReviewEntry>) => {
        setEntries(prev => {
            const next = [...prev];
            next[index] = { ...next[index], ...patch };
            return next;
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-surface border border-border rounded-t-lg sm:rounded-lg w-full max-w-lg max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex-none p-3 border-b border-border">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Zap size={14} className="text-blue-400" />
                            <span className="text-xs font-bold text-blue-400 uppercase tracking-wider">Divergence Review</span>
                        </div>
                        {status === 'editing' && (
                            <span className="text-[10px] text-text-dim font-mono">
                                {entries.filter(e => e.accepted).length}/{entries.length} selected
                            </span>
                        )}
                    </div>
                    <p className="text-[10px] text-text-dim mt-1">Scanning {messages.length} message{messages.length !== 1 && 's'}</p>
                </div>

                <div className="flex-1 overflow-y-auto p-3 min-h-[200px]">
                    {status === 'loading' ? (
                        <div className="flex flex-col items-center justify-center h-48 space-y-3">
                            <Loader2 size={24} className="animate-spin text-blue-400" />
                            <div className="text-text-dim animate-pulse text-xs">Scanning for divergences...</div>
                        </div>
                    ) : entries.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-text-dim">
                            <p className="text-xs">No new divergences detected.</p>
                            <p className="text-[10px] mt-1 opacity-50">The model did not find any campaign-altering facts.</p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {entries.map((entry, i) => (
                                <div
                                    key={entry.id}
                                    className={`p-2 rounded border transition-colors ${
                                        entry.accepted
                                            ? 'bg-void-lighter border-border'
                                            : 'bg-void border-border/50 opacity-60'
                                    } ${entry.parseError ? 'border-red-500 border-dashed' : ''}`}
                                >
                                    <div className="flex gap-2">
                                        <div className="pt-1">
                                            <input
                                                type="checkbox"
                                                checked={entry.accepted}
                                                onChange={(e) => updateEntry(i, { accepted: e.target.checked })}
                                                className="w-5 h-5 rounded"
                                            />
                                        </div>
                                        <div className="flex-1 space-y-2">
                                            <div className="flex flex-wrap gap-1.5">
                                                <select
                                                    value={entry.category}
                                                    onChange={(e) => updateEntry(i, { category: e.target.value as DivergenceCategory })}
                                                    className={`text-[10px] px-1.5 py-0.5 rounded border outline-none ${CATEGORY_COLORS[entry.category]}`}
                                                    disabled={!entry.accepted}
                                                >
                                                    {CATEGORIES.map(c => (
                                                        <option key={c} value={c} className="bg-void text-text-primary">{c}</option>
                                                    ))}
                                                </select>

                                                <input
                                                    type="text"
                                                    value={entry.subject}
                                                    onChange={(e) => updateEntry(i, { subject: e.target.value })}
                                                    placeholder="Subject"
                                                    className="flex-1 min-w-0 bg-void border border-border rounded px-1.5 py-0.5 text-[11px] text-text-primary outline-none focus:border-amber-400"
                                                    disabled={!entry.accepted}
                                                />

                                                <span className="text-[9px] font-mono text-text-dim py-0.5">
                                                    #{entry.sceneRef}
                                                </span>
                                            </div>

                                            <textarea
                                                value={entry.divergence}
                                                onChange={(e) => updateEntry(i, { divergence: e.target.value })}
                                                placeholder="Fact description..."
                                                className="w-full bg-void border border-border rounded px-1.5 py-1 text-[11px] text-text-primary outline-none focus:border-amber-400 resize-y min-h-[40px]"
                                                rows={2}
                                                disabled={!entry.accepted}
                                            />

                                            {entry.parseError && (
                                                <div className="text-[10px] text-red-400 font-semibold">
                                                    Parse error. Verify category and subject.
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex-none p-3 border-t border-border flex justify-end gap-2">
                    <button
                        onClick={onClose}
                        className="px-3 py-2 text-[11px] text-text-dim hover:text-text-primary bg-void rounded border border-border"
                    >
                        {status === 'loading' ? 'Cancel' : 'Discard All'}
                    </button>
                    {status === 'editing' && entries.length > 0 && (
                        <button
                            onClick={handleAccept}
                            disabled={entries.filter(e => e.accepted).length === 0}
                            className="px-3 py-2 text-[11px] bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center gap-1"
                        >
                            <Check size={12} />
                            Accept Selected ({entries.filter(e => e.accepted).length})
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}