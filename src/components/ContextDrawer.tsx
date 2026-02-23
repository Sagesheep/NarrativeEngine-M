import { useState } from 'react';
import { ScrollText, FileText, ChevronDown, ChevronRight, Database, List } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

const RULES_LIMIT = 5000;

function TokenCounter({ text, limit }: { text: string; limit: number }) {
    const chars = text.length;
    const tokens = Math.ceil(chars / 4);
    const pct = Math.min((chars / limit) * 100, 100);
    const isOver = chars > limit;

    return (
        <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1 bg-void-lighter">
                <div
                    className={`h-full transition-all duration-300 ${isOver ? 'bg-danger' : 'bg-terminal-dim'}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <span className={`text-[10px] font-mono ${isOver ? 'text-danger' : 'text-text-dim'}`}>
                {chars.toLocaleString()} chars · ~{tokens.toLocaleString()} tok
            </span>
        </div>
    );
}

function Toggle({ active, onChange }: { active: boolean; onChange: () => void }) {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onChange(); }}
            className={`relative w-7 h-3.5 rounded-full transition-colors shrink-0 ${active ? 'bg-terminal' : 'bg-border'}`}
            title={active ? 'Active — will be appended' : 'Inactive — will not be appended'}
        >
            <div
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-surface transition-transform ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`}
            />
        </button>
    );
}

function Section({ title, color, defaultOpen, children }: {
    title: string;
    color: string;
    defaultOpen: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="border-b border-border last:border-b-0">
            <button
                onClick={() => setOpen(!open)}
                className={`w-full flex items-center gap-2 px-4 py-2.5 text-[11px] uppercase tracking-[0.2em] font-bold hover:bg-void-lighter transition-colors ${color}`}
            >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {title}
            </button>
            {open && (
                <div className="px-4 pb-4 pt-1 space-y-4">
                    {children}
                </div>
            )}
        </div>
    );
}

function TemplateField({ icon, label, color, value, onChange, placeholder, rows, active, onToggle, hint }: {
    icon: React.ReactNode;
    label: string;
    color: string;
    value: string;
    onChange: (val: string) => void;
    placeholder: string;
    rows: number;
    active: boolean;
    onToggle: () => void;
    hint?: string;
}) {
    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className={`flex items-center gap-2 text-[11px] uppercase tracking-wider ${color}`}>
                    {icon}
                    {label}
                </label>
                <Toggle active={active} onChange={onToggle} />
            </div>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                rows={rows}
                className={`w-full bg-void border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y transition-opacity ${active ? 'border-border' : 'border-border/40 opacity-50'
                    }`}
            />
            {hint && (
                <p className="text-[9px] text-text-dim/50 mt-1">{hint}</p>
            )}
        </div>
    );
}

