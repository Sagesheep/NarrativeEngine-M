import { useEffect, useState } from 'react';
import { X, Loader2, Sparkles } from 'lucide-react';
import type { RequestedUpdateResult, UpdateProposal } from '../../services/npc/npcRequestedUpdate';
import { useBackHandler } from '../../hooks/useBackHandler';

type Props = {
    open: boolean;
    npcName: string;
    isPC: boolean;
    onPropose: (request: string) => Promise<RequestedUpdateResult>;
    onApply: (accepted: UpdateProposal[]) => void;
    onClose: () => void;
};

type Phase = 'input' | 'running' | 'review' | 'error';

/**
 * "What changed?" — the player names the change, the engine searches the game's
 * history, the AI proposes field edits, and the player confirms each one.
 */
export function NPCUpdateRequestModal({ open, npcName, isPC, onPropose, onApply, onClose }: Props) {
    const [phase, setPhase] = useState<Phase>('input');
    const [request, setRequest] = useState('');
    const [result, setResult] = useState<RequestedUpdateResult | null>(null);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [error, setError] = useState<string | null>(null);

    // State starts fresh on each open: the parent mounts this only while open.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && open && phase !== 'running') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, phase, onClose]);

    useBackHandler(open, () => { if (phase !== 'running') onClose(); });

    if (!open) return null;

    const run = async () => {
        setPhase('running');
        setError(null);
        try {
            const r = await onPropose(request);
            setResult(r);
            setChecked(new Set(r.proposals.map(p => p.field)));
            setPhase('review');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'The update failed.');
            setPhase('error');
        }
    };

    const toggle = (field: string) => setChecked(prev => {
        const next = new Set(prev);
        if (next.has(field)) next.delete(field); else next.add(field);
        return next;
    });

    const accepted = result?.proposals.filter(p => checked.has(p.field)) ?? [];

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60" onClick={() => phase !== 'running' && onClose()}>
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-lg max-h-[calc(85*var(--app-vh))] flex flex-col mx-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <div className="flex flex-col min-w-0">
                        <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase">AI Update</h2>
                        <span className="text-[10px] text-text-dim mt-0.5 truncate">{npcName}{isPC ? ' · your character' : ''}</span>
                    </div>
                    <button onClick={onClose} disabled={phase === 'running'} className="touch-btn text-text-dim hover:text-text-primary transition-colors disabled:opacity-40">
                        <X size={20} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {(phase === 'input' || phase === 'error') && (
                        <>
                            <label className="block text-xs text-text-primary font-semibold">What needs to be updated?</label>
                            <textarea
                                autoFocus
                                value={request}
                                onChange={e => setRequest(e.target.value)}
                                rows={3}
                                placeholder={isPC ? 'e.g. "My Persona is Pluto, not Orpheus" or "I got my hair cut short"' : 'e.g. "She lost her sword in the fight at the docks"'}
                                className="w-full bg-void border border-border rounded px-3 py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none resize-none"
                            />
                            <p className="text-[10px] text-text-dim/70">
                                I'll look for it in the story so far. If nothing matches, your words are used as a correction. Leave blank to check the recent chat. Nothing is saved until you confirm.
                            </p>
                            {phase === 'error' && error && (
                                <div className="bg-red-900/20 border border-red-500/40 rounded p-3 text-xs text-red-400">{error}</div>
                            )}
                        </>
                    )}

                    {phase === 'running' && (
                        <div className="flex flex-col items-center justify-center py-8 space-y-3">
                            <Loader2 size={24} className="animate-spin text-terminal" />
                            <div className="text-sm text-text-primary">Searching the story and drafting changes…</div>
                        </div>
                    )}

                    {phase === 'review' && result && (
                        <>
                            {!result.evidenceFound && (
                                <div className="bg-amber-900/20 border border-amber-500/40 rounded p-2 text-[11px] text-amber-300">
                                    No supporting scene found — these changes come from your request as a correction.
                                </div>
                            )}
                            {result.summary && <p className="text-[11px] text-text-dim italic">{result.summary}</p>}
                            {result.proposals.length === 0 ? (
                                <div className="py-6 text-center text-sm text-text-dim">No changes needed.</div>
                            ) : result.proposals.map(p => (
                                <label key={p.field} className="block border border-border/40 rounded p-2 cursor-pointer">
                                    <div className="flex items-center gap-2">
                                        <input type="checkbox" checked={checked.has(p.field)} onChange={() => toggle(p.field)} className="accent-terminal" />
                                        <span className="text-[12px] text-text-primary font-semibold">{p.label}</span>
                                        <span className="ml-auto text-[9px] uppercase tracking-wide text-text-dim">{p.source}</span>
                                    </div>
                                    <div className="mt-1.5 pl-6 space-y-1 text-[11px]">
                                        <div className="text-text-dim line-through break-words">{p.before}</div>
                                        <div className="text-terminal break-words">{p.after}</div>
                                        {p.note && <div className="text-text-dim/70 italic">{p.note}</div>}
                                    </div>
                                </label>
                            ))}
                        </>
                    )}
                </div>

                <div className="flex justify-end gap-2 p-3 border-t border-border">
                    {phase === 'review' && result && result.proposals.length > 0 ? (
                        <>
                            <button onClick={() => setPhase('input')} className="px-4 py-2 text-xs text-text-dim hover:text-text-primary uppercase tracking-widest">Back</button>
                            <button
                                onClick={() => onApply(accepted)}
                                disabled={accepted.length === 0}
                                className="px-4 py-2 bg-terminal text-void text-xs font-bold uppercase tracking-widest rounded disabled:opacity-40"
                            >
                                Apply {accepted.length}
                            </button>
                        </>
                    ) : phase === 'review' ? (
                        <button onClick={onClose} className="px-4 py-2 text-xs text-text-dim hover:text-text-primary uppercase tracking-widest">Close</button>
                    ) : (
                        <button
                            onClick={run}
                            disabled={phase === 'running'}
                            className="flex items-center gap-1.5 px-4 py-2 bg-terminal text-void text-xs font-bold uppercase tracking-widest rounded disabled:opacity-40"
                        >
                            <Sparkles size={12} /> Find &amp; propose
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
