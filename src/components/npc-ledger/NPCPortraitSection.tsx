import { Loader2, Image as ImageIcon } from 'lucide-react';
import type { NPCVisualProfile } from '../../types';

type Props = {
    portrait?: string;
    name: string;
    visualProfile: NPCVisualProfile;
    isEditing: boolean;
    isGeneratingImage: boolean;
    onGeneratePortrait: () => void;
    onVisualProfileChange: (field: keyof NPCVisualProfile, value: string) => void;
    appearance: string;
    onAppearanceChange: (value: string) => void;
};

export function NPCPortraitSection({
    portrait, name, visualProfile, isEditing, isGeneratingImage,
    onGeneratePortrait, onVisualProfileChange, appearance, onAppearanceChange,
}: Props) {
    return (
        <div className="bg-void-lighter p-4 rounded border border-border shadow-inner">
            {portrait ? (
                <div className="relative group mb-4 rounded overflow-hidden border border-border">
                    <img
                        src={portrait}
                        alt={name || 'NPC Portrait'}
                        className="w-full aspect-[3/4] object-cover object-top"
                    />
                    <button
                        type="button"
                        onClick={onGeneratePortrait}
                        disabled={isGeneratingImage || !name}
                        className="absolute bottom-2 right-2 flex items-center gap-2 px-4 md:px-2.5 py-2.5 md:py-1 bg-void/80 border border-border hover:border-terminal text-terminal text-sm md:text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 opacity-100 md:opacity-0 md:group-hover:opacity-100 min-h-[44px] md:min-h-0"
                    >
                        {isGeneratingImage ? <Loader2 size={14} className="animate-spin md:w-[11px] md:h-[11px]" /> : <ImageIcon size={14} className="md:w-[11px] md:h-[11px]" />}
                        Regenerate
                    </button>
                </div>
            ) : null}

            <div className="flex items-center justify-between mb-4 border-b border-border/50 pb-2">
                <div className="text-terminal font-bold uppercase tracking-widest text-xs">
                    Visual Profile (AI Ready)
                </div>
                <div className="flex items-center gap-2">
                    <div className="text-[9px] uppercase tracking-wider text-text-dim hidden sm:block">Portrait Generation Data</div>
                    <button
                        type="button"
                        onClick={onGeneratePortrait}
                        disabled={isGeneratingImage || !name}
                        title="Generate portrait from visual profile"
                        className="flex items-center gap-2 px-4 md:px-2 py-2.5 md:py-1 border border-border hover:border-terminal text-terminal text-sm md:text-[9px] uppercase tracking-wider rounded transition-colors disabled:opacity-50 min-h-[44px] md:min-h-0"
                    >
                        {isGeneratingImage ? <Loader2 size={14} className="animate-spin md:w-[10px] md:h-[10px]" /> : <ImageIcon size={14} className="md:w-[10px] md:h-[10px]" />}
                        {isGeneratingImage ? 'Generating\u2026' : portrait ? 'Regen' : 'Generate'}
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                {[
                    { k: 'race', l: 'Race / Species' },
                    { k: 'gender', l: 'Gender' },
                    { k: 'ageRange', l: 'Age Range' },
                    { k: 'build', l: 'Build / Body Type' },
                    { k: 'symmetry', l: 'Attract / Symmetry' },
                    { k: 'skinTone', l: 'Skin Tone' },
                    { k: 'hairStyle', l: 'Hair Style & Color' },
                    { k: 'eyeColor', l: 'Eye Color' },
                    { k: 'gait', l: 'Gait / Posture' },
                    { k: 'clothing', l: 'Clothing Style' },
                    { k: 'distinctMarks', l: 'Distinct Marks' },
                ].map(({ k, l }) => (
                    <div key={k} className={k === 'clothing' || k === 'distinctMarks' ? 'col-span-2' : ''}>
                        <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">{l}</label>
                        <input
                            type="text"
                            value={visualProfile?.[k as keyof NPCVisualProfile] || ''}
                            onChange={e => onVisualProfileChange(k as keyof NPCVisualProfile, e.target.value)}
                            disabled={!isEditing}
                            className="w-full bg-surface border border-border rounded px-3 py-2.5 md:py-1.5 text-[16px] md:text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal min-h-[48px] md:min-h-0"
                        />
                    </div>
                ))}
            </div>

            <div className="mt-3">
                <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">Art Style</label>
                <select
                    value={visualProfile?.artStyle || 'Realistic'}
                    onChange={e => onVisualProfileChange('artStyle', e.target.value)}
                    disabled={!isEditing}
                    className="w-full bg-surface border border-border rounded px-3 py-2.5 md:py-1.5 text-[16px] md:text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal outline-none min-h-[48px] md:min-h-0"
                >
                    <option value="Realistic">Realistic</option>
                    <option value="Anime Realistic">Anime Realistic (Makoto Shinkai)</option>
                    <option value="Anime">Anime (Kyoto Animation)</option>
                    <option value="Western RPG">Western RPG (Baldur's Gate 3)</option>
                    <option value="Chibi">Chibi</option>
                </select>
            </div>

            <div className="mt-4 pt-4 border-t border-border/50">
                <label className="block text-text-dim text-[9px] uppercase tracking-wider mb-1">Legacy Appearance Notes (Fallback)</label>
                <textarea
                    value={appearance || ''}
                    onChange={(e) => onAppearanceChange(e.target.value)}
                    disabled={!isEditing}
                    rows={2}
                    className="w-full bg-surface border border-border rounded px-3 py-2.5 md:py-1.5 text-[16px] md:text-xs text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal min-h-[80px] md:min-h-0"
                />
            </div>
        </div>
    );
}
