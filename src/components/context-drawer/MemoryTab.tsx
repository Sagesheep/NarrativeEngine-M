import { useState, useRef } from 'react';
import { Edit2, Check, Pin, PinOff, ChevronDown, ChevronUp, AlertTriangle, Trash2, Sparkles, Users, X, Link2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { DivergenceCategory, DivergenceEntry, NPCEntry } from '../../types';
import { countRegisterTokens, EMPTY_REGISTER, CATEGORY_LABELS, DIVERGENCE_CATEGORIES, runFactDedup, assignSubjectTokens, type DedupResult, type DedupCancelled, type ClusteringCancelled, normalizeFaction, groupDivergencesBySubject } from '../../services/campaign-state';
import { DedupReviewModal } from '../DedupReviewModal';
import { appConfirm } from '../ConfirmSheet';
import { CATEGORY_COLORS, CATEGORY_DOTS, knownByTokenLabel, knownBySummary, knownByChipClass, subjectLabel } from './memoryTabHelpers';

type Tab = 'facts' | 'review';
type FactsView = 'chapter' | 'topic' | 'subject';



/** KnownBy editor popover — inline, matches existing inline-edit pattern. */
function KnownByEditor({ entry, npcLedger, onApply, onClose }: {
    entry: DivergenceEntry;
    npcLedger: NPCEntry[];
    onApply: (knownBy: string[] | undefined) => void;
    onClose: () => void;
}) {
    const [tokens, setTokens] = useState<string[]>(entry.knownBy === undefined ? [] : [...entry.knownBy]);
    const isPublic = entry.knownBy === undefined;
    const [factionInput, setFactionInput] = useState('');

    const addToken = (tok: string) => {
        if (tokens.includes(tok)) return;
        setTokens([...tokens, tok]);
    };
    const removeToken = (tok: string) => {
        setTokens(tokens.filter(t => t !== tok));
    };

    return (
        <div className="bg-void border border-amber-500/30 p-1.5 rounded space-y-1.5 text-[10px]">
            <div className="flex items-center gap-1 flex-wrap">
                <span className="text-text-dim uppercase tracking-wider text-[8px]">Knows:</span>
                {isPublic && (
                    <span className="text-emerald-400 px-1 py-0.5 bg-emerald-500/10 rounded">public</span>
                )}
                {!isPublic && tokens.length === 0 && (
                    <span className="text-red-400 px-1 py-0.5 bg-red-500/10 rounded">secret (player only)</span>
                )}
                {!isPublic && tokens.map(t => (
                    <span key={t} className={`px-1 py-0.5 rounded flex items-center gap-0.5 ${t === 'player' ? 'text-ice bg-ice/10' : t.startsWith('faction:') ? 'text-purple-400 bg-purple-500/10' : 'text-amber-400 bg-amber-500/10'}`}>
                        {knownByTokenLabel(t, npcLedger)}
                        <button onClick={() => removeToken(t)} className="hover:text-red-400"><X size={8} /></button>
                    </span>
                ))}
            </div>

            <div className="space-y-1">
                <div className="text-text-dim text-[9px] uppercase tracking-wider">Add knower:</div>
                <div className="flex items-center gap-1 flex-wrap">
                    <button
                        onClick={() => addToken('player')}
                        className={`px-1 py-0.5 rounded text-ice bg-ice/10 hover:bg-ice/20 ${tokens.includes('player') ? 'opacity-40 cursor-not-allowed' : ''}`}
                        disabled={tokens.includes('player')}
                    >
                        + player
                    </button>
                    <button
                        onClick={() => onApply(undefined)}
                        className="px-1 py-0.5 rounded text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                        title="Set to public/broadcast (knownBy = undefined)"
                    >
                        make public
                    </button>
                </div>

                <div className="flex items-center gap-0.5 flex-wrap">
                    <span className="text-text-dim text-[9px] flex items-center gap-0.5"><Users size={9} /> NPC:</span>
                    {npcLedger.length === 0 && <span className="text-text-dim/50 italic">no NPCs in ledger</span>}
                    {npcLedger.slice(0, 12).map(n => {
                        const tok = `npc:${n.id}`;
                        return (
                            <button
                                key={n.id}
                                onClick={() => addToken(tok)}
                                disabled={tokens.includes(tok)}
                                className={`px-1 py-0.5 rounded text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 ${tokens.includes(tok) ? 'opacity-40 cursor-not-allowed' : ''}`}
                            >
                                + {n.name}
                            </button>
                        );
                    })}
                </div>

                <div className="flex items-center gap-0.5">
                    <span className="text-text-dim text-[9px]">faction:</span>
                    <input
                        type="text"
                        value={factionInput}
                        onChange={ev => setFactionInput(ev.target.value)}
                        placeholder="e.g. Ironspire Knights"
                        className="flex-1 bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none min-w-0"
                        onKeyDown={ev => {
                            if (ev.key === 'Enter' && factionInput.trim()) {
                                const f = normalizeFaction(factionInput);
                                if (f) { addToken(`faction:${f}`); setFactionInput(''); }
                            }
                        }}
                    />
                    <button
                        onClick={() => {
                            const f = normalizeFaction(factionInput);
                            if (f) { addToken(`faction:${f}`); setFactionInput(''); }
                        }}
                        disabled={!factionInput.trim()}
                        className="px-1 py-0.5 rounded text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-40"
                    >
                        + add
                    </button>
                </div>
            </div>

            <div className="flex gap-1.5 justify-end">
                <button
                    onClick={() => onApply(tokens)}
                    className="flex items-center gap-0.5 text-emerald-400 hover:text-emerald-300 px-1"
                >
                    <Check size={8} /> Save
                </button>
                <button onClick={onClose} className="text-text-dim hover:text-red-400 px-1">Cancel</button>
            </div>
        </div>
    );
}

export function MemoryTab() {
    const divergenceRegister = useAppStore(s => s.divergenceRegister);
    const chapters = useAppStore(s => s.chapters);
    const settings = useAppStore(s => s.settings);
    const deleteDivergenceFact = useAppStore(s => s.deleteDivergenceFact);
    const deleteDivergenceChapter = useAppStore(s => s.deleteDivergenceChapter);
    const toggleDivergenceFact = useAppStore(s => s.toggleDivergenceFact);
    const confirmReviewEntry = useAppStore(s => s.confirmReviewEntry);
    const deleteReviewedEntry = useAppStore(s => s.deleteReviewedEntry);
    const toggleDivergenceChapter = useAppStore(s => s.toggleDivergenceChapter);
    const toggleDivergenceCategory = useAppStore(s => s.toggleDivergenceCategory);
    const pinDivergenceFact = useAppStore(s => s.pinDivergenceFact);
    const editDivergenceFact = useAppStore(s => s.editDivergenceFact);
    const editDivergenceKnownBy = useAppStore(s => s.editDivergenceKnownBy);
    const applySubjectTokens = useAppStore(s => s.applySubjectTokens);
    const setManyFactsEnabled = useAppStore(s => s.setManyFactsEnabled);
    const npcLedger = useAppStore(s => s.npcLedger);
    const getActiveUtilityEndpoint = useAppStore(s => s.getActiveUtilityEndpoint);

    const [tab, setTab] = useState<Tab>('facts');
    const [factsView, setFactsView] = useState<FactsView>('chapter');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState('');
    const [knownByEditingId, setKnownByEditingId] = useState<string | null>(null);
    const [expandedChapter, setExpandedChapter] = useState<string | null>(null);
    const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
    const [expandedSubject, setExpandedSubject] = useState<string | null>(null);

    const [dedupOpen, setDedupOpen] = useState(false);
    const [dedupRunning, setDedupRunning] = useState(false);
    const [dedupProgress, setDedupProgress] = useState<{ msg: string; done: number; total: number } | null>(null);
    const [dedupResult, setDedupResult] = useState<DedupResult | null>(null);
    const [dedupSelections, setDedupSelections] = useState<Record<string, Set<string>>>({});
    const [dedupError, setDedupError] = useState<string | null>(null);
    const dedupCancelRef = useRef<DedupCancelled>({ cancelled: false });

    // WO4 — Find Similarity state (distinct from Find Duplicates; never disables/deletes).
    const [simRunning, setSimRunning] = useState(false);
    const [simStatus, setSimStatus] = useState<string | null>(null);
    const [simSummary, setSimSummary] = useState<string | null>(null);
    const [simError, setSimError] = useState<string | null>(null);
    const simCancelRef = useRef<ClusteringCancelled>({ cancelled: false });

    const reg = divergenceRegister ?? EMPTY_REGISTER;
    const tokenBudget = settings.divergenceTokenBudget ?? 2000;
    const regTokens = countRegisterTokens(reg);
    const entries = reg.entries;
    const reviewEntries = entries.filter(e => e.reviewFlag);

    const pinnedEntries = entries.filter(e => e.pinned);
    const unpinnedEntries = entries.filter(e => !e.pinned);

    const byChapter = new Map<string, DivergenceEntry[]>();
    for (const e of unpinnedEntries) {
        if (!byChapter.has(e.chapterId)) byChapter.set(e.chapterId, []);
        byChapter.get(e.chapterId)!.push(e);
    }

    const chapterTitleMap = new Map<string, string>();
    if (chapters) {
        for (const ch of chapters) {
            chapterTitleMap.set(ch.chapterId, ch.title);
        }
    }

    const activeCount = entries.filter(e => {
        if (e.enabled === false) return false;
        if (e.pinned) return true;
        const chapterOn = reg.chapterToggles[e.chapterId] !== false;
        if (!chapterOn) return false;
        const catToggles = reg.categoryToggles[e.chapterId];
        if (catToggles && catToggles[e.category] === false) return false;
        return true;
    }).length;
    const pinnedCount = pinnedEntries.length;

    const handleStartEdit = (e: DivergenceEntry) => {
        setEditingId(e.id);
        setEditText(e.text);
    };

    const handleSaveEdit = () => {
        if (!editingId) return;
        editDivergenceFact(editingId, editText);
        setEditingId(null);
        setEditText('');
    };

    const handleToggleGroup = (factIds: string[], allEnabled: boolean) => {
        setManyFactsEnabled(factIds.map(id => ({ id, enabled: !allEnabled })));
    };

    const handleStartDedup = () => {
        const utilityProvider = getActiveUtilityEndpoint();
        if (!utilityProvider) {
            setDedupError('No utility AI endpoint configured.');
            setDedupOpen(true);
            return;
        }
        setDedupOpen(true);
        setDedupRunning(true);
        setDedupProgress(null);
        setDedupResult(null);
        setDedupSelections({});
        setDedupError(null);
        dedupCancelRef.current = { cancelled: false };

        runFactDedup(reg, npcLedger ?? [], chapters ?? [], utilityProvider, dedupCancelRef.current, (msg, done, total) => {
            setDedupProgress({ msg, done, total });
        }).then(result => {
            setDedupResult(result);
            setDedupRunning(false);
            setDedupProgress(null);
            const sels: Record<string, Set<string>> = {};
            for (const g of result.groups) {
                sels[g.keepId] = new Set(g.disableIds);
            }
            setDedupSelections(sels);
        }).catch(err => {
            if (err.message === 'Dedup cancelled.') {
                setDedupOpen(false);
                setDedupRunning(false);
                setDedupProgress(null);
            } else {
                setDedupError(err.message || String(err));
                setDedupRunning(false);
                setDedupProgress(null);
            }
        });
    };

    const handleStopDedup = () => {
        dedupCancelRef.current.cancelled = true;
        setDedupOpen(false);
        setDedupRunning(false);
        setDedupProgress(null);
    };

    const handleToggleDisable = (keepId: string, disableId: string) => {
        setDedupSelections(prev => {
            const current = prev[keepId];
            if (!current) return prev;
            const next = new Set(current);
            if (next.has(disableId)) next.delete(disableId);
            else next.add(disableId);
            return { ...prev, [keepId]: next };
        });
    };

    const handleSkipGroup = (keepId: string) => {
        setDedupSelections(prev => ({
            ...prev,
            [keepId]: new Set<string>(),
        }));
    };

    const handleApplyDedup = () => {
        const updates: Array<{ id: string; enabled: boolean }> = [];
        for (const g of dedupResult?.groups ?? []) {
            const sel = dedupSelections[g.keepId];
            if (!sel) continue;
            for (const dId of sel) {
                updates.push({ id: dId, enabled: false });
            }
        }
        if (updates.length > 0) setManyFactsEnabled(updates);
        setDedupOpen(false);
        setDedupResult(null);
        setDedupSelections({});
        setDedupError(null);
    };

    const handleCloseDedup = () => {
        if (dedupRunning) return;
        setDedupOpen(false);
        setDedupResult(null);
        setDedupSelections({});
        setDedupError(null);
    };

    // WO4 — Find Similarity: group facts by subject via the existing clustering LLM
    // call, then assign/repair subjectToken. NEVER disables or deletes facts.
    const handleStartSimilarity = () => {
        const utilityProvider = getActiveUtilityEndpoint();
        if (!utilityProvider) {
            setSimError('No utility AI endpoint configured.');
            return;
        }
        setSimRunning(true);
        setSimStatus('Starting…');
        setSimSummary(null);
        setSimError(null);
        simCancelRef.current = { cancelled: false };

        const contextLimit = settings.contextLimit || 8192;
        assignSubjectTokens(reg, utilityProvider, contextLimit, simCancelRef.current, setSimStatus)
            .then(result => {
                if (result.updates.length > 0) {
                    applySubjectTokens(result.updates);
                }
                setSimSummary(`Grouped ${result.factCount} fact${result.factCount === 1 ? '' : 's'} into ${result.groupCount} subject${result.groupCount === 1 ? '' : 's'}.`);
                setSimRunning(false);
                setSimStatus(null);
            })
            .catch(err => {
                if (err.message === 'Find Similarity cancelled.') {
                    setSimRunning(false);
                    setSimStatus(null);
                } else {
                    setSimError(err.message || String(err));
                    setSimRunning(false);
                    setSimStatus(null);
                }
            });
    };

    const handleStopSimilarity = () => {
        simCancelRef.current.cancelled = true;
        setSimRunning(false);
        setSimStatus(null);
    };

    // By-category grouping — computed from existing data, no AI needed
    const byCategory = new Map<DivergenceCategory, DivergenceEntry[]>();
    for (const cat of DIVERGENCE_CATEGORIES) byCategory.set(cat, []);
    for (const e of unpinnedEntries) byCategory.get(e.category)!.push(e);

    // By-subject grouping (WO3 timeline).
    const subjectGroups = groupDivergencesBySubject(unpinnedEntries);

    return (
        <div className="p-3 space-y-3">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                <button
                    onClick={() => setTab('facts')}
                    className={`flex items-center gap-0.5 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'facts' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                >
                    Facts ({activeCount})
                </button>
                {reviewEntries.length > 0 && (
                    <button
                        onClick={() => setTab('review')}
                        className={`flex items-center gap-0.5 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'review' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                    >
                        <AlertTriangle size={9} />
                        Rev ({reviewEntries.length})
                    </button>
                )}
            </div>

            <div className="text-[9px] text-text-dim">
                {regTokens}/{tokenBudget} tkns · {activeCount} active{pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}
            </div>

            {tab === 'facts' && (
                <div className="flex items-center gap-1 flex-wrap">
                    <button
                        onClick={handleStartDedup}
                        disabled={dedupRunning}
                        className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Sparkles size={9} />
                        Find Duplicates
                    </button>
                    <button
                        onClick={handleStartSimilarity}
                        disabled={simRunning}
                        className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Group facts by subject and assign/repair subject tokens. Does NOT disable or delete any fact."
                    >
                        <Link2 size={9} />
                        Find Similarity
                    </button>
                    {simRunning && (
                        <button
                            onClick={handleStopSimilarity}
                            className="flex items-center gap-0.5 text-[9px] text-red-400 hover:text-red-300 px-1"
                        >
                            <X size={9} /> Stop
                        </button>
                    )}
                </div>
            )}

            {tab === 'facts' && simStatus && (
                <div className="text-[9px] text-text-dim">{simStatus}</div>
            )}
            {tab === 'facts' && simSummary && !simRunning && (
                <div className="text-[9px] text-purple-400">{simSummary}</div>
            )}
            {tab === 'facts' && simError && !simRunning && (
                <div className="text-[9px] text-red-400">{simError}</div>
            )}

            {tab === 'facts' && (
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setFactsView('chapter')}
                        className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded ${factsView === 'chapter' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                    >
                        By Chapter
                    </button>
                    <button
                        onClick={() => setFactsView('topic')}
                        className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded ${factsView === 'topic' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                    >
                        By Topic
                    </button>
                    <button
                        onClick={() => setFactsView('subject')}
                        className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded ${factsView === 'subject' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                    >
                        By Subject
                    </button>
                </div>
            )}

            {tab === 'facts' && factsView === 'topic' && (
                <div className="space-y-2">
                    {DIVERGENCE_CATEGORIES.map(cat => {
                        const catEntries = byCategory.get(cat) ?? [];
                        if (catEntries.length === 0) return null;
                        const allEnabled = catEntries.every(e => e.enabled !== false);
                        const someEnabled = catEntries.some(e => e.enabled !== false);
                        const isExpanded = expandedGroup === cat;

                        return (
                            <div key={cat} className="border border-border/30 rounded">
                                <button
                                    className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                                    onClick={() => setExpandedGroup(isExpanded ? null : cat)}
                                >
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={someEnabled}
                                            ref={el => { if (el) el.indeterminate = someEnabled && !allEnabled; }}
                                            onChange={(ev) => { ev.stopPropagation(); handleToggleGroup(catEntries.map(e => e.id), allEnabled); }}
                                            className="w-3 h-3 accent-terminal"
                                            onClick={(ev) => ev.stopPropagation()}
                                        />
                                        <span className={`text-[11px] font-bold ${CATEGORY_COLORS[cat]}`}>{CATEGORY_LABELS[cat]}</span>
                                        <span className="text-[9px] text-text-dim">{catEntries.length} facts</span>
                                    </div>
                                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                </button>

                                {isExpanded && (
                                    <div className="border-t border-border/20 px-3 pb-1.5 pt-1 space-y-0.5">
                                        {catEntries.map(e => (
                                            editingId === e.id ? (
                                                <div key={e.id} className="bg-void border border-amber-500/30 p-1.5 rounded space-y-1">
                                                    <textarea
                                                        value={editText}
                                                        onChange={ev => setEditText(ev.target.value)}
                                                        className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none resize-y min-h-[24px] max-h-[48px]"
                                                        rows={2}
                                                    />
                                                    <div className="flex gap-1.5 justify-end">
                                                        <button onClick={handleSaveEdit} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1">
                                                            <Check size={8} /> Save
                                                        </button>
                                                        <button onClick={() => setEditingId(null)} className="text-[9px] text-text-dim hover:text-red-400 px-1">
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : knownByEditingId === e.id ? (
                                                <KnownByEditor
                                                    key={e.id}
                                                    entry={e}
                                                    npcLedger={npcLedger ?? []}
                                                    onApply={(kb) => { editDivergenceKnownBy(e.id, kb); setKnownByEditingId(null); }}
                                                    onClose={() => setKnownByEditingId(null)}
                                                />
                                            ) : (
                                                <div key={e.id} className={`flex items-start gap-1 text-[11px] ${e.enabled !== false ? 'text-text-secondary' : 'text-text-dim/50 line-through'}`}>
                                                    <input
                                                        type="checkbox"
                                                        checked={e.enabled !== false}
                                                        onChange={() => toggleDivergenceFact(e.id, e.enabled === false)}
                                                        className="w-3 h-3 accent-terminal shrink-0"
                                                    />
                                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                                    <span className="min-w-0 flex-1">
                                                        {e.text}
                                                        <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]</span>
                                                        <span className={`text-[9px] ml-1 ${knownByChipClass(e.knownBy)}`}>(known to: {knownBySummary(e.knownBy, npcLedger ?? [])})</span>
                                                    </span>
                                                    <span className="flex items-center gap-0.5 shrink-0">
                                                        <button onClick={() => setKnownByEditingId(e.id)} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit who knows"><Users size={9} /></button>
                                                        <button onClick={() => pinDivergenceFact(e.id)} className="text-text-muted hover:text-amber-400 p-0.5"><Pin size={9} /></button>
                                                        <button onClick={() => handleStartEdit(e)} className="text-text-muted hover:text-amber-400 p-0.5"><Edit2 size={9} /></button>
                                                        <button onClick={() => deleteDivergenceFact(e.id)} className="text-text-muted hover:text-red-400 p-0.5"><Trash2 size={9} /></button>
                                                    </span>
                                                </div>
                                            )
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {tab === 'facts' && factsView === 'chapter' && (
                <div className="space-y-3">
                    {pinnedEntries.length > 0 && (
                        <div className="space-y-1">
                            <div className="text-[9px] uppercase font-bold text-amber-400 tracking-wider flex items-center gap-1">
                                <Pin size={9} /> Pinned
                            </div>
                            {pinnedEntries.map(e => (
                                <div key={e.id} className="flex items-start gap-1 text-[11px] text-text-primary">
                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className={`${CATEGORY_COLORS[e.category]} text-[9px] uppercase`}>{CATEGORY_LABELS[e.category]}</span>
                                        {' '}{e.text}
                                        <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                    </span>
                                    <span className="flex items-center gap-0.5 shrink-0">
                                        <button onClick={() => pinDivergenceFact(e.id)} className="text-amber-400 p-0.5" title="Unpin">
                                            <PinOff size={9} />
                                        </button>
                                        <button onClick={() => deleteDivergenceFact(e.id)} className="text-text-dim hover:text-red-400 p-0.5" title="Delete">
                                            <Edit2 size={7} className="inline" />
                                        </button>
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {[...byChapter.entries()].map(([chapterId, chapterEntries]) => {
                        const chapterTitle = chapterTitleMap.get(chapterId) ?? chapterId;
                        const chapterOn = reg.chapterToggles[chapterId] !== false;
                        const isExpanded = expandedChapter === chapterId;

                        const catGroups = new Map<DivergenceCategory, DivergenceEntry[]>();
                        for (const e of chapterEntries) {
                            if (!catGroups.has(e.category)) catGroups.set(e.category, []);
                            catGroups.get(e.category)!.push(e);
                        }

                        return (
                            <div key={chapterId} className="border border-border/30 rounded">
                                <button
                                    className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                                    onClick={() => setExpandedChapter(isExpanded ? null : chapterId)}
                                >
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            checked={chapterOn}
                                            onChange={(ev) => { ev.stopPropagation(); toggleDivergenceChapter(chapterId, !chapterOn); }}
                                            className="w-3 h-3 accent-terminal"
                                            onClick={(ev) => ev.stopPropagation()}
                                        />
                                        <span className="text-[11px] font-bold text-text-primary">{chapterTitle}</span>
                                        <span className="text-[9px] text-text-dim">{chapterEntries.length} facts</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={async (ev) => {
                                                ev.stopPropagation();
                                                if (await appConfirm({
                                                    title: 'Delete facts',
                                                    body: `Delete all ${chapterEntries.length} facts in "${chapterTitle}"?`,
                                                    confirmLabel: 'Delete',
                                                    danger: true,
                                                })) {
                                                    deleteDivergenceChapter(chapterId);
                                                }
                                            }}
                                            className="text-text-muted hover:text-red-400 p-0.5"
                                            title="Delete all facts in chapter"
                                        >
                                            <Trash2 size={11} />
                                        </button>
                                        {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                    </div>
                                </button>

                                {isExpanded && [...catGroups.entries()].map(([cat, catEntries]) => {
                                    const catKey = `${chapterId}-${cat}`;
                                    const catExpanded = expandedCategory === catKey;

                                    return (
                                        <div key={cat} className="border-t border-border/20">
                                            <button
                                                className="w-full flex items-center justify-between px-3 py-1 text-left"
                                                onClick={() => setExpandedCategory(catExpanded ? null : catKey)}
                                            >
                                                <div className="flex items-center gap-1.5">
                                                    <input
                                                        type="checkbox"
                                                        checked={reg.categoryToggles[chapterId]?.[cat] !== false}
                                                        onChange={(ev) => { ev.stopPropagation(); toggleDivergenceCategory(chapterId, cat, reg.categoryToggles[chapterId]?.[cat] !== false); }}
                                                        className="w-2.5 h-2.5 accent-terminal"
                                                        onClick={(ev) => ev.stopPropagation()}
                                                    />
                                                    <span className={`text-[9px] uppercase font-bold ${CATEGORY_COLORS[cat]}`}>{CATEGORY_LABELS[cat]}</span>
                                                    <span className="text-[8px] text-text-dim">{catEntries.length}</span>
                                                </div>
                                                {catExpanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                                            </button>

                                            {catExpanded && (
                                                <div className="px-3 pb-1.5 space-y-0.5">
                                                    {catEntries.map(e => (
                                                        editingId === e.id ? (
                                                            <div key={e.id} className="bg-void border border-amber-500/30 p-1.5 rounded space-y-1">
                                                                <textarea
                                                                    value={editText}
                                                                    onChange={ev => setEditText(ev.target.value)}
                                                                    className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none resize-y min-h-[24px] max-h-[48px]"
                                                                    rows={2}
                                                                />
                                                                <div className="flex gap-1.5 justify-end">
                                                                    <button onClick={handleSaveEdit} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1">
                                                                        <Check size={8} /> Save
                                                                    </button>
                                                                    <button onClick={() => setEditingId(null)} className="text-[9px] text-text-dim hover:text-red-400 px-1">
                                                                        Cancel
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        ) : knownByEditingId === e.id ? (
                                                            <KnownByEditor
                                                                key={e.id}
                                                                entry={e}
                                                                npcLedger={npcLedger ?? []}
                                                                onApply={(kb) => { editDivergenceKnownBy(e.id, kb); setKnownByEditingId(null); }}
                                                                onClose={() => setKnownByEditingId(null)}
                                                            />
                                                        ) : (
                                                            <div key={e.id} className={`flex items-start gap-1 text-[11px] ${e.enabled !== false ? 'text-text-secondary' : 'text-text-dim/50 line-through'}`}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={e.enabled !== false}
                                                                    onChange={() => toggleDivergenceFact(e.id, e.enabled === false)}
                                                                    className="w-2.5 h-2.5 mt-0.5 accent-terminal shrink-0"
                                                                    title={e.enabled !== false ? 'Disable this fact' : 'Enable this fact'}
                                                                />
                                                                <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                                                <span className="min-w-0 flex-1">
                                                                    {e.text}
                                                                    <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                                                    <span className={`text-[9px] ml-1 ${knownByChipClass(e.knownBy)}`}>(known to: {knownBySummary(e.knownBy, npcLedger ?? [])})</span>
                                                                </span>
                                                                <span className="flex items-center gap-0.5 shrink-0">
                                                                    <button onClick={() => setKnownByEditingId(e.id)} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit who knows"><Users size={9} /></button>
                                                                    <button onClick={() => pinDivergenceFact(e.id)} className="text-text-muted hover:text-amber-400 p-0.5" title="Pin"><Pin size={9} /></button>
                                                                    <button onClick={() => handleStartEdit(e)} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit"><Edit2 size={9} /></button>
                                                                    <button onClick={() => deleteDivergenceFact(e.id)} className="text-text-muted hover:text-red-400 p-0.5" title="Delete"><AlertTriangle size={9} className="inline" /></button>
                                                                </span>
                                                            </div>
                                                        )
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}

                    {entries.length === 0 && (
                        <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                            No established facts yet. Facts are extracted when chapters seal.
                        </div>
                    )}
                </div>
            )}

            {tab === 'facts' && factsView === 'subject' && (
                <div className="space-y-2">
                    {pinnedEntries.length > 0 && (
                        <div className="space-y-1">
                            <div className="text-[9px] uppercase font-bold text-amber-400 tracking-wider flex items-center gap-1">
                                <Pin size={9} /> Pinned
                            </div>
                            {pinnedEntries.map(e => (
                                <div key={e.id} className="flex items-start gap-1 text-[11px] text-text-primary">
                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                    <span className="min-w-0 flex-1">
                                        <span className={`${CATEGORY_COLORS[e.category]} text-[9px] uppercase`}>{CATEGORY_LABELS[e.category]}</span>
                                        {' '}{e.text}
                                        <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                                        <span className={`text-[9px] ml-1 ${knownByChipClass(e.knownBy)}`}>(known to: {knownBySummary(e.knownBy, npcLedger ?? [])})</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {subjectGroups.map(group => {
                        const isTokened = group.entries[0].subjectToken !== undefined;
                        const label = isTokened ? subjectLabel(group.token) : '(ungrouped)';
                        const isExpanded = expandedSubject === group.token;
                        const latestSceneRef = group.entries[group.entries.length - 1].sceneRef;

                        return (
                            <div key={group.token} className="border border-border/30 rounded">
                                <button
                                    className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                                    onClick={() => setExpandedSubject(isExpanded ? null : group.token)}
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-[11px] font-bold text-text-primary truncate">{label}</span>
                                        <span className="text-[9px] text-text-dim shrink-0">{group.entries.length} beat{group.entries.length === 1 ? '' : 's'}</span>
                                    </div>
                                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                </button>

                                {isExpanded && (
                                    <div className="border-t border-border/20 px-3 pb-1.5 pt-1 space-y-0.5">
                                        {group.entries.map(e => {
                                            const isLatest = e.sceneRef === latestSceneRef;
                                            return knownByEditingId === e.id ? (
                                                <KnownByEditor
                                                    key={e.id}
                                                    entry={e}
                                                    npcLedger={npcLedger ?? []}
                                                    onApply={(kb) => { editDivergenceKnownBy(e.id, kb); setKnownByEditingId(null); }}
                                                    onClose={() => setKnownByEditingId(null)}
                                                />
                                            ) : (
                                                <div key={e.id} className={`flex items-start gap-1 text-[11px] ${e.enabled !== false ? 'text-text-secondary' : 'text-text-dim/50 line-through'}`}>
                                                    <input
                                                        type="checkbox"
                                                        checked={e.enabled !== false}
                                                        onChange={() => toggleDivergenceFact(e.id, e.enabled === false)}
                                                        className="w-2.5 h-2.5 mt-0.5 accent-terminal shrink-0"
                                                    />
                                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                                    <span className="min-w-0 flex-1">
                                                        <span className="text-text-dim/50 text-[9px]">[#{e.sceneRef}]</span>{' '}
                                                        {e.text}
                                                        {isLatest && group.entries.length > 1 && (
                                                            <span className="ml-1 text-[8px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-1 rounded">latest</span>
                                                        )}
                                                        <span className={`text-[9px] ml-1 ${knownByChipClass(e.knownBy)}`}>(known to: {knownBySummary(e.knownBy, npcLedger ?? [])})</span>
                                                    </span>
                                                    <span className="flex items-center gap-0.5 shrink-0">
                                                        <button onClick={() => setKnownByEditingId(e.id)} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit who knows">
                                                            <Users size={9} />
                                                        </button>
                                                        <button onClick={() => pinDivergenceFact(e.id)} className="text-text-muted hover:text-amber-400 p-0.5"><Pin size={9} /></button>
                                                        <button onClick={() => deleteDivergenceFact(e.id)} className="text-text-muted hover:text-red-400 p-0.5"><Trash2 size={9} /></button>
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {entries.length === 0 && (
                        <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                            No established facts yet. Facts are extracted when chapters seal.
                        </div>
                    )}
                </div>
            )}

            {tab === 'review' && (
                <div className="space-y-1.5">
                    {reviewEntries.length === 0 ? (
                        <p className="text-[10px] text-text-dim italic py-4 text-center">No entries flagged for review.</p>
                    ) : (
                        reviewEntries.map(e => (
                            <div key={e.id} className="bg-amber-900/20 border border-amber-500/40 p-1.5 rounded">
                                <div className="flex items-start gap-1.5 text-[10px]">
                                    <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                                    <div className="min-w-0 flex-1">
                                        <span className="text-amber-400 font-bold text-[9px] mr-1">[REVIEW]</span>
                                        <span className="text-text-primary">{e.text}</span>
                                        <span className="text-text-dim ml-1 text-[9px]">[#{e.sceneRef}]</span>
                                        {e.unrecognizedNpcNames && e.unrecognizedNpcNames.length > 0 && (
                                            <div className="text-[9px] text-amber-300 mt-0.5">
                                                Unrecognized: {e.unrecognizedNpcNames.join(', ')}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-1.5 mt-1 ml-3.5">
                                    <button onClick={() => confirmReviewEntry(e.id)} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10">
                                        <Check size={8} /> Keep
                                    </button>
                                    <button onClick={() => deleteReviewedEntry(e.id)} className="flex items-center gap-0.5 text-[9px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-500/10">
                                        <AlertTriangle size={8} /> Delete
                                    </button>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            )}

            <DedupReviewModal
                open={dedupOpen}
                running={dedupRunning}
                progress={dedupProgress}
                groups={dedupResult?.groups ?? null}
                failedBuckets={dedupResult?.failedBuckets ?? []}
                selections={dedupSelections}
                error={dedupError}
                entries={entries}
                onCancel={handleCloseDedup}
                onStop={handleStopDedup}
                onToggleDisable={handleToggleDisable}
                onSkipGroup={handleSkipGroup}
                onApply={handleApplyDedup}
            />
        </div>
    );
}