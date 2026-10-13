import { useEffect, useRef, useState } from 'react';
import { X, ScanSearch } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useBackHandler } from '../../hooks/useBackHandler';
import { isEmbedderReady } from '../../services/embedding';
import { hapticMedium } from '../../utils/haptics';

/**
 * DeepSearchSheet — one-page bottom sheet for arming Deep Archive Search v2.
 *
 * Replaces the old toggle behavior of the header ScanSearch button. The user
 * can optionally type a query ("what should the archive dig for?"); empty
 * query falls back to classic conversation-keyed retrieval. Arming stores
 * `deepSearchQuery` + sets `deepArmed`; the next send consumes both and clears
 * them (ChatArea). Deep Search is a supplement added on top of normal memory —
 * it never replaces or skips standard recall.
 *
 * Modeled on RegenerateSheet: bottom sheet, useBackHandler registered for
 * Android back, backdrop click with 350ms open-guard to dismiss.
 */
export interface DeepSearchSheetProps {
    open: boolean;
    onClose: () => void;
}

export function DeepSearchSheet({ open, onClose }: DeepSearchSheetProps) {
    const { deepArmed, deepSearchQuery, setDeepSearch } = useAppStore(useShallow(s => ({
        deepArmed: s.deepArmed,
        deepSearchQuery: s.deepSearchQuery,
        setDeepSearch: s.setDeepSearch,
    })));

    const [query, setQuery] = useState('');
    const openedAtRef = useRef(0);

    // Prefill from staged query whenever the sheet opens (handles reopen-while-armed).
    useEffect(() => {
        if (open) {
            openedAtRef.current = Date.now();
            setQuery(deepSearchQuery);
        }
    }, [open, deepSearchQuery]);

    useBackHandler(open, onClose);

    if (!open) return null;

    const embedderReady = isEmbedderReady();

    const handleBackdropClick = () => {
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const handleArm = () => {
        setDeepSearch(true, query.trim());
        hapticMedium();
        onClose();
    };

    const handleDisarm = () => {
        setDeepSearch(false, '');
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
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                        <ScanSearch size={14} className={deepArmed ? 'text-amber-400' : 'text-terminal'} />
                        <span className="text-[11px] uppercase tracking-widest text-text-dim">
                            Deep Archive Search
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

                {/* Explainer */}
                <div className="px-4 py-3 border-b border-border/50">
                    <p className="text-[12px] text-text-dim leading-relaxed">
                        Digs through sealed chapters on your next send. Slower, deeper recall — added on top of normal memory.
                    </p>
                </div>

                {/* Query textarea */}
                <div className="px-4 py-3 border-b border-border/50">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] uppercase tracking-widest text-text-dim">
                            Search Query <span className="text-text-dim/40 normal-case tracking-normal">(optional)</span>
                        </span>
                    </div>
                    <textarea
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={`What should it dig for? e.g. "my character's feats across the campaign". Leave empty to search from the current scene.`}
                        className="w-full min-h-[60px] max-h-[120px] bg-void-lighter p-2.5 border border-border/50 rounded-sm text-[13px] font-mono leading-relaxed text-text-primary resize-none outline-none transition-all focus:border-terminal/30 focus:ring-1 focus:ring-terminal/20"
                        rows={2}
                    />
                    <p className="text-[9px] text-text-dim/40 mt-1.5">
                        Empty query searches from the current scene (classic behavior). The conversation excerpt is always included as secondary context.
                    </p>
                </div>

                {/* Coverage note (conditional) */}
                {!embedderReady && (
                    <div className="px-4 py-2 border-b border-border/50">
                        <p className="text-[10px] text-amber-400/70 leading-relaxed">
                            Semantic index unavailable — will search chapter summaries only.
                        </p>
                    </div>
                )}

                {/* Footer / actions */}
                <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2 safe-bottom">
                    {deepArmed ? (
                        <button
                            onClick={handleDisarm}
                            className="px-3 py-1.5 bg-border/30 border border-border text-text-dim text-[10px] uppercase tracking-widest rounded hover:bg-border/50 transition-colors"
                        >
                            Disarm
                        </button>
                    ) : (
                        <div className="text-[9px] text-text-dim/50 uppercase tracking-wider">
                            {deepArmed ? 'Armed' : 'Not armed'}
                        </div>
                    )}
                    <button
                        onClick={handleArm}
                        className="px-4 py-1.5 bg-amber-400/10 border border-amber-400/40 text-amber-400 text-[10px] uppercase tracking-widest rounded hover:bg-amber-400/20 transition-colors"
                    >
                        {deepArmed ? 'Update & Re-arm' : 'Arm Deep Search'}
                    </button>
                </div>
            </div>
        </div>
    );
}