export function ContextDrawer() {
    const { context, updateContext, drawerOpen, toggleDrawer, loreChunks, updateLoreChunk } = useAppStore();
    const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});

    if (!drawerOpen) return null;

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

    return (
        <>
            {/* Mobile backdrop */}
            <div
                className="fixed inset-0 bg-overlay z-40 md:hidden"
                onClick={toggleDrawer}
            />
            <aside className="
                fixed inset-0 z-50 w-full bg-surface flex flex-col overflow-hidden
                md:static md:w-80 md:z-auto md:border-r md:border-border md:shrink-0
            ">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <h2 className="text-[11px] text-terminal uppercase tracking-[0.25em] font-bold glow-green">
                        ◆ CONTEXT BANK
                    </h2>
                    <button
                        onClick={toggleDrawer}
                        className="md:hidden text-text-dim hover:text-terminal text-xs uppercase tracking-wider"
                    >
                        ✕ Close
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    {/* Context Section */}
                    <Section title="◆ System Context" color="text-terminal glow-green" defaultOpen={true}>
                        <div>
                            <label className="flex items-center gap-2 text-[11px] text-ice uppercase tracking-wider mb-2">
                                <ScrollText size={13} />
                                Rules / Mechanics
                            </label>
                            <textarea
                                value={context.rulesRaw}
                                onChange={(e) => updateContext({ rulesRaw: e.target.value })}
                                placeholder="Paste game rules, mechanics, character stats..."
                                rows={6}
                                className="w-full bg-void border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y"
                            />
                            <TokenCounter text={context.rulesRaw} limit={RULES_LIMIT} />
                        </div>
                    </Section>

                    {/* World Info Section */}
                    {loreChunks.length > 0 && (
                        <Section title="◆ World Info" color="text-ice" defaultOpen={false}>
                            <p className="text-[9px] text-text-dim/50 -mt-1 mb-2">
                                Chunks trigger when keywords appear in recent messages
                            </p>
                            <div className="space-y-3">
                                {loreChunks.map((chunk) => (
                                    <div key={chunk.id} className="bg-void rounded border border-border p-2">
                                        {/* Header row */}
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-[10px] text-text-primary font-bold truncate flex-1 mr-2" title={chunk.header}>
                                                {chunk.header}
                                            </span>
                                            <span className="text-[9px] text-text-dim shrink-0">
                                                {chunk.tokens}tk
                                            </span>
                                        </div>

                                        {/* Controls row */}
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <label className="flex items-center gap-1 text-[9px] text-text-dim cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={chunk.alwaysInclude}
                                                    onChange={() => updateLoreChunk(chunk.id, { alwaysInclude: !chunk.alwaysInclude })}
                                                    className="w-3 h-3 accent-terminal"
                                                />
                                                Always
                                            </label>
                                            <label className="flex items-center gap-1 text-[9px] text-text-dim">
                                                Depth:
                                                <select
                                                    value={chunk.scanDepth || 3}
                                                    onChange={(e) => updateLoreChunk(chunk.id, { scanDepth: parseInt(e.target.value) })}
                                                    className="bg-surface border border-border rounded px-1 py-0.5 text-[9px] text-text-primary"
                                                >
                                                    <option value={1}>1</option>
                                                    <option value={2}>2</option>
                                                    <option value={3}>3</option>
                                                    <option value={5}>5</option>
                                                    <option value={10}>10</option>
                                                </select>
                                            </label>
                                        </div>

                                        {/* Keywords */}
                                        <div className="flex flex-wrap gap-1 mb-1.5">
                                            {(chunk.triggerKeywords || []).map((kw) => (
                                                <span
                                                    key={kw}
                                                    className="inline-flex items-center gap-0.5 bg-surface border border-border rounded px-1.5 py-0.5 text-[9px] text-text-dim hover:border-danger group cursor-pointer"
                                                    onClick={() => removeKeyword(chunk.id, kw)}
                                                    title="Click to remove"
                                                >
                                                    {kw}
                                                    <span className="text-danger opacity-0 group-hover:opacity-100 text-[8px]">×</span>
                                                </span>
                                            ))}
                                        </div>

                                        {/* Add keyword input */}
                                        <div className="flex gap-1">
                                            <input
                                                type="text"
                                                value={newKeyword[chunk.id] || ''}
                                                onChange={(e) => setNewKeyword(prev => ({ ...prev, [chunk.id]: e.target.value }))}
                                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(chunk.id); } }}
                                                placeholder="+ keyword"
                                                className="flex-1 bg-surface border border-border rounded px-1.5 py-0.5 text-[9px] text-text-primary placeholder:text-text-dim/40"
                                            />
                                            <button
                                                onClick={() => addKeyword(chunk.id)}
                                                className="text-[9px] text-terminal hover:text-text-primary px-1"
                                            >
                                                +
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </Section>
                    )}


                    {/* Save File Section */}
                    <Section title="◇ Save File" color="text-ember" defaultOpen={false}>
                        <p className="text-[9px] text-text-dim/50 -mt-1 mb-2">
                            Toggle ON = appended to context (top→bottom order)
                        </p>

                        <TemplateField
                            icon={<Database size={13} />}
                            label="Canon State"
                            color="text-ember"
                            value={context.canonState}
                            onChange={(v) => updateContext({ canonState: v })}
                            placeholder="Paste canon state data..."
                            rows={6}
                            active={context.canonStateActive}
                            onToggle={() => updateContext({ canonStateActive: !context.canonStateActive })}
                        />

                        <TemplateField
                            icon={<List size={13} />}
                            label="Header Index"
                            color="text-ice"
                            value={context.headerIndex}
                            onChange={(v) => updateContext({ headerIndex: v })}
                            placeholder="Paste header index..."
                            rows={4}
                            active={context.headerIndexActive}
                            onToggle={() => updateContext({ headerIndexActive: !context.headerIndexActive })}
                        />

                        <TemplateField
                            icon={<FileText size={13} />}
                            label="Starter"
                            color="text-terminal"
                            value={context.starter}
                            onChange={(v) => updateContext({ starter: v })}
                            placeholder="Paste starter prompt..."
                            rows={4}
                            active={context.starterActive}
                            onToggle={() => updateContext({ starterActive: !context.starterActive })}
                        />

                        <TemplateField
                            icon={<FileText size={13} />}
                            label="Continue"
                            color="text-text-dim"
                            value={context.continuePrompt}
                            onChange={(v) => updateContext({ continuePrompt: v })}
                            placeholder="Paste continue prompt..."
                            rows={4}
                            active={context.continuePromptActive}
                            onToggle={() => updateContext({ continuePromptActive: !context.continuePromptActive })}
                        />
                    </Section>
                </div>
            </aside>
        </>
    );
}
