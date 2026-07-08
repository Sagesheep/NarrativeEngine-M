import { useSyncExternalStore } from 'react';
import { useBackHandler } from '../hooks/useBackHandler';
import { hapticWarning } from '../utils/haptics';

// Promise-based themed confirm dialog. Replaces window.confirm so confirmations
// match the app's look and don't block the JS thread. Call appConfirm() from
// anywhere; render a single <ConfirmSheet /> near the app root.

type ConfirmOpts = {
    title?: string;
    body: string;
    confirmLabel?: string;
    danger?: boolean;
};

type ConfirmState = (ConfirmOpts & { resolve: (v: boolean) => void }) | null;

let current: ConfirmState = null;
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

function getSnapshot(): ConfirmState {
    return current;
}

/** Open the confirm dialog; resolves true on Confirm, false on Cancel/backdrop/back. */
export function appConfirm(opts: ConfirmOpts): Promise<boolean> {
    // Defensively resolve any dialog already open (shouldn't normally happen).
    if (current) {
        const prev = current.resolve;
        current = null;
        prev(false);
    }
    return new Promise<boolean>((resolve) => {
        current = { ...opts, resolve };
        emit();
    });
}

function close(result: boolean) {
    if (!current) return;
    const resolve = current.resolve;
    current = null;
    emit();
    resolve(result);
}

export function ConfirmSheet() {
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    // Hardware back (and Android gesture) cancels the confirm.
    useBackHandler(state !== null, () => close(false));

    if (!state) return null;

    const danger = state.danger ?? false;

    return (
        <div
            className="fixed inset-0 z-[300] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={() => close(false)}
        >
            <div
                className="w-full md:max-w-sm bg-void-darker border border-border rounded-t-lg md:rounded-lg shadow-2xl animate-in slide-in-from-bottom duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-5 space-y-2">
                    {state.title && (
                        <h2 className="text-terminal text-sm font-bold tracking-widest uppercase">{state.title}</h2>
                    )}
                    <p className="text-sm text-text-primary font-mono whitespace-pre-line leading-relaxed">
                        {state.body}
                    </p>
                </div>
                <div className="flex gap-2 p-4 border-t border-border">
                    <button
                        onClick={() => close(false)}
                        className="flex-1 min-h-[44px] rounded border border-border text-text-dim hover:text-text-primary text-xs font-bold uppercase tracking-wider transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => { if (danger) hapticWarning(); close(true); }}
                        className={`flex-1 min-h-[44px] rounded text-xs font-bold uppercase tracking-wider transition-all hover:brightness-110 ${
                            danger ? 'bg-danger text-void' : 'bg-terminal text-void'
                        }`}
                    >
                        {state.confirmLabel ?? 'Confirm'}
                    </button>
                </div>
            </div>
        </div>
    );
}
