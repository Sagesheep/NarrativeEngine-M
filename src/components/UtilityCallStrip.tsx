import { useState, useEffect } from 'react';
import { useUtilityCalls, extendCall } from '../services/llm/utilityCallTracker';

const LABEL_MAP: Record<string, string> = {
    'expandQuery': 'Query Expansion',
    'rerank-scene': 'Reranking Scenes',
    'rerank-lore': 'Reranking Lore',
    'recommender': 'AI Recommender',
    'planner': 'Planner',
};

export function UtilityCallStrip() {
    const { active } = useUtilityCalls();
    const [, setTick] = useState(0);

    useEffect(() => {
        if (active.length === 0) return;
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, [active.length]);

    if (active.length === 0) return null;

    return (
        <div className="border-b border-terminal/20 bg-terminal/5">
            {active.map(call => {
                const now = Date.now();
                const elapsed = Math.floor((now - call.startedAt) / 1000);
                const totalSec = Math.floor(call.initialTimeoutMs / 1000);
                const remaining = Math.max(0, Math.floor((call.deadline - now) / 1000));
                const isWarning = remaining <= Math.floor(totalSec * 0.25) && remaining > 0;
                const isExpired = remaining === 0;
                const displayName = LABEL_MAP[call.label] ?? call.label;

                return (
                    <div key={call.id} className="flex items-center gap-2 px-4 py-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isExpired ? 'bg-red-500' : isWarning ? 'bg-amber-400 animate-pulse' : 'bg-terminal animate-pulse'}`} />
                        <span className={`text-[9px] uppercase tracking-widest font-bold font-mono flex-1 truncate ${isExpired ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-terminal'}`}>
                            {displayName}
                            <span className="text-text-dim font-normal normal-case tracking-normal ml-1">— {call.endpointName}</span>
                            <span className={`ml-2 ${isWarning || isExpired ? '' : 'text-text-dim'}`}>
                                {elapsed}s / {totalSec + call.extensions * 60}s
                            </span>
                            {call.extensions > 0 && (
                                <span className="ml-1 text-text-dim">(+{call.extensions}ext)</span>
                            )}
                        </span>
                        <button
                            onClick={() => extendCall(call.id, 60000)}
                            className="shrink-0 text-[9px] uppercase tracking-wider font-bold px-2 py-1 border rounded transition-colors border-terminal/40 text-terminal/70 hover:text-terminal hover:border-terminal hover:bg-terminal/10 min-h-[28px]"
                        >
                            EXTEND +1m
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
