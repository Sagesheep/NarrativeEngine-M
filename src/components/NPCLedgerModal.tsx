import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Save, Users, User, Search, Image as ImageIcon, Loader2 } from 'lucide-react';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { useAppStore } from '../store/useAppStore';
import type { NPCEntry } from '../types';

// Helper to format axis labels based on 1-10 value
const AXIS_LABELS: Record<string, string[]> = {
    'Nature': ['Pacifist', 'Gentle', 'Cautious', 'Measured', 'Pragmatic', 'Assertive', 'Aggressive', 'Brutal', 'Savage', 'Feral'],
    'Training': ['Untrained', 'Dabbler', 'Novice', 'Apprentice', 'Competent', 'Seasoned', 'Veteran', 'Expert', 'Master', 'Legendary'],
    'Emotion': ['Hollow', 'Stoic', 'Guarded', 'Composed', 'Steady', 'Sensitive', 'Volatile', 'Intense', 'Explosive', 'Hysterical'],
    'Social': ['Mute', 'Recluse', 'Shy', 'Reserved', 'Neutral', 'Sociable', 'Charismatic', 'Influential', 'Magnetic', 'Manipulative'],
    'Belief': ['Nihilist', 'Apathetic', 'Skeptic', 'Doubter', 'Moderate', 'Faithful', 'Devout', 'Zealous', 'Fanatical', 'Messianic'],
    'Ego': ['Selfless', 'Servile', 'Meek', 'Humble', 'Balanced', 'Confident', 'Proud', 'Arrogant', 'Narcissistic', 'God-Complex']
};

function getAxisLabel(axis: string, value: number) {
    const list = AXIS_LABELS[axis];
    if (!list) return '';
    // Value is 1-10, Array index is 0-9
    const index = Math.max(0, Math.min(9, value - 1));
    return list[index];
}

