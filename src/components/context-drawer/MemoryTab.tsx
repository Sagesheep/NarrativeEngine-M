import { useState, useRef, useMemo, useDeferredValue } from 'react';
import { Pin, ChevronDown, ChevronUp, AlertTriangle, Trash2, Sparkles, X, Link2, Search, Check, Layers } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { DivergenceCategory, DivergenceEntry } from '../../types';
import { EMPTY_REGISTER, CATEGORY_LABELS, DIVERGENCE_CATEGORIES, runFactDedup, assignSubjectTokens, type DedupResult, type DedupCancelled, type ClusteringCancelled, groupDivergencesBySubject, renderRegisterForPayload, assignStateKeys, type StateKeyCancelled } from '../../services/campaign-state';
import { countTokens } from '../../services/infrastructure';
import { divergenceCapFor } from '../../services/payload';
import { DedupReviewModal } from '../DedupReviewModal';
import { appConfirm } from '../ConfirmSheet';
import { FactRow, PagedFacts } from './FactRow';
import { CATEGORY_COLORS, CATEGORY_DOTS, subjectLabel, buildNpcNameMap, matchesFactFilter, FACT_FILTERS, type FactFilter } from './memoryTabHelpers';

type Tab = 'facts' | 'review';
type FactsView = 'chapter' | 'topic' | 'subject';

const UNGROUPED = '__ungrouped';

