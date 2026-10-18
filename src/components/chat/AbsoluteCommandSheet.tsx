import { useEffect, useRef, useState } from 'react';
import { X, OctagonAlert } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useBackHandler } from '../../hooks/useBackHandler';
import { hapticMedium } from '../../utils/haptics';
import { ABSOLUTE_COMMAND_MAX_CHARS, clampAbsoluteCommand } from '../../services/turn/absoluteCommand';

/**
 * AbsoluteCommandSheet — bottom sheet for arming an Absolute Command (port of
 * mainApp's AbsoluteCommandButton modal). The player writes a binding
 * out-of-character instruction; the next send obeys it, with the Director Brief
 * switched off for that turn, then it clears.
 *
 * Modeled on DeepSearchSheet: bottom sheet, useBackHandler for Android back,
 * backdrop click with a 350ms open-guard to dismiss.
 */
export interface AbsoluteCommandSheetProps {
    open: boolean;
    onClose: () => void;
}

export function AbsoluteCommandSheet({ open, onClose }: AbsoluteCommandSheetProps) {
    useBackHandler(open, onClose);
    // The body mounts fresh on each open, so its textarea starts from the armed command.
    return open ? <SheetBody onClose={onClose} /> : null;
}

function SheetBody({ onClose }: { onClose: () => void }) {
    const { armed, setArmed } = useAppStore(useShallow(s => ({
        armed: s.armedAbsoluteCommand,
        setArmed: s.setArmedAbsoluteCommand,
    })));

    const [text, setText] = useState(armed ?? '');
    const openedAtRef = useRef(0);
    useEffect(() => {
        openedAtRef.current = Date.now();
    }, []);

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const clamped = clampAbsoluteCommand(text);

    const handleArm = () => {
        if (!clamped) return;
        setArmed(clamped);
        hapticMedium();
        onClose();
    };

    const handleDisarm = () => {
        setArmed(null);
        onClose();
    };

    return (
        <div
            className="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={handleBackdropClick}
        >
            <div
                className="w-full md:max-w-2xl bg-void-darker border border-border rounded-t-lg md:rounded-lg shadow-2xl max-h-[calc(85*var(--app-vh))] overflow-y-auto animate-in slide-in-from-bottom duration-300"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                        <OctagonAlert size={14} className="text-danger" />
                        <span className="text-[11px] uppercase tracking-widest text-text-dim">
                            Absolute Command
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-text-dim hover:text-text-primary p-1 rounded transition-colors"
                        title="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="px-4 py-3 border-b border-border/50">
                    <p className="text-[12px] text-text-dim leading-relaxed">
                        An out-of-character instruction the GM must follow on your next message, ahead of everything else.
                        Nobody in the story hears it. It applies to that one turn, then clears.
                    </p>
                </div>

                <div className="px-4 py-3 border-b border-border/50">
                    <textarea
                        value={text}
                        onChange={e => setText(e.target.value)}
                        maxLength={ABSOLUTE_COMMAND_MAX_CHARS + 200}
                        placeholder={'e.g. "Skip ahead to the next morning." or "Have the guard let us through without a fight."'}
                        className="w-full min-h-[80px] max-h-[160px] bg-void-lighter p-2.5 border border-border/50 rounded-sm text-[13px] font-mono leading-relaxed text-text-primary resize-none outline-none transition-all focus:border-danger/40 focus:ring-1 focus:ring-danger/20"
                        rows={3}
                        autoFocus
                    />
                    <p className="text-[9px] text-text-dim/40 mt-1.5">
                        {clamped.length}/{ABSOLUTE_COMMAND_MAX_CHARS} characters
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2 safe-bottom">
                    {armed ? (
                        <button
                            onClick={handleDisarm}
                            className="px-3 py-1.5 bg-border/30 border border-border text-text-dim text-[10px] uppercase tracking-widest rounded hover:bg-border/50 transition-colors"
                        >
                            Disarm
                        </button>
                    ) : (
                        <div className="text-[9px] text-text-dim/50 uppercase tracking-wider">Not armed</div>
                    )}
                    <button
                        onClick={handleArm}
                        disabled={!clamped}
                        className="px-4 py-1.5 bg-danger/10 border border-danger/40 text-danger text-[10px] uppercase tracking-widest rounded hover:bg-danger/20 transition-colors disabled:opacity-40"
                    >
                        {armed ? 'Update & Re-arm' : 'Arm Command'}
                    </button>
                </div>
            </div>
        </div>
    );
}
