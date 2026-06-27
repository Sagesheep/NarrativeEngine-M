import { useState } from 'react';
import { Package, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { useLootDropHistory, clearLootDropHistory } from '../services/engine';
import type { LootDropRecord } from '../services/engine';

/**
 * Loot Engine WO-05 — debug trace view. Collapsible dropdown showing each
 * resolved loot drop: items, the bare [LOOT DROP: ...] tag, the walker trace
 * (node ids + draws + rolls), and the armed opts (rolls + reweight). Mirrors
 * the PayloadTraceView's row styling so it reads as a sibling diagnostic.
 *
 * Mounted in BOTH the DebugPanel (its own dropdown) and the context-bank
 * diagnostics (RulesTab) as a separate area — same component, two surfaces.
 */

const fmtTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const ReweightPill: React.FC<{ reweight?: Record<string, Record<string, number>> }> = ({ reweight }) => {
    if (!reweight) return null;
    const zeroed: string[] = [];
    for (const [nodeId, opts] of Object.entries(reweight)) {
        for (const [opt, w] of Object.entries(opts)) {
            if (w <= 0) zeroed.push(`${nodeId}/${opt}`);
        }
    }
    if (zeroed.length === 0) return null;
    return (
        <span className="text-[9px] text-amber-400/80 font-mono">
            · excluded: {zeroed.join(', ')}
        </span>
    );
};

const DropRow: React.FC<{ record: LootDropRecord }> = ({ record }) => {
    const [open, setOpen] = useState(false);
    const hasTrace = record.trace.length > 0;
    const expandable = hasTrace || record.items.length > 0;
    return (
        <div className={`border-l-2 ${record.empty ? 'border-red-500/50 bg-red-500/5' : 'border-terminal/50 bg-terminal/5'}`}>
            <div
                className={`p-2 ${expandable ? 'cursor-pointer hover:bg-terminal/10' : ''}`}
                onClick={expandable ? () => setOpen(o => !o) : undefined}
            >
                <div className="flex justify-between items-start mb-1">
                    <div className="flex flex-col">
                        <div className="flex items-center gap-1">
                            {expandable && (open
                                ? <ChevronDown size={10} className="text-terminal/50 shrink-0" />
                                : <ChevronRight size={10} className="text-terminal/50 shrink-0" />
                            )}
                            <span className={`font-bold uppercase tracking-tighter ${record.empty ? 'text-red-400' : 'text-terminal'}`}>
                                {record.empty ? 'EMPTY DROP' : `${record.items.length} item${record.items.length === 1 ? '' : 's'}`}
                            </span>
                            <span className="text-[8px] text-text-dim/70 font-mono">{fmtTime(record.resolvedAt)} · rolls {record.rolls}</span>
                        </div>
                    </div>
                </div>
                {record.empty ? (
                    <div className="flex items-center gap-1 text-text-dim italic">
                        <Info size={10} />
                        All eligible options reweighted to 0 — walker produced no items.
                    </div>
                ) : (
                    <div className="flex items-center gap-1 text-text-dim italic">
                        <Info size={10} />
                        <span className="font-mono not-italic">{record.appendToInput.trim()}</span>
                    </div>
                )}
                <div className="mt-1">
                    <ReweightPill reweight={record.reweight} />
                </div>
            </div>
            {open && record.items.length > 0 && (
                <div className="border-t border-terminal/10 px-3 py-2 space-y-1">
                    {record.items.map((item, i) => (
                        <div key={i} className="text-[10px]">
                            <div className="text-terminal font-bold font-mono">{i + 1}. {item.label}</div>
                            {Object.keys(item.parts).length > 0 && (
                                <div className="text-[9px] text-text-dim/70 font-mono pl-3">
                                    {Object.entries(item.parts).map(([k, v]) => `${k}=${v}`).join(' · ')}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {open && hasTrace && (
                <div className="border-t border-terminal/10 px-3 py-2">
                    <div className="text-[8px] text-text-dim uppercase tracking-wider mb-1">Walker Trace</div>
                    <pre className="text-[9px] text-text-dim/80 whitespace-pre-wrap break-words max-h-48 overflow-y-auto font-mono leading-snug">
                        {record.trace.join('\n')}
                    </pre>
                </div>
            )}
        </div>
    );
};

export const LootDropTraceView: React.FC<{ compact?: boolean }> = ({ compact }) => {
    const history = useLootDropHistory();
    const [expanded, setExpanded] = useState(false);

    if (history.length === 0) {
        return (
            <div className={`bg-void-darker border border-terminal/30 rounded font-mono text-[10px] p-3 ${compact ? 'opacity-70' : ''}`}>
                <div className="flex items-center gap-2 text-text-dim italic">
                    <Package size={12} />
                    <span>No loot drops resolved yet{compact ? ' (arm via Loot button)' : ''}.</span>
                </div>
            </div>
        );
    }

    const last = history[0];

    return (
        <div className="bg-void-darker border border-terminal/30 rounded font-mono text-[10px] overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-terminal/20">
                <Package size={14} className="text-terminal" />
                <span className="text-terminal uppercase tracking-widest font-bold">Loot Drops</span>
                <div className="ml-auto flex items-center gap-2 text-text-dim">
                    <span className="text-[9px]">{history.length} resolved · last: {last.empty ? '∅' : `${last.items.length} item${last.items.length === 1 ? '' : 's'}`}</span>
                    <button
                        onClick={() => clearLootDropHistory()}
                        className="text-[9px] text-text-dim hover:text-danger transition-colors uppercase tracking-wider"
                    >
                        Clear
                    </button>
                </div>
            </div>

            <div className="p-2 space-y-2">
                <div className="border border-terminal/20 rounded overflow-hidden">
                    <button
                        onClick={() => setExpanded(e => !e)}
                        className="w-full flex items-center gap-2 p-2 hover:bg-terminal/5 text-left"
                    >
                        {expanded
                            ? <ChevronDown size={12} className="text-terminal shrink-0" />
                            : <ChevronRight size={12} className="text-terminal shrink-0" />
                        }
                        <span className="text-terminal uppercase tracking-widest font-bold">Recent Drops</span>
                        <span className="ml-auto text-text-dim text-[9px] shrink-0">{history.length} record{history.length === 1 ? '' : 's'}</span>
                    </button>
                    {expanded && (
                        <div className="border-t border-terminal/20 p-2 space-y-2">
                            {history.map((record, idx) => <DropRow key={idx} record={record} />)}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

