import { useState } from 'react';
import { Plus, Trash2, Copy } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { AIPreset, SamplingConfig, SlotThinking, ThinkingSlot } from '../../types';
import { uid } from '../../utils/uid';
import { SamplingPanel } from '../SamplingPanel';
import { SLOT_THINKING_CHOICES, migratePresetSlotThinking } from '../../store/slices/slotThinking';

/** One slot's thinking level, shown under its provider picker. */
function SlotThinkingPicker({ preset, slot, onChange }: {
    preset: AIPreset;
    slot: ThinkingSlot;
    onChange: (slotThinking: NonNullable<AIPreset['slotThinking']>) => void;
}) {
    return (
        <div className="mt-1 flex items-center gap-2">
            <label
                htmlFor={`slot-thinking-${slot}`}
                className="text-[10px] text-text-dim uppercase tracking-wider shrink-0"
                title="How much this slot's model reasons before answering. Model default sends nothing, so the model decides (many think by default). Off asks the host to turn thinking off; models that must think drop to their lowest level. Short helper calls always run with Off."
            >
                Thinking
            </label>
            <select
                id={`slot-thinking-${slot}`}
                data-testid={`slot-thinking-${slot}`}
                value={preset.slotThinking?.[slot] ?? 'default'}
                onChange={(e) => onChange({ ...preset.slotThinking, [slot]: e.target.value as SlotThinking })}
                className="flex-1 bg-surface border border-border px-2 py-2 md:py-1 text-[16px] md:text-xs text-text-primary focus:border-terminal focus:outline-none appearance-none"
            >
                {SLOT_THINKING_CHOICES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                ))}
            </select>
        </div>
    );
}

