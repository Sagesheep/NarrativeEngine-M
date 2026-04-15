import { Trash2, Save, Loader2, Sparkles, Users } from 'lucide-react';
import type { NPCEntry } from '../../types';

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
    return list[Math.max(0, Math.min(9, value - 1))];
}

type Props = {
    form: Partial<NPCEntry>;
    setForm: React.Dispatch<React.SetStateAction<Partial<NPCEntry>>>;
    selectedId: string | null;
    isEditing: boolean;
    isAIUpdating: boolean;
    onEdit: () => void;
    onSave: () => void;
    onCancel: () => void;
    onDelete: (id: string, e: React.MouseEvent) => void;
    onAIUpdate: () => void;
};

export function NPCEditForm({
    form, setForm, selectedId, isEditing, isAIUpdating,
    onEdit, onSave, onCancel, onDelete, onAIUpdate,
}: Props) {
    const renderSlider = (label: keyof NPCEntry, displayLabel: string) => {
        const value = form[label] as number ?? 5;
        return (
            <div className="mb-4">
                <div className="flex justify-between items-end mb-1">
                    <label className="text-text-dim text-xs uppercase tracking-wider">{displayLabel}</label>
                    <span className="text-xs text-terminal">{value} / 10 <span className="text-text-dim ml-1 text-[10px] hidden sm:inline">({getAxisLabel(displayLabel, value)})</span></span>
                </div>
                <input
                    type="range" min="1" max="10" value={value}
                    onChange={(e) => setForm({ ...form, [label]: parseInt(e.target.value, 10) })}
                    disabled={!isEditing}
                    className="w-full accent-terminal h-8 md:h-4 cursor-pointer"
                />
            </div>
        );
    };

    if (!selectedId && !isEditing) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 opacity-50 bg-void">
                <Users size={64} className="mb-6 text-text-dim/30 drop-shadow-lg" />
                <p className="text-text-dim uppercase tracking-widest text-sm font-bold">No Record Selected</p>
                <p className="text-text-dim/60 text-xs mt-2 max-w-xs">Select a subject from the ledger to view their classified file, or create a new entry.</p>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-y-auto flex flex-col p-6 sm:p-8">
            {/* Title row */}
            <div className="flex justify-between items-start mb-5">
                <div>
                    <h2 className="text-xl font-bold text-text-primary tracking-wide uppercase">
                        {isEditing && !selectedId ? 'New Subject Record' : selectedId && !isEditing ? form.name : `Editing: ${form.name}`}
                    </h2>
                    <p className="text-xs text-text-dim mt-1">Classified GM Information file.</p>
                </div>
                {!isEditing && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onAIUpdate}
                            disabled={isAIUpdating || !selectedId}
                            title="Ask AI to update this NPC based on recent chat history"
                            className="flex items-center gap-2 bg-void border border-terminal/30 px-4 md:px-3 py-2.5 md:py-1.5 text-sm md:text-xs text-terminal hover:border-terminal uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px] md:min-h-0"
                        >
                            {isAIUpdating ? <Loader2 size={14} className="animate-spin md:w-[12px] md:h-[12px]" /> : <Sparkles size={14} className="md:w-[12px] md:h-[12px]" />}
                            AI Update
                        </button>
                        <button
                            onClick={onEdit}
                            className="bg-void border border-border px-5 md:px-4 py-2.5 md:py-1.5 text-sm md:text-xs text-text-dim hover:text-terminal hover:border-terminal uppercase tracking-widest transition-colors min-h-[44px] md:min-h-0"
                        >
                            Edit Record
                        </button>
                    </div>
                )}
            </div>

            {/* Form grid */}
            <div className="space-y-4 flex-1">
                <div className="flex gap-4">
                    <div className="flex-1">
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Primary Designation</label>
                        <input
                            type="text"
                            value={form.name || ''}
                            onChange={e => setForm({ ...form, name: e.target.value })}
                            disabled={!isEditing}
                            placeholder="Subject Name"
                            className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal min-h-[48px] md:min-h-0"
                        />
                    </div>
                    <div className="w-1/3">
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Status</label>
                        <select
                            value={form.status || 'Alive'}
                            onChange={e => setForm({ ...form, status: e.target.value })}
                            disabled={!isEditing}
                            className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent outline-none focus:border-terminal transition-colors min-h-[48px] md:min-h-0"
                        >
                            <option value="Alive">Alive</option>
                            <option value="Deceased">Deceased</option>
                            <option value="Missing">Missing</option>
                            <option value="Unknown">Unknown</option>
                            <option value="In Custody">In Custody</option>
                        </select>
                    </div>
                </div>

                <div className="flex gap-4">
                    <div className="flex-1">
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Faction / Organization</label>
                        <input
                            type="text"
                            value={form.faction || ''}
                            onChange={e => setForm({ ...form, faction: e.target.value })}
                            disabled={!isEditing}
                            placeholder="e.g. Ironspire Knights"
                            className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal min-h-[48px] md:min-h-0"
                        />
                    </div>
                    <div className="flex-1">
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Known Aliases</label>
                        <input
                            type="text"
                            value={form.aliases || ''}
                            onChange={e => setForm({ ...form, aliases: e.target.value })}
                            disabled={!isEditing}
                            placeholder="Comma separated"
                            className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal min-h-[48px] md:min-h-0"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-terminal text-[10px] uppercase tracking-wider font-bold mb-1">Story Relevance</label>
                    <textarea
                        value={form.storyRelevance || ''}
                        onChange={e => setForm({ ...form, storyRelevance: e.target.value })}
                        disabled={!isEditing}
                        placeholder="Why does this NPC matter to the narrative?"
                        rows={2}
                        className="w-full bg-terminal/5 border border-terminal/30 rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal min-h-[80px] md:min-h-0"
                    />
                </div>

                <div>
                    <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Appearance</label>
                    <textarea
                        value={form.appearance || ''}
                        onChange={e => setForm({ ...form, appearance: e.target.value })}
                        disabled={!isEditing}
                        placeholder="Physical description, distinguishing features..."
                        rows={3}
                        className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal min-h-[80px] md:min-h-0"
                    />
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Default Disposition</label>
                        <input
                            type="text"
                            value={form.disposition || ''}
                            onChange={e => setForm({ ...form, disposition: e.target.value })}
                            disabled={!isEditing}
                            placeholder="Helpful, Suspicious..."
                            className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal min-h-[48px] md:min-h-0"
                        />
                    </div>
                    <div>
                        <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Affinity (0-100)</label>
                        <input
                            type="number"
                            min={0}
                            max={100}
                            value={form.affinity ?? 50}
                            onChange={e => setForm({ ...form, affinity: parseInt(e.target.value, 10) || 50 })}
                            disabled={!isEditing}
                            className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary disabled:opacity-70 disabled:bg-surface disabled:border-transparent focus:outline-none focus:border-terminal min-h-[48px] md:min-h-0"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-text-dim text-[10px] uppercase tracking-wider mb-1">Core Motive / Goals</label>
                    <textarea
                        value={form.goals || ''}
                        onChange={e => setForm({ ...form, goals: e.target.value })}
                        disabled={!isEditing}
                        placeholder="What does this character ultimately want?"
                        rows={2}
                        className="w-full bg-void border border-border rounded px-3 py-2.5 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 disabled:opacity-70 disabled:bg-surface disabled:border-transparent resize-none focus:outline-none focus:border-terminal min-h-[80px] md:min-h-0"
                    />
                </div>

                <div className="bg-void p-4 rounded border border-border">
                    <div className="flex items-center gap-2 text-text-primary font-bold uppercase tracking-widest text-xs mb-4">
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
                            onClick={(e) => onDelete(selectedId, e)}
                            className="px-6 py-3 md:px-4 md:py-2 text-sm md:text-xs uppercase tracking-widest text-danger hover:bg-danger/10 border border-danger/30 rounded transition-colors min-h-[48px] md:min-h-0"
                        >
                            <div className="flex items-center gap-2">
                                <Trash2 size={16} className="md:w-[14px] md:h-[14px]" /> Delete Record
                            </div>
                        </button>
                    ) : (
                        <div />
                    )}

                    <div className="flex gap-3">
                        {selectedId && (
                            <button
                                onClick={onCancel}
                                className="px-6 py-3 md:px-4 md:py-2 text-sm md:text-xs uppercase tracking-widest text-text-dim hover:text-text-primary border border-border bg-void transition-colors min-h-[48px] md:min-h-0"
                            >
                                Discard Change
                            </button>
                        )}
                        <button
                            onClick={onSave}
                            disabled={!form.name?.trim()}
                            className="flex items-center gap-3 px-8 md:px-6 py-3 md:py-2 text-sm md:text-xs uppercase tracking-widest text-void bg-terminal font-bold hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all min-h-[48px] md:min-h-0"
                        >
                            <Save size={18} className="md:w-[14px] md:h-[14px]" /> Commit Record
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