export function NPCLedgerModal() {
    const { npcLedger, npcLedgerOpen, toggleNPCLedger, addNPC, updateNPC, removeNPC } = useAppStore();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [imageStyle, setImageStyle] = useState('Realistic');
    const [isGeneratingImage, setIsGeneratingImage] = useState(false);
    const IMAGE_STYLES = ['Realistic', 'Anime Realistic', 'Full Anime', 'Chibi', 'Cartoonish', 'Western animation'];

    // Form state
    const [form, setForm] = useState<Partial<NPCEntry>>({
        status: 'Alive', nature: 5, training: 1, emotion: 5, social: 5, belief: 5, ego: 5, affinity: 50
    });

    // Close on escape
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && npcLedgerOpen) toggleNPCLedger();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [npcLedgerOpen, toggleNPCLedger]);

    if (!npcLedgerOpen) return null;

    const handleSelect = (npc: NPCEntry) => {
        setSelectedId(npc.id);
        setForm({ ...npc });
        setIsEditing(false);
    };

    const handleCreateNew = () => {
        setSelectedId(null);
        setForm({ name: '', aliases: '', appearance: '', disposition: '', status: 'Alive', goals: '', nature: 5, training: 1, emotion: 5, social: 5, belief: 5, ego: 5, affinity: 50, portrait: '' });
        setIsEditing(true);
    };

    const handleGenerateImage = async () => {
        const endpoint = useAppStore.getState().settings.imageApiEndpoint;
        const apiKey = useAppStore.getState().settings.imageApiKey;
        const apiModel = useAppStore.getState().settings.imageApiModel;

        if (!endpoint) {
            alert('Please configure the Image API Endpoint in Settings first.');
            return;
        }
        if (!form.appearance) {
            alert('Please provide some Visual Profiling text first.');
            return;
        }

        setIsGeneratingImage(true);
        try {
            const stylePrompts: Record<string, string> = {
                'Realistic': 'hyper-realistic, photorealistic, cinematic lighting, 8k resolution, intricate detail, professional photography',
                'Anime Realistic': 'semi-realistic anime style, digital art, high quality, vibrant colors, sharp focus, Makoto Shinkai aesthetic',
                'Full Anime': 'high quality anime, cel shaded, clean lines, vibrant digital art, Kyoto Animation style',
                'Chibi': 'cute chibi style, large expressive eyes, small body, soft shading, sticker art quality',
                'Cartoonish': 'stylized cartoon art, bold colors, expressive features, modern animation aesthetic, clean rendering',
                'Western animation': 'Arcane aesthetic, painterly texture, dramatic lighting, high quality digital painting'
            };
            const stylePrefix = stylePrompts[imageStyle] || imageStyle;
            const prompt = `${stylePrefix} portrait of a character with this appearance: ${form.appearance}`;

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
                },
                body: JSON.stringify({
                    ...(apiModel ? { model: apiModel } : {}),
                    prompt,
                    n: 1,
                    size: "512x512",
                    response_format: "b64_json"
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(errText || `Image API failed with status ${response.status}`);
            }

            const data = await response.json();
            const b64 = data?.data?.[0]?.b64_json;
            if (!b64) {
                throw new Error("No image data returned from API.");
            }

            const filename = `npc_${selectedId || Date.now()}_${Date.now()}.png`;
            await Filesystem.writeFile({
                path: filename,
                data: b64,
                directory: Directory.Data
            });

            const uriResult = await Filesystem.getUri({
                path: filename,
                directory: Directory.Data
            });

            const safeUrl = Capacitor.convertFileSrc(uriResult.uri);
            setForm(prev => ({ ...prev, portrait: safeUrl }));

            if (selectedId) {
                updateNPC(selectedId, { ...form, portrait: safeUrl });
            }

        } catch (err: any) {
            console.error('Image Generation Error:', err);
            alert(`Failed to generate portrait: ${err.message}`);
        } finally {
            setIsGeneratingImage(false);
        }
    };

    const handleSave = () => {
        if (!form.name?.trim()) return;

        if (selectedId) {
            updateNPC(selectedId, form);
        } else {
            addNPC({
                ...form,
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
            } as NPCEntry);
        }
        setIsEditing(false);
    };

    const handleDelete = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm('Delete this NPC from the ledger?')) {
            removeNPC(id);
            if (selectedId === id) {
                setSelectedId(null);
                setIsEditing(false);
            }
        }
    };

    const renderSlider = (label: keyof NPCEntry, displayLabel: string) => {
        const value = form[label] as number ?? 5;
        return (
            <div className="mb-4">
                <div className="flex justify-between items-end mb-1">
                    <label className="text-text-dim text-xs uppercase tracking-wider">{displayLabel}</label>
                    <span className="text-xs text-terminal">{value} / 10 <span className="text-text-dim ml-1 text-[10px] hidden sm:inline">({getAxisLabel(displayLabel, value)})</span></span>
                </div>
                <input
                    type="range"
                    min="1"
                    max="10"
                    value={value}
                    onChange={(e) => setForm({ ...form, [label]: parseInt(e.target.value, 10) })}
                    disabled={!isEditing}
                    className="w-full accent-terminal"
                />
            </div>
        );
    };

    const filteredLedger = npcLedger.filter(n => {
        if (!searchQuery) return true;
        const query = searchQuery.toLowerCase();
        return (n.name?.toLowerCase().includes(query) || (typeof n.aliases === 'string' && n.aliases.toLowerCase().includes(query)));
    });

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4 sm:p-8" onClick={toggleNPCLedger}>
            <div className="bg-surface border border-border flex flex-col sm:flex-row w-full max-w-5xl h-full max-h-[800px] overflow-hidden" onClick={e => e.stopPropagation()}>

                {/* Left Sidebar: List */}
                <div className="w-full sm:w-1/3 border-b sm:border-b-0 sm:border-r border-border flex flex-col bg-void-lighter max-h-[40vh] sm:max-h-none">
                    <div className="p-4 border-b border-border flex justify-between items-center bg-void">
                        <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                            <Users size={16} />
                            NPC Ledger
                        </div>
                        <button onClick={toggleNPCLedger} className="text-text-dim hover:text-text-primary p-1 sm:hidden">
                            <X size={18} />
                        </button>
                    </div>

                    <div className="p-4 border-b border-border flex flex-col gap-2">
                        <div className="relative w-full">
                            <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
                                <Search size={12} className="text-text-dim/50" />
                            </div>
                            <input
                                type="text"
                                placeholder="Search records..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full bg-void border border-border rounded pl-7 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-dim/50 focus:border-terminal outline-none transition-colors"
                            />
                        </div>
                        <button
                            onClick={handleCreateNew}
                            className={`w-full flex items-center justify-center gap-2 py-2 px-4 border border-dashed rounded text-xs uppercase tracking-wider transition-colors ${!selectedId && isEditing ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'
                                }`}
                        >
                            <Plus size={14} /> New Record
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-2 space-y-1">
                        {npcLedger.length === 0 && (
                            <p className="text-text-dim text-xs text-center p-4 italic opacity-50">No records found.</p>
                        )}
                        {npcLedger.length > 0 && filteredLedger.length === 0 && (
                            <p className="text-text-dim text-xs text-center p-4 italic opacity-50">No matches found.</p>
                        )}
                        {filteredLedger.map(npc => (
                            <div
                                key={npc.id}
                                onClick={() => handleSelect(npc)}
                                className={`flex items-center justify-between p-3 cursor-pointer border-l-2 transition-all ${selectedId === npc.id ? 'border-terminal bg-terminal/5' : 'border-transparent hover:bg-surface'
                                    }`}
                            >
                                <div className="flex items-center gap-2 truncate">
                                    <User size={14} className={selectedId === npc.id ? 'text-terminal' : 'text-text-dim'} />
                                    <div className="truncate">
                                        <p className={`text-sm font-bold truncate ${selectedId === npc.id ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>
                                            {npc.name}
                                        </p>
                                        {npc.aliases && <p className="text-[10px] text-text-dim truncate">{npc.aliases}</p>}
                                    </div>
                                </div>
                                <button
                                    onClick={(e) => handleDelete(npc.id, e)}
                                    className="p-1 text-text-dim hover:text-danger hover:bg-danger/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                                >
                                    <Trash2 size={12} className="pointer-events-none" />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Right Area: Form/Details */}
                <div className="flex-1 flex flex-col bg-surface overflow-hidden relative">
                    <button onClick={toggleNPCLedger} className="absolute top-4 right-4 text-text-dim hover:text-text-primary hidden sm:block p-1 bg-void rounded border border-transparent hover:border-border transition-all z-10">
                        <X size={18} />
                    </button>

                    {selectedId || isEditing ? (
                        <div className="flex-1 overflow-y-auto p-6 sm:p-8 flex flex-col">
                            <div className="flex justify-between items-start mb-6">
                                <div>
                                    <h2 className="text-xl font-bold text-text-primary tracking-wide uppercase">
                                        {isEditing && !selectedId ? 'New Subject Record' : selectedId && !isEditing ? form.name : `Editing: ${form.name}`}
                                    </h2>
                                    <p className="text-xs text-text-dim mt-1">Classified GM Information file.</p>
                                </div>
                                {!isEditing && (
                                    <button
                                        onClick={() => setIsEditing(true)}
                                        className="bg-void border border-border px-4 py-1.5 text-xs text-text-dim hover:text-terminal hover:border-terminal uppercase tracking-widest transition-colors"
                                    >
                                        Edit Record
                                    </button>
                                )}
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 flex-1">
                                {/* Details Column */}
                                <div className="space-y-4">
                                    {/* Image Section */}
                                    <div className="flex gap-4 p-3 bg-void border border-border/50 rounded">
                                        <div className="w-24 h-24 sm:w-32 sm:h-32 shrink-0 bg-surface border border-border flex items-center justify-center overflow-hidden relative group">
                                            {form.portrait ? (
                                                <img src={form.portrait} alt={form.name} className="w-full h-full object-cover" />
                                            ) : (
                                                <ImageIcon className="text-text-dim/30 w-8 h-8 sm:w-12 sm:h-12" />
                                            )}
                                            {isEditing && form.portrait && (
                                                <button
                                                    onClick={() => setForm({ ...form, portrait: '' })}
                                                    className="absolute top-1 right-1 p-1 bg-danger text-void rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                                >
                                                    <X size={12} />
                                                </button>
                                            )}
                                        </div>
                                        <div className="flex-1 flex flex-col justify-center space-y-2">
                                            <label className="text-text-dim text-[10px] uppercase tracking-wider block">AI Portrait Generation</label>
                                            <select
                                                value={imageStyle}
                                                onChange={(e) => setImageStyle(e.target.value)}
                                                className="w-full bg-void-lighter border border-border px-2 py-1.5 text-xs text-text-primary outline-none focus:border-terminal transition-colors"
                                            >
                                                {IMAGE_STYLES.map(style => (
                                                    <option key={style} value={style}>{style}</option>
                                                ))}
                                            </select>
                                            <button
                                                onClick={handleGenerateImage}
                                                disabled={isGeneratingImage || !form.appearance}
                                                className="w-full flex items-center justify-center gap-2 bg-void border border-terminal/40 text-terminal hover:border-terminal px-3 py-1.5 text-[11px] uppercase tracking-widest transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                                title={!form.appearance ? "Provide Visual Profiling text first" : "Generate Image"}
                                            >
                                                {isGeneratingImage ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
                                                {isGeneratingImage ? 'Generating...' : 'Generate Portrait'}
                                            </button>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Primary Designation</label>
                                        <input
                                            type="text"
                                            value={form.name || ''}
                                            onChange={e => setForm({ ...form, name: e.target.value })}
                                            disabled={!isEditing}
                                            placeholder="Subject Name"
                                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent"
                                        />
                                    </div>
                                    <div className="flex gap-4">
                                        <div className="flex-1">
                                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1 flex justify-between">
                                                <span>Known Aliases</span>
                                                <span className="text-text-dim/50 lowercase tracking-normal">comma separated</span>
                                            </label>
                                            <input
                                                type="text"
                                                value={form.aliases || ''}
                                                onChange={e => setForm({ ...form, aliases: e.target.value })}
                                                disabled={!isEditing}
                                                placeholder="The Blacksmith, Kael, Old Man"
                                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent"
                                            />
                                        </div>
                                        <div className="w-1/3">
                                            <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Status</label>
                                            <select
                                                value={form.status || 'Alive'}
                                                onChange={e => setForm({ ...form, status: e.target.value })}
                                                disabled={!isEditing}
                                                className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent outline-none focus:border-terminal transition-colors"
                                            >
                                                <option value="Alive">Alive</option>
                                                <option value="Deceased">Deceased</option>
                                                <option value="Missing">Missing</option>
                                                <option value="Unknown">Unknown</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Visual Profiling</label>
                                        <textarea
                                            value={form.appearance || ''}
                                            onChange={e => setForm({ ...form, appearance: e.target.value })}
                                            disabled={!isEditing}
                                            placeholder="Physical description, clothing, distinct marks..."
                                            rows={2}
                                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Default Disposition</label>
                                        <input
                                            type="text"
                                            value={form.disposition || ''}
                                            onChange={e => setForm({ ...form, disposition: e.target.value })}
                                            disabled={!isEditing}
                                            placeholder="Helpful, Suspicious, Hostile..."
                                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Core Motive / Goals</label>
                                        <textarea
                                            value={form.goals || ''}
                                            onChange={e => setForm({ ...form, goals: e.target.value })}
                                            disabled={!isEditing}
                                            placeholder="What does this character ultimately want?"
                                            rows={2}
                                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none"
                                        />
                                    </div>
                                    <div className="pt-2 border-t border-border/50">
                                        <div className="flex justify-between items-end mb-1">
                                            <label className="text-text-dim text-xs uppercase tracking-wider">Affinity</label>
                                            <span className={`text-xs ${(form.affinity ?? 50) < 30 ? 'text-danger' :
                                                (form.affinity ?? 50) > 70 ? 'text-terminal glow-green-sm' :
                                                    'text-ice'
                                                }`}>
                                                {form.affinity ?? 50} / 100 <span className="text-text-dim ml-1 text-[10px] hidden sm:inline">({
                                                    (form.affinity ?? 50) <= 9 ? 'Arch Nemesis' :
                                                        (form.affinity ?? 50) <= 19 ? 'Bitter Enemy' :
                                                            (form.affinity ?? 50) <= 29 ? 'Hostile' :
                                                                (form.affinity ?? 50) <= 39 ? 'Unfriendly' :
                                                                    (form.affinity ?? 50) <= 44 ? 'Skeptical' :
                                                                        (form.affinity ?? 50) <= 55 ? 'Neutral' :
                                                                            (form.affinity ?? 50) <= 60 ? 'Receptive' :
                                                                                (form.affinity ?? 50) <= 70 ? 'Friendly' :
                                                                                    (form.affinity ?? 50) <= 80 ? 'Trusted' :
                                                                                        (form.affinity ?? 50) <= 90 ? 'Ally' :
                                                                                            'Loyal Ally'
                                                })</span>
                                            </span>
                                        </div>
                                        <input
                                            type="range"
                                            min="0"
                                            max="100"
                                            value={form.affinity ?? 50}
                                            onChange={(e) => setForm({ ...form, affinity: parseInt(e.target.value, 10) })}
                                            disabled={!isEditing}
                                            className={`w-full ${(form.affinity ?? 50) < 30 ? 'accent-danger' :
                                                (form.affinity ?? 50) > 70 ? 'accent-terminal' :
                                                    'accent-ice'
                                                }`}
                                        />
                                    </div>
                                </div>

                                {/* Axes Column */}
                                <div className="bg-void p-4 rounded border border-border/50">
                                    <div className="flex items-center gap-2 text-ember font-bold uppercase tracking-widest text-xs mb-6 border-b border-border/50 pb-2">
                                        <div className="w-1.5 h-1.5 bg-ember rounded-full animate-pulse-slow"></div>
                                        Psychological Axes
                                    </div>
                                    {renderSlider('nature', 'Nature')}
                                    {renderSlider('training', 'Training')}
                                    {renderSlider('emotion', 'Emotion')}
                                    {renderSlider('social', 'Social')}
                                    {renderSlider('belief', 'Belief')}
                                    {renderSlider('ego', 'Ego')}
                                </div>
                            </div>

                            {/* Actions Bar */}
                            {isEditing && (
                                <div className="mt-8 pt-4 border-t border-border flex justify-between gap-3 shrink-0">
                                    {selectedId ? (
                                        <button
                                            onClick={(e) => handleDelete(selectedId, e)}
                                            className="px-4 py-2 text-xs uppercase tracking-widest text-danger hover:bg-danger/10 border border-danger/30 rounded transition-colors"
                                        >
                                            <div className="flex items-center gap-2">
                                                <Trash2 size={14} /> Delete Record
                                            </div>
                                        </button>
                                    ) : (
                                        <div /> /* Spacer */
                                    )}

                                    <div className="flex gap-3">
                                        {selectedId && (
                                            <button
                                                onClick={() => {
                                                    const npc = npcLedger.find(n => n.id === selectedId);
                                                    if (npc) setForm({ ...npc });
                                                    setIsEditing(false);
                                                }}
                                                className="px-4 py-2 text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void transition-colors"
                                            >
                                                Discard Change
                                            </button>
                                        )}
                                        <button
                                            onClick={handleSave}
                                            disabled={!form.name?.trim()}
                                            className="flex items-center gap-2 px-6 py-2 text-xs uppercase tracking-widest text-void bg-terminal font-bold hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                                        >
                                            <Save size={14} /> Commit Record
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-50">
                            <Users size={48} className="mb-4 text-text-dim/50" />
                            <p className="text-text-dim uppercase tracking-widest text-sm">No Record Selected</p>
                            <p className="text-text-dim/50 text-xs mt-2">Select a subject from the ledger or create a new entry.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