export function PresetsPanel() {
    const settings = useAppStore(s => s.settings);
    const addPreset = useAppStore(s => s.addPreset);
    const updatePreset = useAppStore(s => s.updatePreset);
    const removePreset = useAppStore(s => s.removePreset);

    const [activeTab, setActiveTab] = useState(settings.presets[0]?.id || '');

    const activePreset = settings.presets.find((p) => p.id === activeTab) || settings.presets[0];

    const handleAddPreset = () => {
        const firstProviderId = settings.providers[0]?.id || '';
        const newPreset: AIPreset = {
            id: uid(),
            name: `Preset ${settings.presets.length + 1}`,
            storyAIProviderId: firstProviderId,
            summarizerAIProviderId: '',
            utilityAIProviderId: '',
            auxiliaryAIProviderId: '',
            imageAIProviderId: '',
        };
        addPreset(migratePresetSlotThinking(newPreset, settings.providers));
        setActiveTab(newPreset.id);
    };

    const handleDuplicatePreset = () => {
        if (!activePreset) return;
        const duplicated: AIPreset = {
            ...activePreset,
            id: uid(),
            name: `${activePreset.name} (copy)`,
        };
        addPreset(duplicated);
        setActiveTab(duplicated.id);
    };

    const handleRemovePreset = (id: string) => {
        if (settings.presets.length <= 1) return;
        removePreset(id);
        setActiveTab(settings.presets[0]?.id || '');
    };

    const handleUpdatePresetName = (name: string) => {
        if (!activePreset) return;
        updatePreset(activePreset.id, { name });
    };

    return (
        <div className="flex flex-col">
            <div className="flex flex-col mb-8">
                <label className="text-text-dim text-xs uppercase tracking-widest mb-3 font-bold">AI Presets</label>
                <div className="flex items-center gap-1 border-b border-border overflow-x-auto pb-px">
                    {settings.presets.map((p) => (
                        <button
                            key={p.id}
                            onClick={() => setActiveTab(p.id)}
                            className={`px-4 py-3 md:py-2 text-xs md:text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px ${activeTab === p.id
                                ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                                : 'text-text-dim border-transparent hover:text-text-primary'
                            }`}
                        >
                            {p.name}
                        </button>
                    ))}
                    <button
                        onClick={handleAddPreset}
                        className="px-4 py-3 md:py-2 text-text-dim hover:text-terminal transition-colors touch-btn"
                    >
                        <Plus size={18} />
                    </button>
                </div>
            </div>

            {activePreset && (
                <div className="mb-8">
                    <div className="flex gap-2 items-end mb-8">
                        <div className="flex-1">
                            <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Preset Name</label>
                            <input
                                type="text"
                                value={activePreset.name}
                                onChange={(e) => handleUpdatePresetName(e.target.value)}
                                className="w-full bg-void border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary font-bold focus:border-terminal focus:outline-none"
                            />
                        </div>
                        <button
                            onClick={handleDuplicatePreset}
                            className="bg-void border border-border text-text-dim hover:text-terminal hover:border-terminal transition-colors touch-btn px-3 py-2"
                            title="Duplicate preset"
                        >
                            <Copy size={18} />
                        </button>
                        {settings.presets.length > 1 && (
                            <button
                                onClick={() => handleRemovePreset(activePreset.id)}
                                className="bg-void border border-danger/40 text-danger touch-btn hover:bg-danger/10"
                            >
                                <Trash2 size={20} />
                            </button>
                        )}
                    </div>

                    <div className="space-y-4 mb-6">
                        <div>
                            <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Story & Logic AI <span className="text-terminal">*</span></label>
                            <select
                                value={activePreset.storyAIProviderId}
                                onChange={(e) => updatePreset(activePreset.id, { storyAIProviderId: e.target.value })}
                                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
                            >
                                {settings.providers.map(p => (
                                    <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                                ))}
                            </select>
                            <SlotThinkingPicker preset={activePreset} slot="story" onChange={(slotThinking) => updatePreset(activePreset.id, { slotThinking })} />
                        </div>

                        <div>
                            <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Summarizer & Context AI</label>
                            <select
                                value={activePreset.summarizerAIProviderId || ''}
                                onChange={(e) => updatePreset(activePreset.id, { summarizerAIProviderId: e.target.value })}
                                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
                            >
                                <option value="">Fallback to Story AI</option>
                                {settings.providers.map(p => (
                                    <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                                ))}
                            </select>
                            <SlotThinkingPicker preset={activePreset} slot="summarizer" onChange={(slotThinking) => updatePreset(activePreset.id, { slotThinking })} />
                        </div>

                        <div>
                            <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Utility AI (Context Recommender)</label>
                            <select
                                value={activePreset.utilityAIProviderId || ''}
                                onChange={(e) => updatePreset(activePreset.id, { utilityAIProviderId: e.target.value })}
                                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
                            >
                                <option value="">None</option>
                                {settings.providers.map(p => (
                                    <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                                ))}
                            </select>
                            <SlotThinkingPicker preset={activePreset} slot="utility" onChange={(slotThinking) => updatePreset(activePreset.id, { slotThinking })} />
                        </div>

                        <div>
                            <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Auxiliary AI (NPC Validator)</label>
                            <select
                                value={activePreset.auxiliaryAIProviderId || ''}
                                onChange={(e) => updatePreset(activePreset.id, { auxiliaryAIProviderId: e.target.value })}
                                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
                            >
                                <option value="">None</option>
                                {settings.providers.map(p => (
                                    <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                                ))}
                            </select>
                            <SlotThinkingPicker preset={activePreset} slot="auxiliary" onChange={(slotThinking) => updatePreset(activePreset.id, { slotThinking })} />
                        </div>

                        <div>
                            <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Image Generation AI</label>
                            <select
                                value={activePreset.imageAIProviderId || ''}
                                onChange={(e) => updatePreset(activePreset.id, { imageAIProviderId: e.target.value })}
                                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
                            >
                                <option value="">None</option>
                                {settings.providers.map(p => (
                                    <option key={p.id} value={p.id}>{p.label || p.modelName || p.endpoint}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <SamplingPanel
                        preset={activePreset}
                        onUpdate={(sampling: SamplingConfig) => updatePreset(activePreset.id, { sampling })}
                    />
                </div>
            )}
        </div>
    );
}