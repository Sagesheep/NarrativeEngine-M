import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SamplingConfig, AIPreset } from '../types';
import { SAMPLING_PROFILES, SAMPLING_FIELDS } from '../utils/samplingProfiles';

type Props = {
    preset: AIPreset;
    onUpdate: (sampling: SamplingConfig) => void;
};

export function SamplingPanel({ preset, onUpdate }: Props) {
    const [expanded, setExpanded] = useState(false);
    const [showLocal, setShowLocal] = useState(false);
    const sampling: SamplingConfig = preset.sampling ?? {};

    const handleProfileSelect = (profileId: string) => {
        const profile = SAMPLING_PROFILES.find(p => p.id === profileId);
        if (profile) {
            onUpdate({ ...profile.params });
        }
    };

    const handleFieldChange = (key: keyof SamplingConfig, value: number | undefined) => {
        onUpdate({ ...sampling, [key]: value });
    };

    const activeProfileId = SAMPLING_PROFILES.find(p =>
        JSON.stringify(p.params) === JSON.stringify(sampling)
    )?.id ?? '';

    const cloudFields = SAMPLING_FIELDS.filter(f => f.cloud);
    const localFields = SAMPLING_FIELDS.filter(f => !f.cloud);

    return (
        <div className="border border-border rounded mb-3 bg-void-lighter overflow-hidden">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors min-h-[48px]"
            >
                <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
                    {expanded ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
                    Sampling &amp; Generation
                </div>
                {sampling.temperature !== undefined && (
                    <span className="text-[10px] font-mono text-terminal bg-terminal/10 px-2 py-0.5 rounded">
                        T={sampling.temperature}
                    </span>
                )}
            </button>

            {expanded && (
                <div className="p-4 space-y-4 border-t border-border bg-void">
                    <div>
                        <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">
                            Quick Setup (Model Presets)
                        </label>
                        <select
                            value={activeProfileId}
                            onChange={(e) => handleProfileSelect(e.target.value)}
                            className="w-full bg-surface border border-border px-3 py-3 text-sm text-text-primary font-mono focus:border-terminal focus:outline-none min-h-[48px]"
                        >
                            <option value="">Custom</option>
                            {SAMPLING_PROFILES.map(p => (
                                <option key={p.id} value={p.id}>
                                    {p.name} — {p.description}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="space-y-3">
                        <label className="block text-[10px] text-text-dim uppercase tracking-wider">
                            Sampling Parameters
                        </label>
                        {cloudFields.map(field => (
                            <SliderRow
                                key={field.key}
                                label={field.label}
                                value={sampling[field.key] as number | undefined}
                                min={field.min}
                                max={field.max}
                                step={field.step}
                                onChange={(v) => handleFieldChange(field.key, v)}
                            />
                        ))}
                    </div>

                    <div>
                        <button
                            onClick={() => setShowLocal(!showLocal)}
                            className="text-[10px] text-text-dim uppercase tracking-wider hover:text-text-primary transition-colors min-h-[44px] flex items-center gap-1"
                        >
                            {showLocal ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            Local Inference Params (llama.cpp / koboldcpp)
                        </button>
                        {showLocal && (
                            <div className="space-y-3 mt-2 pl-2 border-l-2 border-border">
                                {localFields.map(field => (
                                    <SliderRow
                                        key={field.key}
                                        label={field.label}
                                        value={sampling[field.key] as number | undefined}
                                        min={field.min}
                                        max={field.max}
                                        step={field.step}
                                        onChange={(v) => handleFieldChange(field.key, v)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    <button
                        onClick={() => onUpdate({})}
                        className="text-[10px] text-danger/70 hover:text-danger uppercase tracking-wider transition-colors min-h-[44px]"
                    >
                        Reset to Defaults
                    </button>
                </div>
            )}
        </div>
    );
}

function SliderRow({
    label,
    value,
    min,
    max,
    step,
    onChange,
}: {
    label: string;
    value: number | undefined;
    min: number;
    max: number;
    step: number;
    onChange: (v: number | undefined) => void;
}) {
    const currentValue = value ?? min;

    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-text-dim">{label}</span>
                <input
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={value !== undefined ? value : ''}
                    onChange={(e) => {
                        const v = e.target.value === '' ? undefined : parseFloat(e.target.value);
                        onChange(v);
                    }}
                    className="w-20 bg-surface border border-border px-2 py-2 text-[11px] text-text-primary font-mono text-center focus:border-terminal focus:outline-none min-h-[44px]"
                />
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={currentValue}
                onChange={(e) => onChange(parseFloat(e.target.value))}
                className="w-full accent-terminal cursor-pointer h-2"
            />
        </div>
    );
}