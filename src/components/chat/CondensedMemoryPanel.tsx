import { useState } from 'react';
import { X, Loader2, Edit2, Check, RotateCcw, FileText, List, AlertTriangle, Archive, Plus, Scissors, Combine } from 'lucide-react';
import type { CondenserState, DivergenceCategory, DivergenceEntry, DivergenceRegister, LLMProvider } from '../../types';
import { countRegisterTokens, compressRegister, EMPTY_REGISTER } from '../../services/divergenceRegister';
import { QuestPanel } from './QuestPanel';
import { DivergenceEntryModal } from './DivergenceEntryModal';

const CATEGORIES: DivergenceCategory[] = ['canon_override', 'world_change', 'entity_state', 'player_state', 'obligation'];

const CATEGORY_COLORS: Record<DivergenceCategory, string> = {
    canon_override: 'text-red-400',
    world_change: 'text-ice',
    entity_state: 'text-terminal',
    player_state: 'text-emerald-400',
    obligation: 'text-amber-400',
};

const CATEGORY_DOTS: Record<DivergenceCategory, string> = {
    canon_override: 'bg-red-400',
    world_change: 'bg-blue-400',
    entity_state: 'bg-purple-400',
    player_state: 'bg-green-400',
    obligation: 'bg-amber-400',
};

type Tab = 'summary' | 'register' | 'review' | 'pruned';

type CondensedMemoryPanelProps = {
    condenser: CondenserState;
    editingSummary: boolean;
    summaryDraft: string;
    showCondensedPanel: boolean;
    onToggle: () => void;
    onStartEdit: () => void;
    onCancelEdit: () => void;
    onSaveEdit: () => void;
    onSetDraft: (value: string) => void;
    onRetcon: () => void;
    onReset: () => void;
    divergenceRegister?: DivergenceRegister;
    onSetDivergenceRegister?: (reg: DivergenceRegister) => void;
    tokenBudget?: number;
    provider?: LLMProvider;
    onSaveDivergence?: () => void;
    onDeleteDivergence?: (id: string) => void;
    onEditDivergence?: (id: string, patch: Partial<DivergenceEntry>) => void;
    onConfirmReviewEntry?: (id: string) => void;
    onDeleteReviewedEntry?: (id: string) => void;
    onRestorePrunedEntry?: (prunedIndex: number) => void;
    onManualPrune?: () => Promise<void>;
    onMergeSimilar?: () => Promise<void>;
};

