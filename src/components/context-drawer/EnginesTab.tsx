import { useState } from 'react';
import { Loader2, Sparkles, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore, DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES, DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT } from '../../store/useAppStore';
import { populateEngineTags } from '../../services/chatEngine';
import { Toggle } from './Toggle';
import { NPCPressureInspector } from '../NPCPressureInspector';
import { buildDefaultDiceSystem } from '../../types';
import { validateBands } from '../../services/engine/diceTier';
import type { DieType, OutcomeBand, DiceCategory, CharacterIntroEntry, NpcIntroConfig } from '../../types';

function uid(prefix: string) { return `${prefix}_${Math.random().toString(36).slice(2, 9)}`; }

export function EnginesTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const [populatingField, setPopulatingField] = useState<string | null>(null);

    const renderPopulateButton = (fieldKey: string, onPopulate: () => Promise<void>) => (
        <button
            onClick={async () => {
                setPopulatingField(fieldKey);
                await onPopulate();
                setPopulatingField(null);
            }}
            disabled={populatingField !== null}
            className="flex items-center gap-1 text-[12px] md:text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30 min-h-[36px] md:min-h-0"
            title="AI-populate tags based on campaign lore"
        >
            {populatingField === fieldKey ? <Loader2 size={12} className="animate-spin md:w-[9px] md:h-[9px]" /> : <Sparkles size={12} className="md:w-[9px] md:h-[9px]" />}
            Populate
        </button>
    );

    const surpriseDefaults = { types: DEFAULT_SURPRISE_TYPES, tones: DEFAULT_SURPRISE_TONES, initialDC: 95, dcReduction: 3 };
    const encounterDefaults = { types: DEFAULT_ENCOUNTER_TYPES, tones: DEFAULT_ENCOUNTER_TONES, initialDC: 198, dcReduction: 2 };
    const worldDefaults = { initialDC: 498, dcReduction: 2, who: [] as string[], where: [] as string[], why: [] as string[], what: [] as string[] };

    return (
        <div className="px-4 py-4 space-y-4">
            <p className="text-[9px] text-text-dim/50">
                Configure thresholds and tags for the local narrative engines.
            </p>

            <div className="space-y-4">
                <section className="bg-void border border-border p-3 space-y-3">
                    <h3 className="text-[11px] text-terminal uppercase tracking-wider font-bold">Story AI tool calls</h3>
                    <p className="text-xs text-text-dim leading-relaxed">
                        Each tool call sends the result back to Story AI in another request, which can add cost. Saved for this campaign; changes apply to the next turn.
                    </p>
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm text-text-primary">Campaign lore lookup</div>
                            <p className="text-xs text-text-dim">Let Story search campaign notes with query_campaign_lore. Turning this off keeps lore already included in the prompt.</p>
                        </div>
                        <button type="button" role="switch" aria-label="Campaign lore lookup" aria-checked={context.loreToolEnabled !== false}
                            onClick={() => updateContext({ loreToolEnabled: context.loreToolEnabled === false })}
                            className="min-h-[44px] min-w-[64px] px-3 text-xs text-terminal border border-terminal/30 rounded">
                            {context.loreToolEnabled !== false ? 'On' : 'Off'}
                        </button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm text-text-primary">AI dice rolls</div>
                            <p className="text-xs text-text-dim">Let Story request roll_dice. Manual rolls stay available.{context.diceFairnessActive !== false ? ' Currently inactive while Pool mode is on.' : ''}</p>
                        </div>
                        <button type="button" role="switch" aria-label="AI dice rolls" aria-checked={context.diceToolEnabled !== false}
                            onClick={() => updateContext({ diceToolEnabled: context.diceToolEnabled === false })}
                            className="min-h-[44px] min-w-[64px] px-3 text-xs text-terminal border border-terminal/30 rounded">
                            {context.diceToolEnabled !== false ? 'On' : 'Off'}
                        </button>
                    </div>
                </section>
                {/* Surprise Engine */}
                <div className="space-y-2">
                    <div className="text-[10px] text-terminal uppercase tracking-wider font-bold border-b border-terminal/20 pb-1 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-terminal" />
                            Surprise Engine
                        </div>
                        <Toggle active={context.surpriseEngineActive ?? true} onChange={() => updateContext({ surpriseEngineActive: !(context.surpriseEngineActive ?? true) })} />
                    </div>
                    <div className="bg-void border border-border p-3 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">Initial DC (Default 95)</label>
                                <input
                                    type="number"
                                    value={context.surpriseConfig?.initialDC ?? 95}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), initialDC: isNaN(val) ? 95 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                                />
                            </div>
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">DC Drop per turn (Def 3)</label>
                                <input
                                    type="number"
                                    value={context.surpriseConfig?.dcReduction ?? 3}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), dcReduction: isNaN(val) ? 3 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                                />
                            </div>
                        </div>

                        <div className="flex flex-col">
                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                <span>Event Types (Comma Separated)</span>
                                <span className="flex items-center gap-2">
                                    {renderPopulateButton('surpriseTypes', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.surpriseConfig?.types || DEFAULT_SURPRISE_TYPES;
                                        const result = await populateEngineTags(provider, lore, current, 'surpriseTypes');
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), types: result } });
                                    })}
                                    <span className={(context.surpriseConfig?.types?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.surpriseConfig?.types.join(', ') ?? DEFAULT_SURPRISE_TYPES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), types: tags } });
                                }}
                                placeholder="ENVIRONMENTAL_HAZARD, NPC_ACTION..."
                                rows={3}
                                className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y min-h-[80px] md:min-h-0"
                            />
                        </div>
                        <div className="flex flex-col">
                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                <span>Event Tones (Comma Separated)</span>
                                <span className="flex items-center gap-2">
                                    {renderPopulateButton('surpriseTones', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.surpriseConfig?.tones || DEFAULT_SURPRISE_TONES;
                                        const result = await populateEngineTags(provider, lore, current, 'surpriseTones');
                                        updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), tones: result } });
                                    })}
                                    <span className={(context.surpriseConfig?.tones?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.surpriseConfig?.tones.join(', ') ?? DEFAULT_SURPRISE_TONES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ surpriseConfig: { ...(context.surpriseConfig || surpriseDefaults), tones: tags } });
                                }}
                                placeholder="GOOD, BAD, NEUTRAL..."
                                rows={2}
                                className="w-full bg-surface border border-border px-2 py-1.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y"
                            />
                        </div>
                    </div>
                </div>

                {/* Encounter Engine */}
                <div className="space-y-2">
                    <div className="text-[10px] text-ember uppercase tracking-wider font-bold border-b border-ember/20 pb-1 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-ember" />
                            Encounter Engine
                        </div>
                        <Toggle active={context.encounterEngineActive ?? true} onChange={() => updateContext({ encounterEngineActive: !(context.encounterEngineActive ?? true) })} />
                    </div>
                    <div className="bg-void border border-border p-3 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">Initial DC (Default 198)</label>
                                <input
                                    type="number"
                                    value={context.encounterConfig?.initialDC ?? 198}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), initialDC: isNaN(val) ? 198 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                                />
                            </div>
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">DC Drop per turn (Def 2)</label>
                                <input
                                    type="number"
                                    value={context.encounterConfig?.dcReduction ?? 2}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), dcReduction: isNaN(val) ? 2 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                                />
                            </div>
                        </div>

                        <div className="flex flex-col">
                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                <span>Event Types (Comma Separated)</span>
                                <span className="flex items-center gap-2">
                                    {renderPopulateButton('encounterTypes', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.encounterConfig?.types || DEFAULT_ENCOUNTER_TYPES;
                                        const result = await populateEngineTags(provider, lore, current, 'encounterTypes');
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), types: result } });
                                    })}
                                    <span className={(context.encounterConfig?.types?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.encounterConfig?.types.join(', ') ?? DEFAULT_ENCOUNTER_TYPES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), types: tags } });
                                }}
                                placeholder="AMBUSH, RIVAL_APPEARANCE..."
                                rows={3}
                                className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y min-h-[80px] md:min-h-0"
                            />
                        </div>
                        <div className="flex flex-col">
                            <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                <span>Event Tones (Comma Separated)</span>
                                <span className="flex items-center gap-2">
                                    {renderPopulateButton('encounterTones', async () => {
                                        const provider = useAppStore.getState().getActiveStoryEndpoint();
                                        if (!provider) return;
                                        const lore = context.loreRaw || context.rulesRaw || '';
                                        const current = context.encounterConfig?.tones || DEFAULT_ENCOUNTER_TONES;
                                        const result = await populateEngineTags(provider, lore, current, 'encounterTones');
                                        updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), tones: result } });
                                    })}
                                    <span className={(context.encounterConfig?.tones?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                </span>
                            </label>
                            <textarea
                                value={context.encounterConfig?.tones.join(', ') ?? DEFAULT_ENCOUNTER_TONES.join(', ')}
                                onChange={(e) => {
                                    const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                    updateContext({ encounterConfig: { ...(context.encounterConfig || encounterDefaults), tones: tags } });
                                }}
                                placeholder="TENSE, DESPERATE, EPICK..."
                                rows={2}
                                className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y min-h-[80px] md:min-h-0"
                            />
                        </div>
                    </div>
                </div>

                {/* World Engine */}
                <div className="space-y-2">
                    <div className="text-[10px] text-terminal uppercase tracking-wider font-bold border-b border-terminal/20 pb-1 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-terminal" />
                            World Engine
                        </div>
                        <Toggle active={context.worldEngineActive ?? true} onChange={() => updateContext({ worldEngineActive: !(context.worldEngineActive ?? true) })} />
                    </div>
                    <div className="bg-void border border-border p-3 space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">Initial DC (Default 498)</label>
                                <input
                                    type="number"
                                    value={context.worldEventConfig?.initialDC ?? 498}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), initialDC: isNaN(val) ? 498 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                                />
                            </div>
                            <div className="flex flex-col">
                                <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">DC Drop per turn (Def 2)</label>
                                <input
                                    type="number"
                                    value={context.worldEventConfig?.dcReduction ?? 2}
                                    onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), dcReduction: isNaN(val) ? 2 : val } });
                                    }}
                                    className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                                />
                            </div>
                        </div>
                        {(['who', 'where', 'why', 'what'] as const).map((field) => {
                            const defaults: Record<string, string[]> = { who: DEFAULT_WORLD_WHO, where: DEFAULT_WORLD_WHERE, why: DEFAULT_WORLD_WHY, what: DEFAULT_WORLD_WHAT };
                            const labels: Record<string, string> = { who: '"Who" Elements', where: '"Where" Elements', why: '"Why" Elements', what: '"What" Elements' };
                            const placeholders: Record<string, string> = {
                                who: 'a rogue splinter group, a powerful leader...',
                                where: 'in a neighboring city, deep underground...',
                                why: 'to seize power, for brutal vengeance...',
                                what: 'declared hostilities, discovered a relic...',
                            };
                            return (
                                <div key={field} className="flex flex-col mt-2">
                                    <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1 flex justify-between items-center">
                                        <span>{labels[field]} (Comma Separated)</span>
                                        <span className="flex items-center gap-2">
                                            {renderPopulateButton(`world${field.charAt(0).toUpperCase() + field.slice(1)}`, async () => {
                                                const provider = useAppStore.getState().getActiveStoryEndpoint();
                                                if (!provider) return;
                                                const lore = context.loreRaw || context.rulesRaw || '';
                                                const current = context.worldEventConfig?.[field] || defaults[field];
                                                const result = await populateEngineTags(provider, lore, current, `world${field.charAt(0).toUpperCase() + field.slice(1)}` as 'worldWho' | 'worldWhere' | 'worldWhy' | 'worldWhat');
                                                updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), [field]: result } });
                                            })}
                                            <span className={(context.worldEventConfig?.[field]?.length ?? 0) < 3 ? 'text-danger' : 'text-terminal'}>Min 3 tags</span>
                                        </span>
                                    </label>
                                    <textarea
                                        value={context.worldEventConfig?.[field]?.join(', ') ?? defaults[field].join(', ')}
                                        onChange={(e) => {
                                            const tags = e.target.value.split(',').map(t => t.trim()).filter(Boolean);
                                            updateContext({ worldEventConfig: { ...(context.worldEventConfig || worldDefaults), [field]: tags } });
                                        }}
                                        placeholder={placeholders[field]}
                                        rows={2}
                                        className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors resize-y min-h-[80px] md:min-h-0"
                                    />
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* NPC Appearance Engine */}
                <NpcAppearanceSection context={context} updateContext={updateContext} />

                {/* Dice Fairness Engine (generalized) */}
                <DiceFairnessSection context={context} updateContext={updateContext} />

            </div>
            <NPCPressureInspector />
        </div>
    );
}

