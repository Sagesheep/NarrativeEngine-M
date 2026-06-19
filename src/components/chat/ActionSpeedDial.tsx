import { useState, useEffect, useRef } from 'react';
import { MoreHorizontal, Zap, Pin } from 'lucide-react';
import { ArcInjectorButton } from './ArcInjectorButton';

type ActionSpeedDialProps = {
    onTrim: () => void;
    pinnedCount: number;
    onOpenPins: () => void;
    trimDisabled: boolean;
};

export function ActionSpeedDial({ onTrim, pinnedCount, onOpenPins, trimDisabled }: ActionSpeedDialProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => setOpen(v => !v)}
                className={`flex items-center justify-center w-[32px] h-[32px] rounded transition-colors touch-btn ${
                    open ? 'bg-terminal/20 text-terminal' : 'text-text-dim hover:text-terminal hover:bg-terminal/10'
                }`}
                aria-label="Action menu"
            >
                <MoreHorizontal size={18} />
            </button>
            {open && (
                <div className="absolute bottom-full left-0 mb-2 flex flex-col gap-1.5 z-50">
                    <button
                        onClick={() => { onTrim(); setOpen(false); }}
                        disabled={trimDisabled}
                        className="shrink-0 flex items-center gap-1.5 bg-void border border-terminal/30 text-terminal text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all disabled:opacity-40 whitespace-nowrap"
                    >
                        <Zap size={13} /> TRIM
                    </button>
                    <ArcInjectorButton onDone={() => setOpen(false)} />
                    <button
                        onClick={() => { onOpenPins(); setOpen(false); }}
                        className="relative shrink-0 flex items-center gap-1.5 bg-void border border-terminal/20 text-text-dim hover:text-terminal text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all hover:bg-terminal/5 hover:border-terminal/40 whitespace-nowrap"
                    >
                        <Pin size={13} /> PINS
                        {pinnedCount > 0 && (
                            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 bg-terminal text-void text-[9px] font-bold rounded-full flex items-center justify-center px-1">
                                {pinnedCount}
                            </span>
                        )}
                    </button>
                </div>
            )}
        </div>
    );
}