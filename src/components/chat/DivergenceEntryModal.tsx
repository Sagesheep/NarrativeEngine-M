import { useState } from 'react';
import { Zap, Loader2 } from 'lucide-react';
import type { DivergenceCategory, DivergenceEntry } from '../../types';
import { uid } from '../../utils/uid';
import { useBackHandler } from '../../hooks/useBackHandler';
import { DIVERGENCE_CATEGORIES, CATEGORY_LABELS } from '../../services/campaign-state';
import type { LLMProvider } from '../../types';

type DivergenceEntryModalProps = {
    onAdd: (entry: DivergenceEntry) => void;
    onClose: () => void;
    provider?: LLMProvider;
    chapterId?: string;
};

const CATEGORIES: { value: DivergenceCategory; label: string }[] = DIVERGENCE_CATEGORIES.map(c => ({
    value: c,
    label: CATEGORY_LABELS[c] ?? c,
}));

export function DivergenceEntryModal({ onAdd, onClose, provider, chapterId = 'manual' }: DivergenceEntryModalProps) {
    const [text, setText] = useState('');
    const [category, setCategory] = useState<DivergenceCategory>('npc_events');
    const [freeText, setFreeText] = useState('');
    const [structuring, setStructuring] = useState(false);

    // Only mounted while open → back always dismisses.
    useBackHandler(true, onClose);

    const handleSubmit = () => {
        if (!text.trim()) return;
        onAdd({
            id: `div_${uid()}`,
            chapterId,
            category,
            text: text.trim(),
            sceneRef: 'manual',
            npcIds: [],
            pinned: false,
            source: 'manual',
        });
        onClose();
    };

    const handleAIStructure = async () => {
        if (!freeText.trim() || !provider) return;
        setStructuring(true);
        try {
            const { llmCall } = await import('../../utils/llmCall');
            const { extractJson } = await import('../../services/infrastructure');
            const { INPUT_DELIMITER: DELIM, JSON_ONLY_FOOTER: JSON_FOOTER, joinPromptSections } = await import('../../services/infrastructure');
            const prompt = joinPromptSections(
                'You are a TTRPG campaign archivist.',
                `Convert free-text player input into a structured campaign fact.\n\nCategory options: ${DIVERGENCE_CATEGORIES.join(', ')}\n\nOutput schema: { "category": "<category>", "text": "<one-line factual statement, max 15 words>" }`,
                JSON_FOOTER,
                DELIM,
                `Player text: "${freeText}"`,
            );
            const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 200 });
            const jsonStr = extractJson(raw);
            const result = JSON.parse(jsonStr);
            if (result.text) setText(result.text);
            if (result.category) setCategory(result.category as DivergenceCategory);
        } catch { /* best-effort structuring; keep the user's raw text on failure */ }
        setStructuring(false);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-void/80 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
            <div className="bg-surface border border-border rounded-t-lg md:rounded p-4 w-full md:w-[calc(90*var(--app-vw))] max-w-md space-y-3 max-h-[calc(85*var(--app-vh))] overflow-y-auto animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-2">
                    <Zap size={14} className="text-amber-400" />
                    <span className="text-[10px] text-amber-400 uppercase tracking-widest font-bold">Add Fact</span>
                </div>

                <div>
                    <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Fact</label>
                    <input
                        type="text"
                        value={text}
                        onChange={e => setText(e.target.value)}
                        className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary focus:border-amber-400 focus:outline-none"
                        placeholder="Goblin King Grak allied with the player"
                    />
                </div>

                <div>
                    <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Category</label>
                    <select
                        value={category}
                        onChange={e => setCategory(e.target.value as DivergenceCategory)}
                        className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary focus:border-amber-400 focus:outline-none"
                    >
                        {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                </div>

                {provider && (
                    <div className="border-t border-border pt-3">
                        <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Or describe it in your own words</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={freeText}
                                onChange={e => setFreeText(e.target.value)}
                                className="flex-1 bg-void border border-border px-3 py-2 text-sm text-text-primary focus:border-amber-400 focus:outline-none"
                                placeholder="Grak promised his army if I free his brother..."
                            />
                            <button
                                onClick={handleAIStructure}
                                disabled={structuring || !freeText.trim()}
                                className="flex items-center gap-1 bg-amber-500/20 text-amber-400 px-3 py-2 text-[10px] uppercase tracking-wider border border-amber-500/30 rounded hover:bg-amber-500/30 disabled:opacity-40"
                            >
                                {structuring ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                                AI Structure
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex gap-2 pt-2">
                    <button
                        onClick={handleSubmit}
                        disabled={!text.trim()}
                        className="flex-1 bg-amber-500/20 text-amber-400 py-2 text-[11px] uppercase tracking-wider border border-amber-500/30 rounded hover:bg-amber-500/30 disabled:opacity-40"
                    >
                        Add Fact
                    </button>
                    <button
                        onClick={onClose}
                        className="flex-1 bg-void text-text-dim py-2 text-[11px] uppercase tracking-wider border border-border rounded hover:text-text-primary"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}