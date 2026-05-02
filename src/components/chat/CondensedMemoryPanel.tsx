import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { CondenserState, DivergenceRegister, DivergenceEntry, LLMProvider } from '../../types';
import { countRegisterTokens, compressRegister, EMPTY_REGISTER } from '../../services/divergenceRegister';
import { QuestPanel } from './QuestPanel';
import { DivergenceEntryModal } from './DivergenceEntryModal';

type CondensedMemoryPanelProps = {
    condenser: CondenserState;
    editingSummary: boolean;
    summaryDraft: string;
    showCondensedPanel: boolean;
    onToggle: () => void;
    onStartEdit: () => void;
    onCancelEdit: () => void;
    onSaveEdit: () => void;
    onSetDraft: (value: string) => void;
    onRetcon: () => void;
    onReset: () => void;
    divergenceRegister?: DivergenceRegister;
    onSetDivergenceRegister?: (reg: DivergenceRegister) => void;
    tokenBudget?: number;
    provider?: LLMProvider;
    onSaveDivergence?: () => void;
};

export function CondensedMemoryPanel({
    condenser,
    editingSummary,
    summaryDraft,
    showCondensedPanel,
    onToggle,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onSetDraft,
    onRetcon,
    onReset,
    divergenceRegister,
    onSetDivergenceRegister,
    tokenBudget = 2000,
    provider,
    onSaveDivergence,
}: CondensedMemoryPanelProps) {
    const [activeTab, setActiveTab] = useState<'summary' | 'register'>('register');
    const [compressing, setCompressing] = useState(false);
    const [showManualModal, setShowManualModal] = useState(false);

    if (!showCondensedPanel) return null;

    const reg = divergenceRegister ?? EMPTY_REGISTER;
    const regTokens = countRegisterTokens(reg);

    const handleCompress = async () => {
        if (!provider || !onSetDivergenceRegister) return;
        if (regTokens <= tokenBudget) return;
        setCompressing(true);
        try {
            const compressed = await compressRegister(provider, reg, tokenBudget);
            onSetDivergenceRegister(compressed);
            onSaveDivergence?.();
        } catch (err) {
            console.warn('[CondensedMemoryPanel] Compression failed:', err);
        }
        setCompressing(false);
    };

    const handleResolveObligation = (id: string) => {
        if (!onSetDivergenceRegister) return;
        const updated = {
            ...reg,
            entries: reg.entries.map(e => e.id === id ? { ...e, resolved: true } : e),
        };
        onSetDivergenceRegister(updated);
        onSaveDivergence?.();
    };

    const handleAddManualEntry = (entry: DivergenceEntry) => {
        if (!onSetDivergenceRegister) return;
        const updated = {
            ...reg,
            entries: [...reg.entries, entry].sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef)),
            lastUpdatedAt: Date.now(),
        };
        onSetDivergenceRegister(updated);
        onSaveDivergence?.();
    };

    return (
        <div className="px-2 md:px-4 pb-1">
            <div className="bg-void-lighter border border-terminal/20 rounded p-3">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setActiveTab('register')}
                            className={`text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 rounded ${activeTab === 'register' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                        >
                            Divergence Register
                        </button>
                        {condenser.condensedSummary && (
                            <button
                                onClick={() => setActiveTab('summary')}
                                className={`text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 rounded ${activeTab === 'summary' ? 'text-terminal bg-terminal/10' : 'text-text-dim'}`}
                            >
                                Condensed Memory
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        {activeTab === 'register' && (
                            <>
                                <button onClick={() => setShowManualModal(true)} className="text-[9px] text-amber-400 hover:underline px-1">+ Add</button>
                                {compressing ? (
                                    <Loader2 size={10} className="animate-spin text-amber-400" />
                                ) : (
                                    <button
                                        onClick={handleCompress}
                                        disabled={regTokens <= tokenBudget || !provider}
                                        className="text-[9px] text-terminal hover:underline px-1 disabled:opacity-40"
                                        title={regTokens <= tokenBudget ? `Register is ${regTokens}/${tokenBudget} tokens — no compression needed` : 'Compress register'}
                                    >
                                        AI Summary
                                    </button>
                                )}
                            </>
                        )}
                        <button onClick={onToggle} className="text-[9px] text-text-dim hover:underline px-1"><X size={10} /></button>
                    </div>
                </div>

                {activeTab === 'register' && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between text-[9px] text-text-dim">
                            <span>Status: {regTokens} / {tokenBudget} tokens {regTokens <= tokenBudget ? '(below target)' : '(exceeds budget)'}</span>
                            <span>{reg.entries.length} entries</span>
                        </div>

                        {reg.entries.length === 0 ? (
                            <div className="text-[11px] text-text-dim/50 italic py-4 text-center">
                                No divergences tracked yet. Use ⚡ on GM messages to tag them.
                            </div>
                        ) : (
                            <div className="text-[11px] text-text-dim/80 font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto space-y-0.5">
                                {reg.entries.map(e => (
                                    <div key={e.id} className={`flex items-start gap-1 ${e.resolved ? 'line-through opacity-40' : ''}`}>
                                        <span className={`text-[9px] shrink-0 mt-0.5 ${
                                            e.category === 'canon_override' ? 'text-red-400' :
                                            e.category === 'world_change' ? 'text-ice' :
                                            e.category === 'entity_state' ? 'text-terminal' :
                                            e.category === 'player_state' ? 'text-emerald-400' :
                                            'text-amber-400'
                                        }`}>
                                            [{e.category === 'canon_override' ? 'CANON' : e.category === 'world_change' ? 'WORLD' : e.category === 'entity_state' ? 'ENTITY' : e.category === 'player_state' ? 'PLAYER' : 'OBLIG'}]
                                        </span>
                                        <span>{e.subject}: {e.divergence} <span className="text-text-dim/40">[#{e.sceneRef}]{e.source === 'manual' ? ' ⚡' : ''}</span></span>
                                    </div>
                                ))}
                            </div>
                        )}

                        <QuestPanel entries={reg.entries} onResolve={handleResolveObligation} />
                    </div>
                )}

                {activeTab === 'summary' && (
                    <div>
                        {editingSummary ? (
                            <textarea value={summaryDraft} onChange={e => onSetDraft(e.target.value)} className="w-full bg-void border border-border rounded px-2 py-1 text-xs text-text-primary font-mono resize-y min-h-[60px] max-h-[200px]" />
                        ) : (
                            <div className="text-[11px] text-text-dim/80 font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                                {condenser.condensedSummary || <span className="italic opacity-50">No condensed summary yet</span>}
                            </div>
                        )}
                        <div className="flex gap-2 mt-2">
                            {editingSummary ? (
                                <>
                                    <button onClick={onSaveEdit} className="text-[9px] text-terminal hover:underline px-1">Save</button>
                                    <button onClick={onCancelEdit} className="text-[9px] text-text-dim hover:underline px-1">Cancel</button>
                                </>
                            ) : (
                                <>
                                    <button onClick={onStartEdit} className="text-[9px] text-terminal hover:underline px-1">Edit</button>
                                    <button onClick={onRetcon} className="text-[9px] text-amber-500 hover:underline px-1">Retcon</button>
                                    <button onClick={onReset} className="text-[9px] text-red-400 hover:underline px-1">Reset</button>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {showManualModal && (
                <DivergenceEntryModal
                    onAdd={handleAddManualEntry}
                    onClose={() => setShowManualModal(false)}
                    provider={provider}
                />
            )}
        </div>
    );
}
