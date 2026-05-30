import { useState } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { LoreChunk } from '../../types';
import { indexLore, deriveDefaultLoreMeta } from '../../services/lore/loreIndexer';
import type { IndexingProgress } from '../../services/lore/loreIndexer';

type ActivationMode = 'vector' | 'keyword' | 'always';

function getModes(chunk: LoreChunk): ActivationMode[] {
    if (chunk.activationModes) return chunk.activationModes;
    return deriveDefaultLoreMeta(chunk);
}

export function LoreManagerTab({ onBack }: { onBack?: () => void }) {
    const loreChunks = useAppStore((s) => s.loreChunks);
    const updateLoreChunk = useAppStore((s) => s.updateLoreChunk);
    const setLoreChunks = useAppStore((s) => s.setLoreChunks);
    const activeCampaignId = useAppStore((s) => s.activeCampaignId);
    const settings = useAppStore((s) => s.settings);

    const [indexing, setIndexing] = useState(false);
    const [progress, setProgress] = useState<IndexingProgress | null>(null);
    const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
    const [newSecondary, setNewSecondary] = useState<Record<string, string>>({});
    const [confirmRegenId, setConfirmRegenId] = useState<string | null>(null);

    const runIndex = async () => {
        if (!activeCampaignId || loreChunks.length === 0) return;
        setIndexing(true);
        try {
            await indexLore(activeCampaignId, loreChunks, (p) => setProgress(p));
            const updated = loreChunks.map(c => ({
                ...c,
                activationModes: c.activationModes ?? deriveDefaultLoreMeta(c),
            }));
            setLoreChunks(updated);
            const { saveLoreChunks } = await import('../../store/campaignStore');
            await saveLoreChunks(activeCampaignId, updated);
        } catch (e) {
            console.warn('[LoreManager] Indexing failed:', e);
        } finally {
            setIndexing(false);
            setProgress(null);
        }
    };

    const toggleMode = (chunkId: string, mode: ActivationMode) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        const currentModes = getModes(chunk);
        const modes = currentModes.includes(mode)
            ? currentModes.filter(m => m !== mode)
            : [...currentModes, mode];
        if (modes.length === 0) return;
        updateLoreChunk(chunkId, { activationModes: modes });
    };

    const addKeyword = (chunkId: string) => {
        const kw = (newKeyword[chunkId] || '').trim().toLowerCase();
        if (!kw) return;
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        if (chunk.triggerKeywords.includes(kw)) return;
        updateLoreChunk(chunkId, { triggerKeywords: [...chunk.triggerKeywords, kw] });
        setNewKeyword(prev => ({ ...prev, [chunkId]: '' }));
    };

    const removeKeyword = (chunkId: string, kw: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        updateLoreChunk(chunkId, { triggerKeywords: chunk.triggerKeywords.filter(k => k !== kw) });
    };

    const addSecondaryKeyword = (chunkId: string) => {
        const kw = (newSecondary[chunkId] || '').trim().toLowerCase();
        if (!kw) return;
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        const current = chunk.secondaryKeywords ?? [];
        if (current.includes(kw)) return;
        updateLoreChunk(chunkId, { secondaryKeywords: [...current, kw] });
        setNewSecondary(prev => ({ ...prev, [chunkId]: '' }));
    };

    const removeSecondaryKeyword = (chunkId: string, kw: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        updateLoreChunk(chunkId, {
            secondaryKeywords: (chunk.secondaryKeywords ?? []).filter(k => k !== kw),
        });
    };

    const regenerateKeywords = (chunkId: string) => {
        const chunk = loreChunks.find(c => c.id === chunkId);
        if (!chunk) return;
        if (confirmRegenId !== chunkId) {
            setConfirmRegenId(chunkId);
            return;
        }
        const fresh = deriveDefaultLoreMeta(chunk);
        updateLoreChunk(chunkId, {
            activationModes: fresh,
            triggerKeywords: chunk.triggerKeywords,
        });
        setConfirmRegenId(null);
    };

    const renderChunk = (chunk: LoreChunk) => {
        const modes = getModes(chunk);
        const isAlways = modes.includes('always');
        const isKeyword = modes.includes('keyword');
        const isVector = modes.includes('vector');

        return (
            <div key={chunk.id} className={`bg-void rounded border p-2 transition-colors ${isAlways ? 'border-terminal/40' : 'border-border'}`}>
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[10px] text-text-primary font-bold truncate flex-1 mr-2" title={chunk.header}>
                        {chunk.header}
                    </span>
                    <span className="text-[9px] text-text-dim shrink-0">
                        {chunk.tokens}tk
                    </span>
                </div>

                <div className="flex items-center gap-3 mb-1.5">
                    <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isVector}
                            onChange={() => toggleMode(chunk.id, 'vector')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Vector
                    </label>
                    <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isKeyword}
                            onChange={() => toggleMode(chunk.id, 'keyword')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Keyword
                    </label>
                    <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isAlways}
                            onChange={() => toggleMode(chunk.id, 'always')}
                            className="w-3 h-3 accent-terminal"
                        />
                        Always
                    </label>
                </div>

                {isKeyword && (
                    <div className="mb-1.5">
                        <div className="text-[8px] text-text-dim uppercase tracking-wider mb-0.5">Secondary (AND-gate)</div>
                        <div className="flex flex-wrap gap-1 mb-1">
                            {(chunk.secondaryKeywords ?? []).map(kw => (
                                <span
                                    key={kw}
                                    className="inline-flex items-center gap-1 bg-surface border border-terminal/30 rounded px-1.5 py-0.5 text-[8px] text-terminal-dim hover:border-danger cursor-pointer"
                                    onClick={() => removeSecondaryKeyword(chunk.id, kw)}
                                    title="Click to remove"
                                >
                                    {kw}
                                    ×
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-1">
                            <input
                                type="text"
                                value={newSecondary[chunk.id] || ''}
                                onChange={(e) => setNewSecondary(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSecondaryKeyword(chunk.id); } }}
                                placeholder="+ secondary kw"
                                className="flex-1 bg-surface border border-border rounded px-2 py-1 md:py-0.5 text-[16px] md:text-[8px] text-text-primary placeholder:text-text-dim/40 min-h-[36px] md:min-h-0"
                            />
                            <button
                                onClick={() => addSecondaryKeyword(chunk.id)}
                                className="text-[10px] md:text-[8px] text-terminal hover:text-text-primary px-2 md:px-1 touch-btn md:min-h-0 md:min-w-0"
                            >
                                <Plus size={10} />
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex flex-wrap gap-1 mb-1.5">
                    {chunk.triggerKeywords.map(kw => (
                        <span
                            key={kw}
                            className="inline-flex items-center gap-1 bg-surface border border-border rounded px-2.5 md:px-1.5 py-1.5 md:py-0.5 text-xs md:text-[9px] text-text-dim hover:border-danger group cursor-pointer min-h-[32px] md:min-h-0"
                            onClick={() => removeKeyword(chunk.id, kw)}
                            title="Click to remove"
                        >
                            {kw}
                            <span className="text-danger opacity-100 md:opacity-0 md:group-hover:opacity-100 text-[10px] md:text-[8px]">×</span>
                        </span>
                    ))}
                </div>

                <div className="flex gap-1">
                    <input
                        type="text"
                        value={newKeyword[chunk.id] || ''}
                        onChange={(e) => setNewKeyword(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(chunk.id); } }}
                        placeholder="+ keyword"
                        className="flex-1 bg-surface border border-border rounded px-3 py-2 md:py-0.5 text-[16px] md:text-[9px] text-text-primary placeholder:text-text-dim/40 min-h-[44px] md:min-h-0"
                    />
                    <button
                        onClick={() => addKeyword(chunk.id)}
                        className="text-[14px] md:text-[9px] text-terminal hover:text-text-primary px-3 md:px-1 touch-btn md:min-h-0 md:min-w-0"
                    >
                        <Plus size={10} />
                    </button>
                    <button
                        onClick={() => regenerateKeywords(chunk.id)}
                        onBlur={() => setConfirmRegenId(null)}
                        className={`text-[9px] transition-colors ${
                            confirmRegenId === chunk.id
                                ? 'text-danger font-bold'
                                : 'text-text-dim hover:text-terminal'
                        }`}
                        title={confirmRegenId === chunk.id ? 'Click again to confirm — resets activation modes to defaults' : 'Reset activation modes to defaults'}
                    >
                        {confirmRegenId === chunk.id ? 'Confirm?' : <RotateCcw size={10} />}
                    </button>
                </div>
            </div>
        );
    };

    const alwaysChunks = loreChunks.filter(c => {
        const modes = getModes(c);
        return modes.includes('always');
    });
    const conditionalChunks = loreChunks.filter(c => {
        const modes = getModes(c);
        return !modes.includes('always');
    });

    const totalTokens = loreChunks.reduce((sum, c) => sum + c.tokens, 0);

    return (
        <div className="px-4 py-4 space-y-4">
            <div className="flex items-center justify-between">
                <span className="text-[10px] text-terminal uppercase tracking-wider font-bold">
                    World Lore Manager
                </span>
                {onBack && (
                    <button onClick={onBack} className="text-[9px] text-text-dim hover:text-text-primary">
                        ← Back
                    </button>
                )}
            </div>

            <div className="text-[9px] text-text-dim/70 space-y-1">
                <div>Total lore: {totalTokens} tokens across {loreChunks.length} chunks</div>
                <div>Token budget: {settings.contextLimit || 8192} tokens/turn</div>
            </div>

            <button
                onClick={runIndex}
                disabled={indexing || loreChunks.length === 0}
                className={`w-full py-2 text-[10px] uppercase tracking-wider font-bold rounded transition-colors ${
                    indexing
                        ? 'bg-surface text-text-dim cursor-not-allowed'
                        : 'bg-terminal/10 text-terminal hover:bg-terminal/20'
                }`}
            >
                {indexing
                    ? `Indexing... ${progress ? `${progress.current}/${progress.total} (${progress.phase})` : ''}`
                    : 'Re-index Lore'}
            </button>

            {indexing && progress && (
                <div className="h-1 bg-void-lighter rounded overflow-hidden">
                    <div
                        className="h-full bg-terminal transition-all duration-200"
                        style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                    />
                </div>
            )}

            {loreChunks.length === 0 ? (
                <p className="text-text-dim/50 text-xs text-center mt-8">
                    No lore uploaded for this campaign.
                </p>
            ) : (
                <div className="space-y-3">
                    {alwaysChunks.length > 0 && (
                        <div className="space-y-2 mb-4">
                            <div className="text-[10px] text-terminal uppercase tracking-wider font-bold mb-1 border-b border-terminal/20 pb-1 flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                                Always On ({alwaysChunks.length})
                            </div>
                            {alwaysChunks.map(renderChunk)}
                        </div>
                    )}
                    {conditionalChunks.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-[10px] text-text-dim uppercase tracking-wider font-bold mb-1 border-b border-border/50 pb-1 flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-text-dim/50" />
                                Conditional ({conditionalChunks.length})
                            </div>
                            {conditionalChunks.map(renderChunk)}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}