// ─── Dice Fairness Section (generalized dice engine) ───────────────────

type DiceFairnessSectionProps = {
    context: ReturnType<typeof useAppStore.getState>['context'];
    updateContext: ReturnType<typeof useAppStore.getState>['updateContext'];
};

function DiceFairnessSection({ context, updateContext }: DiceFairnessSectionProps) {
    const [expandedDie, setExpandedDie] = useState<string | null>(null);
    const diceSystem = context.diceSystem ?? buildDefaultDiceSystem();

    const updateDiceSystem = (patch: Partial<typeof diceSystem>) => {
        updateContext({ diceSystem: { ...diceSystem, ...patch } });
    };

    // ── Die Types helpers ──
    const addDieType = () => {
        const newDie: DieType = {
            id: uid('dt'),
            name: 'd6',
            faces: 6,
            bands: [
                { id: uid('b'), label: 'Failure', min: 1, max: 3 },
                { id: uid('b'), label: 'Success', min: 4, max: 6 },
            ],
        };
        updateDiceSystem({ dieTypes: [...diceSystem.dieTypes, newDie] });
        setExpandedDie(newDie.id);
    };

    const removeDieType = (id: string) => {
        // Remove the die type and any categories referencing it (reassign to d20)
        const fallbackId = diceSystem.dieTypes.find(d => d.name === 'd20')?.id ?? diceSystem.dieTypes[0]?.id;
        const categories = diceSystem.categories.map(c =>
            c.dieTypeId === id && fallbackId ? { ...c, dieTypeId: fallbackId } : c
        );
        updateDiceSystem({
            dieTypes: diceSystem.dieTypes.filter(d => d.id !== id),
            categories,
        });
    };

    const updateDieType = (id: string, patch: Partial<DieType>) => {
        updateDiceSystem({
            dieTypes: diceSystem.dieTypes.map(d => d.id === id ? { ...d, ...patch } : d),
        });
    };

    // ── Band helpers ──
    const addBand = (dieId: string) => {
        const die = diceSystem.dieTypes.find(d => d.id === dieId);
        if (!die) return;
        const usedMax = die.bands.reduce((m, b) => Math.max(m, b.max), 0);
        const newMax = Math.min(usedMax + 1, die.faces);
        const newMin = usedMax + 1;
        if (newMin > die.faces) return; // no room
        const band: OutcomeBand = { id: uid('b'), label: 'New Band', min: newMin, max: newMax };
        updateDieType(dieId, { bands: [...die.bands, band] });
    };

    const updateBand = (dieId: string, bandId: string, patch: Partial<OutcomeBand>) => {
        const die = diceSystem.dieTypes.find(d => d.id === dieId);
        if (!die) return;
        updateDieType(dieId, {
            bands: die.bands.map(b => b.id === bandId ? { ...b, ...patch } : b),
        });
    };

    const removeBand = (dieId: string, bandId: string) => {
        const die = diceSystem.dieTypes.find(d => d.id === dieId);
        if (!die) return;
        updateDieType(dieId, { bands: die.bands.filter(b => b.id !== bandId) });
    };

    // ── Category helpers ──
    const addCategory = () => {
        if (diceSystem.categories.length >= 10) return;
        const fallbackId = diceSystem.dieTypes[0]?.id ?? '';
        const cat: DiceCategory = { id: uid('cat'), name: 'New Category', dieTypeId: fallbackId };
        updateDiceSystem({ categories: [...diceSystem.categories, cat] });
    };

    const updateCategory = (id: string, patch: Partial<DiceCategory>) => {
        updateDiceSystem({
            categories: diceSystem.categories.map(c => c.id === id ? { ...c, ...patch } : c),
        });
    };

    const removeCategory = (id: string) => {
        updateDiceSystem({ categories: diceSystem.categories.filter(c => c.id !== id) });
    };

    return (
        <div className="space-y-2">
            <div className="text-[10px] text-ice uppercase tracking-wider font-bold border-b border-ice/20 pb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-ice" />
                    Dice Fairness Engine
                </div>
                <Toggle active={context.diceFairnessActive ?? true} onChange={() => updateContext({ diceFairnessActive: !(context.diceFairnessActive ?? true) })} />
            </div>

            <div className="text-[9px] text-amber-400/70 italic px-1">
                {(context.diceFairnessActive ?? true)
                    ? '⚡ Pool mode active — pre-rolled dice injected. AI dice tools are inactive.'
                    : context.diceToolEnabled === false
                    ? 'AI dice tools are off. Use Dice Me to arm a manual roll or turn AI dice tools on.'
                    : 'Story AI can call roll_dice on demand. Use Dice Me to turn AI dice tools off.'}
            </div>

            <div className="bg-void border border-border p-3 space-y-3">
                {/* ── Die Types Registry ── */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-text-dim uppercase tracking-wider font-bold">Die Types</span>
                        <button onClick={addDieType} className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors">
                            <Plus size={9} /> Add
                        </button>
                    </div>
                    {diceSystem.dieTypes.map((die) => {
                        const isExpanded = expandedDie === die.id;
                        const validation = validateBands(die.bands, die.faces);
                        return (
                            <div key={die.id} className="border border-border/50 rounded bg-surface/30">
                                <div className="flex items-center gap-2 px-2 py-1.5">
                                    <button
                                        onClick={() => setExpandedDie(isExpanded ? null : die.id)}
                                        className="text-text-dim hover:text-text-primary transition-colors"
                                    >
                                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                                    </button>
                                    <input
                                        type="text"
                                        value={die.name}
                                        onChange={(e) => updateDieType(die.id, { name: e.target.value })}
                                        className="w-16 bg-surface border border-border px-1.5 py-1 text-[11px] font-mono text-text-primary focus:border-terminal outline-none"
                                    />
                                    <span className="text-[9px] text-text-dim">faces:</span>
                                    <input
                                        type="number"
                                        min={2}
                                        max={1000}
                                        value={die.faces}
                                        onChange={(e) => {
                                            const faces = parseInt(e.target.value) || 2;
                                            updateDieType(die.id, { faces });
                                        }}
                                        className="w-14 bg-surface border border-border px-1.5 py-1 text-[11px] font-mono text-text-primary focus:border-terminal outline-none"
                                    />
                                    {!validation.valid && (
                                        <span className="text-[9px] text-danger" title={validation.error}>⚠</span>
                                    )}
                                    <div className="ml-auto flex items-center gap-1">
                                        <span className="text-[9px] text-text-dim">{die.bands.length} bands</span>
                                        <button
                                            onClick={() => removeDieType(die.id)}
                                            className="text-text-dim hover:text-danger transition-colors"
                                            title="Remove die type"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                </div>
                                {isExpanded && (
                                    <div className="px-2 pb-2 space-y-1.5 border-t border-border/30">
                                        {!validation.valid && (
                                            <div className="text-[9px] text-danger px-1 py-1 bg-danger/10 rounded">{validation.error}</div>
                                        )}
                                        {die.bands.map((band, i) => (
                                            <div key={band.id} className="flex items-center gap-1.5">
                                                <span className="text-[9px] text-text-dim w-4">{i + 1}.</span>
                                                <input
                                                    type="text"
                                                    value={band.label}
                                                    onChange={(e) => updateBand(die.id, band.id, { label: e.target.value })}
                                                    placeholder="Label"
                                                    className="flex-1 bg-surface border border-border px-1.5 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none"
                                                />
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={die.faces}
                                                    value={band.min}
                                                    onChange={(e) => updateBand(die.id, band.id, { min: parseInt(e.target.value) || 1 })}
                                                    className="w-12 bg-surface border border-border px-1 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none text-center"
                                                    title="Min (inclusive)"
                                                />
                                                <span className="text-[9px] text-text-dim">–</span>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    max={die.faces}
                                                    value={band.max}
                                                    onChange={(e) => updateBand(die.id, band.id, { max: parseInt(e.target.value) || 1 })}
                                                    className="w-12 bg-surface border border-border px-1 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none text-center"
                                                    title="Max (inclusive)"
                                                />
                                                <button
                                                    onClick={() => removeBand(die.id, band.id)}
                                                    className="text-text-dim hover:text-danger transition-colors"
                                                >
                                                    <Trash2 size={9} />
                                                </button>
                                            </div>
                                        ))}
                                        <button
                                            onClick={() => addBand(die.id)}
                                            className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors py-1"
                                        >
                                            <Plus size={9} /> Add Band
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* ── Categories (up to 10) ── */}
                <div className="space-y-2 border-t border-border/30 pt-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] text-text-dim uppercase tracking-wider font-bold">Categories (max 10)</span>
                        <button
                            onClick={addCategory}
                            disabled={diceSystem.categories.length >= 10}
                            className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30"
                        >
                            <Plus size={9} /> Add
                        </button>
                    </div>
                    {diceSystem.categories.map((cat) => (
                        <div key={cat.id} className="flex items-center gap-2">
                            <input
                                type="text"
                                value={cat.name}
                                onChange={(e) => updateCategory(cat.id, { name: e.target.value })}
                                className="flex-1 bg-surface border border-border px-1.5 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none"
                            />
                            <select
                                value={cat.dieTypeId}
                                onChange={(e) => updateCategory(cat.id, { dieTypeId: e.target.value })}
                                className="w-20 bg-surface border border-border px-1.5 py-1 text-[10px] font-mono text-text-primary focus:border-terminal outline-none"
                            >
                                {diceSystem.dieTypes.map(d => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                ))}
                            </select>
                            <button
                                onClick={() => removeCategory(cat.id)}
                                className="text-text-dim hover:text-danger transition-colors"
                            >
                                <Trash2 size={10} />
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── NPC Appearance Engine Section ─────────────────────────────────────

type NpcAppearanceSectionProps = {
    context: ReturnType<typeof useAppStore.getState>['context'];
    updateContext: ReturnType<typeof useAppStore.getState>['updateContext'];
};

const NPC_INTRO_DEFAULTS: NpcIntroConfig = { initialDC: 196, dcReduction: 2, characters: [] };

const ENTRY_TYPE_OPTIONS: { value: CharacterIntroEntry['type']; label: string }[] = [
    { value: 'wandering', label: 'Wandering' },
    { value: 'location', label: 'Location' },
    { value: 'wandering+boosted', label: 'Wandering+Boosted' },
    { value: 'location+boosted', label: 'Location+Boosted' },
];

function NpcAppearanceSection({ context, updateContext }: NpcAppearanceSectionProps) {
    const aiTier = useAppStore((s) => s.settings.aiTier);
    const npcLedger = useAppStore((s) => s.npcLedger);
    const active = context.npcIntroEngineActive ?? true;
    const config: NpcIntroConfig = context.npcIntroConfig ?? NPC_INTRO_DEFAULTS;
    const characters = config.characters;
    const candidateCount = characters.length;
    const isMaxTier = (aiTier ?? 'pro') === 'max';

    const updateConfig = (patch: Partial<NpcIntroConfig>) => {
        updateContext({ npcIntroConfig: { ...config, ...patch } });
    };

    const removeCharacter = (name: string) => {
        updateConfig({ characters: characters.filter(c => c.name !== name) });
    };

    const addCharacter = (entry: CharacterIntroEntry) => {
        if (characters.some(c => c.name.toLowerCase() === entry.name.toLowerCase())) return;
        updateConfig({ characters: [...characters, entry] });
    };

    const [newName, setNewName] = useState('');
    const [newType, setNewType] = useState<CharacterIntroEntry['type']>('wandering');
    const [newLocation, setNewLocation] = useState('');
    const [newBoost, setNewBoost] = useState('');

    const pooledNames = new Set(characters.map(c => c.name.toLowerCase()));
    const availableNpcs = [...npcLedger]
        .filter(n => !pooledNames.has(n.name.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const handleAdd = () => {
        const name = newName.trim();
        if (!name) return;
        const entry: CharacterIntroEntry = { name, type: newType };
        if (newType === 'location' || newType === 'location+boosted') {
            const loc = newLocation.trim();
            if (loc) entry.location = loc;
        }
        if (newType === 'wandering+boosted' || newType === 'location+boosted') {
            const kws = newBoost.split(',').map(s => s.trim()).filter(Boolean);
            if (kws.length > 0) entry.boostKeywords = kws;
        }
        addCharacter(entry);
        setNewName('');
        setNewLocation('');
        setNewBoost('');
    };

    return (
        <div className="space-y-2">
            <div className="text-[10px] text-terminal uppercase tracking-wider font-bold border-b border-terminal/20 pb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-terminal" />
                    NPC Appearance Engine
                    <span className="text-text-dim normal-case font-normal tracking-normal text-[9px]">
                        {candidateCount} candidate{candidateCount === 1 ? '' : 's'}
                    </span>
                </div>
                <Toggle active={active} onChange={() => updateContext({ npcIntroEngineActive: !active })} />
            </div>
            <div className="bg-void border border-border p-3 space-y-3">
                <p className="text-[9px] text-text-dim leading-relaxed">
                    Pulls pre-seeded characters into scenes on a decaying DC roll. Useful for worlds with many named NPCs.
                    {isMaxTier ? null : (
                        <span className="text-amber-400 block mt-1">
                            Only fires on the <span className="font-bold">Max</span> AI tier — currently {aiTier ?? 'pro'}.
                        </span>
                    )}
                </p>

                <div className="grid grid-cols-2 gap-2">
                    <div className="flex flex-col">
                        <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">Initial DC (Default 196)</label>
                        <input
                            type="number"
                            value={config.initialDC}
                            onChange={(e) => {
                                const val = parseInt(e.target.value);
                                updateConfig({ initialDC: isNaN(val) ? 196 : val });
                            }}
                            className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                        />
                    </div>
                    <div className="flex flex-col">
                        <label className="text-[10px] text-text-dim uppercase tracking-wider mb-1">DC Drop per turn (Def 2)</label>
                        <input
                            type="number"
                            value={config.dcReduction}
                            onChange={(e) => {
                                const val = parseInt(e.target.value);
                                updateConfig({ dcReduction: isNaN(val) ? 2 : val });
                            }}
                            className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                        />
                    </div>
                </div>

                <div className="pt-2 border-t border-border/40 space-y-1.5">
                    <label className="text-[10px] text-text-dim uppercase tracking-wider">Candidate Pool</label>
                    {characters.length === 0 ? (
                        <p className="text-[10px] text-text-dim/60 italic">No candidates. Add one below or re-seed from lore.</p>
                    ) : (
                        <div className="space-y-1">
                            {characters.map((c) => (
                                <div key={c.name} className="flex items-center justify-between bg-surface border border-border px-2 py-1.5 rounded text-[11px] md:text-[10px]">
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-text-primary font-mono truncate">{c.name}</span>
                                        <span className="text-text-dim text-[9px]">
                                            {ENTRY_TYPE_OPTIONS.find(o => o.value === c.type)?.label ?? c.type}
                                            {c.location ? ` · ${c.location}` : ''}
                                            {c.boostKeywords && c.boostKeywords.length > 0 ? ` · boost: ${c.boostKeywords.join(', ')}` : ''}
                                        </span>
                                    </div>
                                    <button
                                        onClick={() => removeCharacter(c.name)}
                                        className="text-text-dim hover:text-danger transition-colors shrink-0 ml-2"
                                        title="Remove from appearance pool"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="pt-2 border-t border-border/40 space-y-2">
                    <label className="text-[10px] text-text-dim uppercase tracking-wider">Add Candidate</label>
                    <div className="grid grid-cols-2 gap-2">
                        <select
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            className="bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                        >
                            <option value="">Select NPC…</option>
                            {availableNpcs.map(n => (
                                <option key={n.id} value={n.name}>{n.name}</option>
                            ))}
                        </select>
                        <select
                            value={newType}
                            onChange={(e) => setNewType(e.target.value as CharacterIntroEntry['type'])}
                            className="bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                        >
                            {ENTRY_TYPE_OPTIONS.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                        </select>
                    </div>
                    {(newType === 'location' || newType === 'location+boosted') && (
                        <input
                            type="text"
                            value={newLocation}
                            onChange={(e) => setNewLocation(e.target.value)}
                            placeholder="Location (e.g. Konoha)"
                            className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                        />
                    )}
                    {(newType === 'wandering+boosted' || newType === 'location+boosted') && (
                        <input
                            type="text"
                            value={newBoost}
                            onChange={(e) => setNewBoost(e.target.value)}
                            placeholder="Boost keywords (comma-separated)"
                            className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[11px] font-mono text-text-primary focus:border-terminal outline-none transition-colors min-h-[44px] md:min-h-0"
                        />
                    )}
                    <button
                        onClick={handleAdd}
                        disabled={!newName.trim()}
                        className="flex items-center gap-1 text-[10px] text-terminal hover:text-text-primary transition-colors disabled:opacity-30 min-h-[36px] md:min-h-0"
                    >
                        <Plus size={12} />
                        Add to pool
                    </button>
                </div>
            </div>
        </div>
    );
}
