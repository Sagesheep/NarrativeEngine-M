import React, { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { Activity, Info, ChevronDown, ChevronRight } from 'lucide-react';
import type { PayloadTrace } from '../types';

const TraceRow: React.FC<{ trace: PayloadTrace }> = ({ trace }) => (
    <div className={`p-2 border-l-2 ${trace.included ? 'border-terminal/50 bg-terminal/5' : 'border-red-500/50 bg-red-500/5 opacity-60'}`}>
        <div className="flex justify-between items-start mb-1">
            <div className="flex flex-col">
                <span className={`font-bold uppercase tracking-tighter ${trace.included ? 'text-terminal' : 'text-red-400'}`}>
                    {trace.source}
                </span>
                <span className="text-[8px] text-text-dim/70 uppercase">{trace.classification} @ {trace.position || 'N/A'}</span>
            </div>
            <div className="text-[9px] font-bold text-text-dim">
                {trace.tokens} tokens
            </div>
        </div>
        <div className="flex items-center gap-1 text-text-dim italic">
            <Info size={10} />
            {trace.reason}
        </div>
    </div>
);

export const PayloadTraceView: React.FC = () => {
    const { lastPayloadTrace, settings } = useAppStore();
    const [expanded, setExpanded] = useState({ included: true, excluded: false });

    if (!settings.debugMode || !lastPayloadTrace || lastPayloadTrace.length === 0) {
        return null;
    }

    const toggle = (key: 'included' | 'excluded') =>
        setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

    const included = lastPayloadTrace.filter(t => t.included);
    const excluded = lastPayloadTrace.filter(t => !t.included);
    const includedTokens = included.reduce((acc, t) => acc + t.tokens, 0);
    const excludedTokens = excluded.reduce((acc, t) => acc + t.tokens, 0);
    const budgetRemaining = settings.contextLimit - includedTokens;

    return (
        <div className="mt-4 bg-void-darker border border-terminal/30 rounded font-mono text-[10px] overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-terminal/20">
                <Activity size={14} className="text-terminal" />
                <span className="text-terminal uppercase tracking-widest font-bold">Payload Trace</span>
                <div className="ml-auto text-text-dim">
                    Total: <span className="text-terminal font-bold">{includedTokens}</span> / {settings.contextLimit}
                </div>
            </div>

            <div className="p-2 space-y-2">
                {/* Included Sources */}
                <div className="border border-terminal/20 rounded overflow-hidden">
                    <button
                        onClick={() => toggle('included')}
                        className="w-full flex items-center gap-2 p-2 hover:bg-terminal/5 text-left"
                    >
                        {expanded.included ? <ChevronDown size={12} className="text-terminal shrink-0" /> : <ChevronRight size={12} className="text-terminal shrink-0" />}
                        <span className="text-terminal uppercase tracking-widest font-bold">Included Sources</span>
                        <span className="ml-auto text-text-dim text-[9px] shrink-0">{included.length} sources · {includedTokens} tokens</span>
                    </button>
                    {expanded.included && included.length > 0 && (
                        <div className="border-t border-terminal/20 p-2 space-y-2">
                            {included.map((trace, idx) => <TraceRow key={idx} trace={trace} />)}
                        </div>
                    )}
                    {expanded.included && included.length === 0 && (
                        <div className="border-t border-terminal/20 p-2 text-text-dim italic">None</div>
                    )}
                </div>

                {/* Excluded Sources */}
                {excluded.length > 0 && (
                    <div className="border border-red-500/20 rounded overflow-hidden">
                        <button
                            onClick={() => toggle('excluded')}
                            className="w-full flex items-center gap-2 p-2 hover:bg-red-500/5 text-left"
                        >
                            {expanded.excluded ? <ChevronDown size={12} className="text-red-400 shrink-0" /> : <ChevronRight size={12} className="text-red-400 shrink-0" />}
                            <span className="text-red-400 uppercase tracking-widest font-bold">Excluded Sources</span>
                            <span className="ml-auto text-text-dim text-[9px] shrink-0">{excluded.length} sources · {excludedTokens} tokens</span>
                        </button>
                        {expanded.excluded && (
                            <div className="border-t border-red-500/20 p-2 space-y-2">
                                {excluded.map((trace, idx) => <TraceRow key={idx} trace={trace} />)}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="px-3 py-2 border-t border-terminal/20 flex justify-between text-text-dim uppercase tracking-tighter">
                <span>Budget Status</span>
                <span className={budgetRemaining < 0 ? 'text-red-400 font-bold' : 'text-terminal'}>
                    {budgetRemaining < 0 ? 'OVERFLOW' : `${budgetRemaining} tokens free`}
                </span>
            </div>
        </div>
    );
};