export function CondensedMemoryPanel({
    condenser,
    editingSummary,
    summaryDraft,
    showCondensedPanel,
    onToggle,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onSetDraft,
    onRetcon,
    onReset,
    divergenceRegister,
    onSetDivergenceRegister,
    tokenBudget = 2000,
    provider,
    onSaveDivergence,
    onDeleteDivergence,
    onEditDivergence,
    onConfirmReviewEntry,
    onDeleteReviewedEntry,
    onRestorePrunedEntry,
    onManualPrune,
    onMergeSimilar,
}: CondensedMemoryPanelProps) {
    const hasSummary = !!condenser.condensedSummary;
    const [tab, setTab] = useState<Tab>(hasSummary ? 'summary' : 'register');
    const [compressing, setCompressing] = useState(false);
    const [showManualModal, setShowManualModal] = useState(false);
    const [pruneLoading, setPruneLoading] = useState(false);
    const [mergeLoading, setMergeLoading] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editCat, setEditCat] = useState<DivergenceCategory>('entity_state');
    const [editSubject, setEditSubject] = useState('');
    const [editDivergence, setEditDivergence] = useState('');
    const [editSceneRef, setEditSceneRef] = useState('');

    if (!showCondensedPanel) return null;

    const reg = divergenceRegister ?? EMPTY_REGISTER;
    const regTokens = countRegisterTokens(reg);
    const entries = reg.entries;
    const prunedLog = reg.prunedLog ?? [];
    const reviewCount = entries.filter(e => e.reviewFlag).length;

    const handleCompress = async () => {
        if (!provider || !onSetDivergenceRegister) return;
        if (regTokens <= tokenBudget) return;
        setCompressing(true);
        try {
            const compressed = await compressRegister(provider, reg, tokenBudget);
            onSetDivergenceRegister(compressed);
            onSaveDivergence?.();
        } catch (err) {
            console.warn('[CondensedMemoryPanel] Compression failed:', err);
        }
        setCompressing(false);
    };

    const handleResolveObligation = (id: string) => {
        if (!onSetDivergenceRegister) return;
        const updated = {
            ...reg,
            entries: reg.entries.map(e => e.id === id ? { ...e, resolved: true } : e),
            lastUpdatedAt: Date.now(),
        };
        onSetDivergenceRegister(updated);
        onSaveDivergence?.();
    };

    const handleAddManualEntry = (entry: DivergenceEntry) => {
        if (!onSetDivergenceRegister) return;
        const updated = {
            ...reg,
            entries: [...reg.entries, entry].sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef)),
            lastUpdatedAt: Date.now(),
        };
        onSetDivergenceRegister(updated);
        onSaveDivergence?.();
    };

    const startEdit = (e: DivergenceEntry) => {
        setEditingId(e.id);
        setEditCat(e.category);
        setEditSubject(e.subject);
        setEditDivergence(e.divergence);
        setEditSceneRef(e.sceneRef);
    };

    const cancelEdit = () => {
        setEditingId(null);
    };

    const saveEdit = () => {
        if (!editingId || !onEditDivergence) return;
        onEditDivergence(editingId, {
            category: editCat,
            subject: editSubject,
            divergence: editDivergence,
            sceneRef: editSceneRef,
        });
        setEditingId(null);
    };

    const handlePrune = async () => {
        if (!onManualPrune) return;
        setPruneLoading(true);
        try {
            await onManualPrune();
        } catch (e) {
            console.error('[ManualPrune] failed', e);
        }
        setPruneLoading(false);
    };

    const handleMerge = async () => {
        if (!onMergeSimilar) return;
        setMergeLoading(true);
        try {
            await onMergeSimilar();
        } catch (e) {
            console.error('[MergeSimilar] failed', e);
        }
        setMergeLoading(false);
    };

    return (
        <div className="px-2 md:px-4 pb-1">
            <div className="bg-void-lighter border border-terminal/20 rounded p-3">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                        <button
                            onClick={() => setTab('summary')}
                            className={`flex items-center gap-0.5 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'summary' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                        >
                            <FileText size={9} />
                            {hasSummary ? 'Sum' : '-'}
                        </button>
                        <button
                            onClick={() => setTab('register')}
                            className={`flex items-center gap-0.5 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'register' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                        >
                            <List size={9} />
                            Reg
                            {entries.length > 0 && <span className="text-[7px] bg-amber-500/30 px-0.5 rounded">{entries.length}</span>}
                        </button>
                        <button
                            onClick={() => setTab('review')}
                            className={`flex items-center gap-0.5 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'review' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                        >
                            <AlertTriangle size={9} />
                            Rev
                            {reviewCount > 0 && <span className="text-[7px] bg-red-500/40 px-0.5 rounded">{reviewCount}</span>}
                        </button>
                        {prunedLog.length > 0 && (
                            <button
                                onClick={() => setTab('pruned')}
                                className={`flex items-center gap-0.5 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'pruned' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                            >
                                <Archive size={9} />
                                Prun({prunedLog.length})
                            </button>
                        )}
                    </div>
                    <button onClick={onToggle} className="text-[9px] text-text-dim hover:underline px-1"><X size={10} /></button>
                </div>

                {tab === 'register' && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-[9px] text-text-dim">
                            <span>{regTokens}/{tokenBudget} tkns {regTokens <= tokenBudget ? '(ok)' : '(over)'}</span>
                            <span>{entries.length} entries</span>
                        </div>
                        <div className="flex items-center gap-1 flex-wrap">
                            <button onClick={() => setShowManualModal(true)} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:underline px-1">
                                <Plus size={9} /> Add
                            </button>
                            {provider && onManualPrune && (
                                <button onClick={handlePrune} disabled={pruneLoading || entries.length === 0} className="flex items-center gap-0.5 text-[9px] text-purple-400 hover:underline px-1 disabled:opacity-40">
                                    {pruneLoading ? <Loader2 size={9} className="animate-spin" /> : <Scissors size={9} />}
                                    Prune
                                </button>
                            )}
                            {provider && onMergeSimilar && (
                                <button onClick={handleMerge} disabled={mergeLoading || entries.length < 2} className="flex items-center gap-0.5 text-[9px] text-cyan-400 hover:underline px-1 disabled:opacity-40">
                                    {mergeLoading ? <Loader2 size={9} className="animate-spin" /> : <Combine size={9} />}
                                    Merge
                                </button>
                            )}
                            {compressing ? (
                                <Loader2 size={9} className="animate-spin text-amber-400" />
                            ) : (
                                <button
                                    onClick={handleCompress}
                                    disabled={regTokens <= tokenBudget || !provider}
                                    className="text-[9px] text-terminal hover:underline px-1 disabled:opacity-40"
                                    title={regTokens <= tokenBudget ? `Register is ${regTokens}/${tokenBudget} tokens — no compression needed` : 'Compress register'}
                                >
                                    AI Summary
                                </button>
                            )}
                        </div>

                        {entries.length === 0 ? (
                            <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                                No divergences tracked yet. Use ⚡ on GM messages to tag them.
                            </div>
                        ) : (
                            <div className="text-[11px] text-text-dim/80 font-mono whitespace-pre-wrap max-h-[250px] overflow-y-auto space-y-1">
                                {entries.filter(e => !e.reviewFlag && (e.category !== 'obligation' || e.resolved)).map(e => (
                                    editingId === e.id ? (
                                        <div key={e.id} className="bg-void border border-amber-500/30 p-2 rounded space-y-1.5">
                                            <div className="flex gap-1.5">
                                                <select
                                                    value={editCat}
                                                    onChange={ev => setEditCat(ev.target.value as DivergenceCategory)}
                                                    className="bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none"
                                                >
                                                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                                </select>
                                                <input
                                                    value={editSceneRef}
                                                    onChange={ev => setEditSceneRef(ev.target.value)}
                                                    className="bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none w-14"
                                                    placeholder="Scene"
                                                />
                                            </div>
                                            <input
                                                value={editSubject}
                                                onChange={ev => setEditSubject(ev.target.value)}
                                                className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none"
                                                placeholder="Subject"
                                            />
                                            <textarea
                                                value={editDivergence}
                                                onChange={ev => setEditDivergence(ev.target.value)}
                                                className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none resize-y min-h-[28px] max-h-[60px]"
                                                placeholder="Divergence"
                                                rows={2}
                                            />
                                            <div className="flex gap-1.5 justify-end">
                                                <button onClick={saveEdit} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10">
                                                    <Check size={9} /> Save
                                                </button>
                                                <button onClick={cancelEdit} className="flex items-center gap-0.5 text-[9px] text-text-dim hover:text-red-400 px-1.5 py-0.5 rounded bg-white/5">
                                                    <X size={9} /> Cancel
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div key={e.id} className={`flex items-start gap-1 ${e.resolved ? 'line-through opacity-40' : ''} ${e.parseError ? 'border border-dashed border-red-500/60 rounded px-1 py-0.5 bg-red-500/5' : ''}`}>
                                            <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} title={e.category} />
                                            <span className="min-w-0 flex-1">
                                                {e.parseError && <span className="text-red-400 font-bold mr-1 text-[9px]">[ERR]</span>}
                                                <span className={`${CATEGORY_COLORS[e.category]}`}><span className="text-[9px] uppercase">{e.category === 'canon_override' ? 'CANON' : e.category === 'world_change' ? 'WORLD' : e.category === 'entity_state' ? 'ENTITY' : e.category === 'player_state' ? 'PLAYER' : 'OBLIG'}</span></span>
                                                {' '}<span className="text-text-primary">{e.subject}: {e.divergence}</span>
                                                <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                            </span>
                                            {(onEditDivergence || onDeleteDivergence) && (
                                                <span className="flex items-center gap-0.5 shrink-0">
                                                    {onEditDivergence && (
                                                        <button onClick={() => startEdit(e)} className="text-text-dim hover:text-amber-400 p-0.5" title="Edit">
                                                            <Edit2 size={9} />
                                                        </button>
                                                    )}
                                                    {onDeleteDivergence && (
                                                        <button onClick={() => onDeleteDivergence(e.id)} className="text-text-dim hover:text-red-400 p-0.5" title="Delete">
                                                            <X size={10} />
                                                        </button>
                                                    )}
                                                </span>
                                            )}
                                        </div>
                                    )
                                ))}
                            </div>
                        )}

                        <QuestPanel entries={entries} onResolve={handleResolveObligation} />
                    </div>
                )}

                {tab === 'review' && (
                    <div className="space-y-2">
                        <span className="text-[9px] text-text-dim uppercase tracking-wider">
                            {reviewCount} entries flagged for review — keep or delete each one.
                        </span>
                        {reviewCount === 0 ? (
                            <p className="text-[10px] text-text-dim italic py-4 text-center">No entries flagged for review.</p>
                        ) : (
                            <div className="space-y-1.5 max-h-[250px] overflow-y-auto">
                                {entries.filter(e => e.reviewFlag).map(e => (
                                    <div key={e.id} className="bg-red-900/20 border border-red-500/60 p-1.5 rounded">
                                        <div className="flex items-start gap-1.5 text-[10px]">
                                            <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} title={e.category} />
                                            <div className="min-w-0 flex-1">
                                                <span className="text-red-400 font-bold text-[9px] mr-1">[REVIEW]</span>
                                                <span className="text-text-primary">{e.subject}: {e.divergence}</span>
                                                <span className="text-text-dim ml-1 text-[9px]">[#{e.sceneRef}]</span>
                                                {e.parseError && <span className="text-red-400 font-bold ml-1 text-[9px]">[ERR]</span>}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 mt-1.5 ml-3.5">
                                            <span className="text-[8px] text-red-400/70 italic">keep or delete?</span>
                                            {onConfirmReviewEntry && (
                                                <button
                                                    onClick={() => onConfirmReviewEntry(e.id)}
                                                    className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10"
                                                >
                                                    <Check size={8} /> Keep
                                                </button>
                                            )}
                                            {onDeleteReviewedEntry && (
                                                <button
                                                    onClick={() => onDeleteReviewedEntry(e.id)}
                                                    className="flex items-center gap-0.5 text-[9px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-500/10"
                                                >
                                                    <X size={8} /> Delete
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'pruned' && (
                    <div className="space-y-2">
                        <span className="text-[9px] text-text-dim uppercase tracking-wider">
                            {prunedLog.length} pruned entries — not sent to AI. Tap restore to move back.
                        </span>
                        {prunedLog.length === 0 ? (
                            <p className="text-[10px] text-text-dim italic py-4 text-center">No pruned entries yet. Entries appear here after chapter seal pruning.</p>
                        ) : (
                            <div className="space-y-1.5 max-h-[250px] overflow-y-auto">
                                {prunedLog.map((p, idx) => (
                                    <div key={idx} className="flex items-start gap-1.5 text-[10px] p-1 rounded bg-white/[0.02] border border-white/5">
                                        <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${p.verdict === 'auto_pruned' ? 'bg-gray-500' : 'bg-red-500'}`} title={p.verdict} />
                                        <div className="min-w-0 flex-1">
                                            <span className="text-text-primary/60">{p.originalEntry.subject}: {p.originalEntry.divergence}</span>
                                            <span className="text-text-dim ml-1 text-[9px]">[#{p.originalEntry.sceneRef}]</span>
                                            <div className="text-[8px] text-text-dim/60 mt-0.5">
                                                {p.verdict === 'auto_pruned' ? `Auto-pruned (CH ${p.chapterId})` : 'User deleted after review'}
                                                {p.reason && ` — ${p.reason}`}
                                            </div>
                                        </div>
                                        {onRestorePrunedEntry && (
                                            <button
                                                onClick={() => onRestorePrunedEntry(idx)}
                                                className="text-text-dim hover:text-emerald-400 p-1 shrink-0"
                                                title="Restore entry"
                                            >
                                                <RotateCcw size={10} />
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'summary' && (
                    <div>
                        {editingSummary ? (
                            <textarea value={summaryDraft} onChange={e => onSetDraft(e.target.value)} className="w-full bg-void border border-border rounded px-2 py-1 text-xs text-text-primary font-mono resize-y min-h-[60px] max-h-[200px]" />
                        ) : (
                            <div className="text-[11px] text-text-dim/80 font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                                {condenser.condensedSummary || <span className="italic opacity-50">No condensed summary yet</span>}
                            </div>
                        )}
                        <div className="flex gap-2 mt-2">
                            {editingSummary ? (
                                <>
                                    <button onClick={onSaveEdit} className="text-[9px] text-terminal hover:underline px-1">Save</button>
                                    <button onClick={onCancelEdit} className="text-[9px] text-text-dim hover:underline px-1">Cancel</button>
                                </>
                            ) : (
                                <>
                                    <button onClick={onStartEdit} className="text-[9px] text-terminal hover:underline px-1">Edit</button>
                                    <button onClick={onRetcon} className="text-[9px] text-amber-500 hover:underline px-1">Retcon</button>
                                    <button onClick={onReset} className="text-[9px] text-red-400 hover:underline px-1">Reset</button>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {showManualModal && (
                <DivergenceEntryModal
                    onAdd={handleAddManualEntry}
                    onClose={() => setShowManualModal(false)}
                    provider={provider}
                />
            )}
        </div>
    );
}