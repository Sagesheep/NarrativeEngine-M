import { useState, useEffect } from 'react';
import { X, Check, Edit3, AlertTriangle, ShieldCheck, HelpCircle } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { runLoreCheck } from '../../services/loreCheck';

export function LoreCheckModal() {
    const open = useAppStore(s => s.loreCheckOpen);
    const loading = useAppStore(s => s.loreCheckLoading);
    const status = useAppStore(s => s.loreCheckStatus);
    const error = useAppStore(s => s.loreCheckError);
    const result = useAppStore(s => s.loreCheckResult);
    const selection = useAppStore(s => s.loreCheckSelection);
    const setStatus = useAppStore(s => s.setLoreCheckStatus);
    const setResult = useAppStore(s => s.setLoreCheckResult);
    const setError = useAppStore(s => s.setLoreCheckError);
    const close = useAppStore(s => s.closeLoreCheck);
    const replaceMessageText = useAppStore(s => s.replaceMessageText);

    const [editMode, setEditMode] = useState(false);
    const [draft, setDraft] = useState('');

    useEffect(() => {
        if (!open || !selection || result || error) return;
        const ac = new AbortController();
        (async () => {
            try {
                const state = useAppStore.getState();
                const utility = state.getActiveUtilityEndpoint();
                if (!utility) {
                    setError('No Utility AI configured. Set one in Settings \u2192 AI Providers.');
                    return;
                }
                const messages = state.messages;
                const campaignId = state.activeCampaignId ?? '';
                const loreChunks = state.loreChunks ?? [];
                const archiveIndex = state.archiveIndex ?? [];
                const sealedChapters = (state.chapters ?? []).filter((c: { sealedAt?: number; invalidated?: boolean }) => c.sealedAt != null && !c.invalidated);

                if (loreChunks.length === 0 && sealedChapters.length === 0) {
                    setError('No lore or archived chapters available to check against.');
                    return;
                }

                const res = await runLoreCheck({
                    utilityEndpoint: utility,
                    selectedText: selection.selectedText,
                    surroundingContext: selection.surroundingContext,
                    messages,
                    targetMessageId: selection.messageId,
                    loreChunks,
                    archiveIndex,
                    sealedChapters,
                    campaignId,
                    onStatus: setStatus,
                    signal: ac.signal,
                });
                setResult(res);
            } catch (err) {
                if (ac.signal.aborted) return;
                setError(err instanceof Error ? err.message : 'Lore check failed.');
            }
        })();
        return () => ac.abort();
    }, [open, selection, result, error, setError, setResult, setStatus]);

    if (!open) return null;

    const verdictMeta = result && {
        consistent:    { color: 'text-emerald-400 border-emerald-500/40', icon: <ShieldCheck size={14} />, label: 'Consistent' },
        unsupported:   { color: 'text-amber-400 border-amber-500/40',     icon: <HelpCircle size={14} />,  label: 'Unsupported' },
        contradicts:   { color: 'text-red-400 border-red-500/40',         icon: <AlertTriangle size={14} />, label: 'Contradicts' },
    }[result.verdict];

    const accept = (text: string) => {
        if (!selection) return;
        replaceMessageText(selection.messageId, selection.selectedText, text);
        close();
    };

    const handleClose = () => {
        setEditMode(false);
        setDraft('');
        close();
    };

    return (
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={handleClose}
        >
            <div
                className="bg-void-darker border border-border max-w-2xl w-full max-h-[85vh] overflow-y-auto rounded font-mono text-sm"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-3 border-b border-border">
                    <span className="text-[10px] uppercase tracking-widest text-terminal">◆ Lore Check</span>
                    <button onClick={handleClose} className="text-text-dim hover:text-text-primary">
                        <X size={14} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    {loading && (
                        <div className="text-text-dim text-xs">{status || 'Working...'}</div>
                    )}
                    {error && (
                        <div className="text-red-400 text-xs">{error}</div>
                    )}
                    {result && verdictMeta && (
                        <>
                            <div className={`inline-flex items-center gap-2 px-2 py-1 border rounded text-[10px] uppercase tracking-widest ${verdictMeta.color}`}>
                                {verdictMeta.icon}{verdictMeta.label}
                            </div>

                            {result.issues.length > 0 && (
                                <ul className="space-y-1">
                                    {result.issues.map((iss, i) => (
                                        <li key={i} className="text-text-dim text-xs flex gap-2">
                                            <span className="text-terminal">{'▸'}</span>{iss}
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {result.citations.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {result.citations.map((c, i) => (
                                        <span key={i} className="text-[10px] px-2 py-0.5 bg-terminal/10 border border-terminal/30 text-terminal/90 rounded">
                                            {c.label}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {result.suggestedRewrite != null && (
                                <div className="space-y-2">
                                    <div className="text-[10px] uppercase tracking-widest text-text-dim">Original</div>
                                    <div className="bg-red-500/5 border-l-2 border-red-500 p-2 text-xs whitespace-pre-wrap">
                                        {result.originalText}
                                    </div>
                                    <div className="text-[10px] uppercase tracking-widest text-text-dim">Suggested rewrite</div>
                                    {!editMode ? (
                                        <div className="bg-emerald-500/5 border-l-2 border-emerald-500 p-2 text-xs whitespace-pre-wrap">
                                            {result.suggestedRewrite}
                                        </div>
                                    ) : (
                                        <textarea
                                            value={draft}
                                            onChange={(e) => setDraft(e.target.value)}
                                            className="w-full bg-void border border-border p-2 text-xs font-mono"
                                            rows={5}
                                        />
                                    )}

                                    <div className="flex gap-2 flex-wrap">
                                        {!editMode && (
                                            <>
                                                <button
                                                    onClick={() => accept(result.suggestedRewrite!)}
                                                    className="text-[10px] uppercase tracking-widest bg-emerald-500/10 border border-emerald-500 text-emerald-400 px-3 py-1 rounded hover:bg-emerald-500/20 flex items-center gap-1"
                                                >
                                                    <Check size={10} /> Accept rewrite
                                                </button>
                                                <button
                                                    onClick={() => { setDraft(result.suggestedRewrite!); setEditMode(true); }}
                                                    className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1 rounded hover:text-text-primary flex items-center gap-1"
                                                >
                                                    <Edit3 size={10} /> Edit then accept
                                                </button>
                                            </>
                                        )}
                                        {editMode && (
                                            <button
                                                onClick={() => accept(draft)}
                                                className="text-[10px] uppercase tracking-widest bg-emerald-500/10 border border-emerald-500 text-emerald-400 px-3 py-1 rounded hover:bg-emerald-500/20 flex items-center gap-1"
                                            >
                                                <Check size={10} /> Save &amp; apply
                                            </button>
                                        )}
                                        <button
                                            onClick={handleClose}
                                            className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1 rounded hover:text-text-primary"
                                        >
                                            Reject
                                        </button>
                                    </div>
                                </div>
                            )}

                            {result.suggestedRewrite == null && result.verdict === 'consistent' && (
                                <button
                                    onClick={handleClose}
                                    className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1 rounded hover:text-text-primary"
                                >
                                    Close
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
