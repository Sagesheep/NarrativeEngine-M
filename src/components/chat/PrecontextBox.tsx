import { useState } from 'react';
import { ChevronDown, ChevronRight, BookOpen } from 'lucide-react';

type Props = {
    summary: string;
};

// Smart Retry v1: collapsed-by-default box rendered above the assistant prose
// to make the "precontext gathered" step visible and separate from the story
// AI output. `expanded` is local UI state (NOT on the message) per Fable 5
// finding 8 — avoids store writes + debounced save + memo-bust on every tap.
// v1 shows only the summary line; v2 may expand to a per-stage breakdown.
export function PrecontextBox({ summary }: Props) {
    const [expanded, setExpanded] = useState(false);

    return (
        <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="w-full flex items-center gap-2 text-[10px] uppercase tracking-widest text-text-dim/80 hover:text-text-dim bg-void-lighter/40 hover:bg-void-lighter/70 rounded-sm border border-terminal/5 px-3 py-1.5 mb-2 transition-colors text-left select-none"
            title={expanded ? 'Collapse gathered context' : 'Expand gathered context'}
        >
            {expanded
                ? <ChevronDown size={11} className="shrink-0" />
                : <ChevronRight size={11} className="shrink-0" />}
            <BookOpen size={11} className="shrink-0 text-terminal/50" />
            <span className="truncate">
                {expanded ? 'Context gathered' : summary}
            </span>
        </button>
    );
}