export function MemoryTab() {
    const divergenceRegister = useAppStore(s => s.divergenceRegister);
    const chapters = useAppStore(s => s.chapters);
    const contextLimit = useAppStore(s => s.settings.contextLimit) || 8192;
    const deleteDivergenceChapter = useAppStore(s => s.deleteDivergenceChapter);
    const confirmReviewEntry = useAppStore(s => s.confirmReviewEntry);
    const deleteReviewedEntry = useAppStore(s => s.deleteReviewedEntry);
    const toggleDivergenceChapter = useAppStore(s => s.toggleDivergenceChapter);
    const toggleDivergenceCategory = useAppStore(s => s.toggleDivergenceCategory);
    const applySubjectTokens = useAppStore(s => s.applySubjectTokens);
    const applyDivergenceStateKeys = useAppStore(s => s.applyDivergenceStateKeys);
    const setManyFactsEnabled = useAppStore(s => s.setManyFactsEnabled);
    const npcLedger = useAppStore(s => s.npcLedger);
    const getActiveUtilityEndpoint = useAppStore(s => s.getActiveUtilityEndpoint);

    const [tab, setTab] = useState<Tab>('facts');
    const [factsView, setFactsView] = useState<FactsView>('chapter');
    const [expandedChapter, setExpandedChapter] = useState<string | null>(null);
    const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
    const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<FactFilter>('all');
    const deferredQuery = useDeferredValue(query.trim());

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

    // "Build current state" migration — keys old facts into state slots.
    const [stateRunning, setStateRunning] = useState(false);
    const stateCancelRef = useRef<StateKeyCancelled>({ cancelled: false });

    const reg = divergenceRegister ?? EMPTY_REGISTER;
    const entries = reg.entries;
    const npcNames = useMemo(() => buildNpcNameMap(npcLedger ?? []), [npcLedger]);

    // Tokens of the cached canon block as actually sent (public facts only), against
    // the cap that collapses oldest chapters. Tokenizing is the expensive bit — only
    // redo it when the register or chapter titles change.
    const canonTokens = useMemo(
        () => countTokens(renderRegisterForPayload(reg, chapters, undefined, undefined, true)),
        [reg, chapters],
    );
    const canonCap = divergenceCapFor(contextLimit);

    // Everything below depends only on the register — recomputed when it changes,
    // not on every expand/collapse or keystroke.
    const derived = useMemo(() => {
        const pinned: DivergenceEntry[] = [];
        const unpinned: DivergenceEntry[] = [];
        const review: DivergenceEntry[] = [];
        let active = 0;
        for (const e of entries) {
            (e.pinned ? pinned : unpinned).push(e);
            if (e.reviewFlag) review.push(e);
            if (e.enabled === false || e.status === 'superseded' || e.status === 'retracted') continue;
            if (!e.pinned) {
                if (reg.chapterToggles[e.chapterId] === false) continue;
                if (reg.categoryToggles[e.chapterId]?.[e.category] === false) continue;
            }
            active++;
        }

        const byChapter = new Map<string, Map<DivergenceCategory, DivergenceEntry[]>>();
        const byCategory = new Map<DivergenceCategory, DivergenceEntry[]>(DIVERGENCE_CATEGORIES.map(c => [c, []]));
        for (const e of unpinned) {
            let cats = byChapter.get(e.chapterId);
            if (!cats) byChapter.set(e.chapterId, cats = new Map());
            let list = cats.get(e.category);
            if (!list) cats.set(e.category, list = []);
            list.push(e);
            byCategory.get(e.category)!.push(e);
        }

        // Untagged facts would each be their own one-fact "group" — fold them into
        // a single Ungrouped bucket at the end instead.
        const subjectGroups: Array<{ token: string; entries: DivergenceEntry[] }> = [];
        const ungrouped: DivergenceEntry[] = [];
        for (const g of groupDivergencesBySubject(unpinned)) {
            if (g.entries[0].subjectToken === undefined) ungrouped.push(...g.entries);
            else subjectGroups.push(g);
        }
        if (ungrouped.length > 0) subjectGroups.push({ token: UNGROUPED, entries: ungrouped });

        return { pinned, review, active, byChapter, byCategory, subjectGroups };
    }, [entries, reg.chapterToggles, reg.categoryToggles]);
    const { pinned: pinnedEntries, review: reviewEntries, active: activeCount, byChapter, byCategory, subjectGroups } = derived;

    const chapterTitleMap = useMemo(
        () => new Map((chapters ?? []).map(ch => [ch.chapterId, ch.title])),
        [chapters],
    );

    const searching = deferredQuery !== '' || filter !== 'all';
    const searchResults = useMemo(
        () => searching ? entries.filter(e => matchesFactFilter(e, filter, deferredQuery, npcNames)) : [],
        [searching, entries, filter, deferredQuery, npcNames],
    );

    const renderRow = (e: DivergenceEntry) => <FactRow key={e.id} entry={e} npcNames={npcNames} />;
    const renderRowWithCategory = (e: DivergenceEntry) => <FactRow key={e.id} entry={e} npcNames={npcNames} showCategory />;
    const pinnedCount = pinnedEntries.length;

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

    const handleBuildCurrentState = async () => {
        const utilityProvider = getActiveUtilityEndpoint();
        if (!utilityProvider) {
            setSimError('No utility AI endpoint configured.');
            return;
        }
        if (!await appConfirm({
            title: 'Build current state',
            body: 'The utility AI sorts your existing facts into state slots (where someone is, who holds what, who leads what…). In each slot only the newest fact stays active; older ones are marked "replaced" and stop being sent to the GM. Nothing is deleted — replaced facts can be restored. Large registers take several AI calls.',
            confirmLabel: 'Build',
        })) return;

        setStateRunning(true);
        setSimSummary(null);
        setSimError(null);
        stateCancelRef.current = { cancelled: false };
        try {
            const updates = await assignStateKeys(reg, npcLedger ?? [], utilityProvider, stateCancelRef.current, setSimStatus);
            const { keyed, superseded } = applyDivergenceStateKeys(updates);
            setSimSummary(`Keyed ${keyed} fact${keyed === 1 ? '' : 's'} into state slots · ${superseded} older value${superseded === 1 ? '' : 's'} replaced.`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg !== 'Build current state cancelled.') setSimError(msg);
        } finally {
            setStateRunning(false);
            setSimStatus(null);
        }
    };

    const handleStopSimilarity = () => {
        simCancelRef.current.cancelled = true;
        stateCancelRef.current.cancelled = true;
        setStateRunning(false);
        setSimRunning(false);
        setSimStatus(null);
    };

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

            <div className="text-[9px] text-text-dim" title="Tokens of the public-facts block sent every turn, against the cap (20% of context) past which the oldest chapters are collapsed">
                <span className={canonTokens > canonCap ? 'text-amber-400' : ''}>{canonTokens}/{canonCap} tkns</span>
                {' '}· {activeCount} active{pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}
                {canonTokens > canonCap && <span className="text-amber-400"> · oldest chapters collapsed when sent</span>}
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
                    <button
                        onClick={handleBuildCurrentState}
                        disabled={stateRunning || simRunning}
                        className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded text-ice bg-ice/10 hover:bg-ice/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title="Sort existing facts into state slots so only the newest value per slot is sent to the GM. Older values are kept as 'replaced'."
                    >
                        <Layers size={9} />
                        Build Current State
                    </button>
                    {(simRunning || stateRunning) && (
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
            {tab === 'facts' && simSummary && !simRunning && !stateRunning && (
                <div className="text-[9px] text-purple-400">{simSummary}</div>
            )}
            {tab === 'facts' && simError && !simRunning && !stateRunning && (
                <div className="text-[9px] text-red-400">{simError}</div>
            )}

            {tab === 'facts' && entries.length > 0 && (
                <div className="space-y-1">
                    <div className="flex items-center gap-1 bg-void border border-border/40 rounded px-1.5">
                        <Search size={10} className="text-text-dim shrink-0" />
                        <input
                            type="text"
                            value={query}
                            onChange={ev => setQuery(ev.target.value)}
                            placeholder="Search facts, subjects, NPCs, scene #"
                            className="flex-1 min-w-0 bg-transparent text-[16px] md:text-[11px] text-text-primary py-1 outline-none"
                        />
                        {query && (
                            <button onClick={() => setQuery('')} className="text-text-dim hover:text-red-400 p-0.5" title="Clear search"><X size={10} /></button>
                        )}
                    </div>
                    <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                        {FACT_FILTERS.map(f => (
                            <button
                                key={f.id}
                                onClick={() => setFilter(f.id)}
                                className={`text-[9px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${filter === f.id ? 'text-ice bg-ice/10' : 'text-text-dim'}`}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {tab === 'facts' && searching && (
                <div className="space-y-0.5">
                    <div className="text-[9px] text-text-dim">{searchResults.length} match{searchResults.length === 1 ? '' : 'es'}</div>
                    <PagedFacts key={`${filter}|${deferredQuery}`} entries={searchResults} render={renderRowWithCategory} />
                </div>
            )}

            {tab === 'facts' && !searching && (
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

            {tab === 'facts' && !searching && factsView !== 'topic' && pinnedEntries.length > 0 && (
                <div className="space-y-1">
                    <div className="text-[9px] uppercase font-bold text-amber-400 tracking-wider flex items-center gap-1">
                        <Pin size={9} /> Pinned
                    </div>
                    <PagedFacts entries={pinnedEntries} render={renderRowWithCategory} />
                </div>
            )}

            {tab === 'facts' && !searching && factsView === 'topic' && (
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
                                        <PagedFacts entries={catEntries} render={renderRow} />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {tab === 'facts' && !searching && factsView === 'chapter' && (
                <div className="space-y-3">
                    {[...byChapter.entries()].map(([chapterId, catGroups]) => {
                        const chapterTitle = chapterTitleMap.get(chapterId) ?? chapterId;
                        const chapterOn = reg.chapterToggles[chapterId] !== false;
                        const isExpanded = expandedChapter === chapterId;
                        let chapterCount = 0;
                        for (const list of catGroups.values()) chapterCount += list.length;

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
                                        <span className="text-[9px] text-text-dim">{chapterCount} facts</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={async (ev) => {
                                                ev.stopPropagation();
                                                if (await appConfirm({
                                                    title: 'Delete facts',
                                                    body: `Delete all ${chapterCount} facts in "${chapterTitle}"?`,
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
                                                    <PagedFacts entries={catEntries} render={renderRow} />
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            )}

            {tab === 'facts' && !searching && factsView === 'subject' && (
                <div className="space-y-2">
                    {subjectGroups.map(group => {
                        const isUngrouped = group.token === UNGROUPED;
                        const label = isUngrouped ? 'Ungrouped' : subjectLabel(group.token);
                        const isExpanded = expandedSubject === group.token;
                        const latestSceneRef = group.entries[group.entries.length - 1].sceneRef;
                        const showLatest = !isUngrouped && group.entries.length > 1;

                        return (
                            <div key={group.token} className="border border-border/30 rounded">
                                <button
                                    className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                                    onClick={() => setExpandedSubject(isExpanded ? null : group.token)}
                                >
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className={`text-[11px] font-bold truncate ${isUngrouped ? 'text-text-dim italic' : 'text-text-primary'}`}>{label}</span>
                                        <span className="text-[9px] text-text-dim shrink-0">
                                            {group.entries.length} {isUngrouped ? 'fact' : 'beat'}{group.entries.length === 1 ? '' : 's'}
                                        </span>
                                    </div>
                                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                </button>

                                {isExpanded && (
                                    <div className="border-t border-border/20 px-3 pb-1.5 pt-1 space-y-0.5">
                                        {isUngrouped && (
                                            <div className="text-[9px] text-text-dim/70 italic">No subject yet — run Find Similarity to group these.</div>
                                        )}
                                        <PagedFacts
                                            entries={group.entries}
                                            render={e => (
                                                <FactRow
                                                    key={e.id}
                                                    entry={e}
                                                    npcNames={npcNames}
                                                    showCategory={isUngrouped}
                                                    isLatest={showLatest && e.sceneRef === latestSceneRef}
                                                />
                                            )}
                                        />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {tab === 'facts' && entries.length === 0 && (
                <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                    No established facts yet. Facts are extracted when chapters seal.
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