import { memo, useState, type ReactNode } from 'react';
import { Edit2, Check, Pin, PinOff, Trash2, Users, X, Undo2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { DivergenceEntry } from '../../types';
import { CATEGORY_LABELS, normalizeFaction } from '../../services/campaign-state';
import { CATEGORY_COLORS, CATEGORY_DOTS, knownByTokenLabel, knownBySummary, knownByChipClass, type NpcNameMap } from './memoryTabHelpers';

/** A later fact in the same state slot replaced this one; it is no longer sent to the GM. */
function ReplacedTag({ entry }: { entry: DivergenceEntry }) {
    const restoreDivergenceFact = useAppStore(s => s.restoreDivergenceFact);
    if (entry.status !== 'superseded') return null;
    return (
        <span className="ml-1 inline-flex items-center gap-0.5 text-[8px] uppercase font-bold text-text-dim bg-white/5 px-1 rounded" title="A later fact replaced this one; it is no longer sent to the GM">
            replaced
            <button onClick={() => restoreDivergenceFact(entry.id)} className="hover:text-emerald-400 normal-case" title="Restore: send this fact to the GM again">
                <Undo2 size={8} />
            </button>
        </span>
    );
}

/** The state slot this fact fills, e.g. npc:npc_5:location. */
function SlotTag({ stateKey }: { stateKey?: string }) {
    if (!stateKey) return null;
    return <span className="ml-1 text-[8px] font-mono text-ice/70" title="State slot — a newer fact in this slot replaces this one">{stateKey}</span>;
}

/** KnownBy editor popover — inline, matches existing inline-edit pattern. */
function KnownByEditor({ entry, npcNames, onApply, onClose }: {
    entry: DivergenceEntry;
    npcNames: NpcNameMap;
    onApply: (knownBy: string[] | undefined) => void;
    onClose: () => void;
}) {
    const npcLedger = useAppStore(s => s.npcLedger) ?? [];
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
                        {knownByTokenLabel(t, npcNames)}
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

/**
 * One fact, shared by every Knowledge view. Edit and known-by state live here, so
 * typing in an edit box re-renders this row only, not the whole tab. Memoized: a
 * store update re-renders only the rows whose entry object changed.
 */
export const FactRow = memo(function FactRow({ entry: e, npcNames, showCategory, isLatest }: {
    entry: DivergenceEntry;
    npcNames: NpcNameMap;
    /** Prefix the category label (views not already grouped by category). */
    showCategory?: boolean;
    /** Mark as the newest beat of its subject timeline. */
    isLatest?: boolean;
}) {
    const toggleDivergenceFact = useAppStore(s => s.toggleDivergenceFact);
    const pinDivergenceFact = useAppStore(s => s.pinDivergenceFact);
    const editDivergenceFact = useAppStore(s => s.editDivergenceFact);
    const editDivergenceKnownBy = useAppStore(s => s.editDivergenceKnownBy);
    const deleteDivergenceFact = useAppStore(s => s.deleteDivergenceFact);

    const [mode, setMode] = useState<'view' | 'edit' | 'knownBy'>('view');
    const [editText, setEditText] = useState('');

    if (mode === 'edit') {
        return (
            <div className="bg-void border border-amber-500/30 p-1.5 rounded space-y-1">
                <textarea
                    value={editText}
                    onChange={ev => setEditText(ev.target.value)}
                    className="w-full bg-void border border-white/10 text-text-primary text-[10px] px-1 py-0.5 rounded outline-none resize-y min-h-[24px] max-h-[48px]"
                    rows={2}
                />
                <div className="flex gap-1.5 justify-end">
                    <button onClick={() => { editDivergenceFact(e.id, editText); setMode('view'); }} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1">
                        <Check size={8} /> Save
                    </button>
                    <button onClick={() => setMode('view')} className="text-[9px] text-text-dim hover:text-red-400 px-1">
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    if (mode === 'knownBy') {
        return (
            <KnownByEditor
                entry={e}
                npcNames={npcNames}
                onApply={(kb) => { editDivergenceKnownBy(e.id, kb); setMode('view'); }}
                onClose={() => setMode('view')}
            />
        );
    }

    const enabled = e.enabled !== false;
    return (
        <div className={`flex items-start gap-1 text-[11px] ${enabled ? (e.pinned ? 'text-text-primary' : 'text-text-secondary') : 'text-text-dim/50 line-through'}`}>
            <input
                type="checkbox"
                checked={enabled}
                onChange={() => toggleDivergenceFact(e.id, !enabled)}
                className="w-2.5 h-2.5 mt-0.5 accent-terminal shrink-0"
                title={enabled ? 'Disable this fact' : 'Enable this fact'}
            />
            <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
            <span className="min-w-0 flex-1">
                {showCategory && <span className={`${CATEGORY_COLORS[e.category]} text-[9px] uppercase`}>{CATEGORY_LABELS[e.category]} </span>}
                {e.text}
                <ReplacedTag entry={e} />
                <SlotTag stateKey={e.stateKey} />
                {isLatest && (
                    <span className="ml-1 text-[8px] uppercase font-bold text-emerald-400 bg-emerald-500/10 px-1 rounded">latest</span>
                )}
                <span className="text-text-dim/40 text-[9px]"> [#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span>
                <span className={`text-[9px] ml-1 ${knownByChipClass(e.knownBy)}`}>(known to: {knownBySummary(e.knownBy, npcNames)})</span>
            </span>
            <span className="flex items-center gap-0.5 shrink-0">
                <button onClick={() => setMode('knownBy')} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit who knows"><Users size={9} /></button>
                <button onClick={() => pinDivergenceFact(e.id)} className={`${e.pinned ? 'text-amber-400' : 'text-text-muted hover:text-amber-400'} p-0.5`} title={e.pinned ? 'Unpin' : 'Pin'}>
                    {e.pinned ? <PinOff size={9} /> : <Pin size={9} />}
                </button>
                <button onClick={() => { setEditText(e.text); setMode('edit'); }} className="text-text-muted hover:text-amber-400 p-0.5" title="Edit"><Edit2 size={9} /></button>
                <button onClick={() => deleteDivergenceFact(e.id)} className="text-text-muted hover:text-red-400 p-0.5" title="Delete"><Trash2 size={9} /></button>
            </span>
        </div>
    );
});

const PAGE = 50;

/** Renders the first PAGE rows, then a "show more" button — keeps big groups cheap to open. */
export function PagedFacts({ entries, render }: {
    entries: DivergenceEntry[];
    render: (e: DivergenceEntry) => ReactNode;
}) {
    const [shown, setShown] = useState(PAGE);
    const rest = entries.length - shown;
    return (
        <>
            {entries.slice(0, shown).map(render)}
            {rest > 0 && (
                <button
                    onClick={() => setShown(shown + PAGE)}
                    className="w-full text-[9px] uppercase tracking-widest font-bold text-terminal hover:bg-terminal/10 rounded py-0.5"
                >
                    Show {Math.min(PAGE, rest)} more ({rest} left)
                </button>
            )}
        </>
    );
}
