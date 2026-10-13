import { useEffect, useRef } from 'react';
import { X, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useBackHandler } from '../../hooks/useBackHandler';
import { hapticMedium } from '../../utils/haptics';
import { ONE_SHOT_EVENT_TYPES, type OneShotEventId } from '../../services/oneshot/oneShotEvents';

/**
 * OneShotSheet — bottom sheet for arming a One-Shot Event (port of mainApp's
 * OneShotInjectorButton). Tap an event type: it happens in the scene on your
 * next send, emerging from what is already going on, then clears.
 *
 * Modeled on AbsoluteCommandSheet / DeepSearchSheet.
 */
export function OneShotSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    useBackHandler(open, onClose);
    return open ? <SheetBody onClose={onClose} /> : null;
}

function SheetBody({ onClose }: { onClose: () => void }) {
    const { armed, setArmed } = useAppStore(useShallow(s => ({
        armed: s.armedOneShot,
        setArmed: s.setArmedOneShot,
    })));

    const openedAtRef = useRef(0);
    useEffect(() => {
        openedAtRef.current = Date.now();
    }, []);

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const arm = (id: OneShotEventId) => {
        setArmed(id);
        hapticMedium();
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
                        <Sparkles size={14} className="text-violet-400" />
                        <span className="text-[11px] uppercase tracking-widest text-text-dim">One-Shot Event</span>
                    </div>
                    <button onClick={onClose} className="text-text-dim hover:text-text-primary p-1 rounded transition-colors" title="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="px-4 py-3 border-b border-border/50">
                    <p className="text-[12px] text-text-dim leading-relaxed">
                        Something happens on your next message, growing out of the current scene. You can still pursue or ignore it.
                    </p>
                </div>

                <div className="p-2 space-y-1">
                    {ONE_SHOT_EVENT_TYPES.map(t => (
                        <button
                            key={t.id}
                            onClick={() => arm(t.id)}
                            className={`w-full text-left px-3 py-2.5 min-h-[48px] rounded border transition-colors ${
                                armed === t.id
                                    ? 'border-violet-400/60 bg-violet-400/10'
                                    : 'border-transparent hover:bg-void-lighter'
                            }`}
                        >
                            <div className="text-[12px] uppercase tracking-wider text-text-primary">{t.label}</div>
                            <div className="text-[11px] text-text-dim">{t.blurb}</div>
                        </button>
                    ))}
                </div>

                <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2 safe-bottom">
                    {armed ? (
                        <button
                            onClick={() => { setArmed(null); onClose(); }}
                            className="px-3 py-1.5 bg-border/30 border border-border text-text-dim text-[10px] uppercase tracking-widest rounded hover:bg-border/50 transition-colors"
                        >
                            Disarm
                        </button>
                    ) : (
                        <div className="text-[9px] text-text-dim/50 uppercase tracking-wider">Not armed</div>
                    )}
                    <div className="text-[9px] text-text-dim/50 uppercase tracking-wider">
                        {armed ? `Armed: ${armed}` : 'Tap an event to arm it'}
                    </div>
                </div>
            </div>
        </div>
    );
}
