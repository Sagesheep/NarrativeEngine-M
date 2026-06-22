import { useState } from 'react';
import type { CharacterProfileState, CharacterTrait, DivergenceCategory, SceneEventType } from '../../types';
import { uid } from '../../utils/uid';
import { Toggle } from './Toggle';
import { Trash2, Plus, AlertCircle } from 'lucide-react';

const CATEGORIES: DivergenceCategory[] = [
    'locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc',
];

const EVENT_TAGS: SceneEventType[] = [
    'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
    'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
];

const CATEGORY_LABELS: Record<DivergenceCategory, string> = {
    locations: 'Location',
    npc_events: 'NPC Event',
    promises_debts: 'Promise/Debt',
    world_state: 'World State',
    party_facts: 'Party Fact',
    rules_lore: 'Rules/Lore',
    misc: 'Misc',
};

export function CharacterProfileEditor({ profile, onChange, active, onToggle }: {
    profile: CharacterProfileState;
    onChange: (next: CharacterProfileState) => void;
    active: boolean;
    onToggle: () => void;
}) {
    const activeTraits = profile.activeTraits.filter(t => !t.superseded);
    const supersededTraits = profile.activeTraits.filter(t => t.superseded);
    const [showSuperseded, setShowSuperseded] = useState(false);

    const updateTrait = (id: string, patch: Partial<CharacterTrait>) => {
        onChange({
            ...profile,
            activeTraits: profile.activeTraits.map(t => t.id === id ? { ...t, ...patch } : t),
        });
    };

    const addTrait = () => {
        const newTrait: CharacterTrait = {
            id: uid(),
            subject: profile.identity.name || 'PC',
            category: 'party_facts',
            text: '',
            importance: 5,
            eventTags: [],
            sceneEstablished: 'manual',
            superseded: false,
            source: 'manual',
        };
        onChange({ ...profile, activeTraits: [...profile.activeTraits, newTrait] });
    };

    const removeTrait = (id: string) => {
        onChange({ ...profile, activeTraits: profile.activeTraits.filter(t => t.id !== id) });
    };

    const supersedeTrait = (id: string) => {
        updateTrait(id, { superseded: true });
    };

    const updateIdentity = (patch: Partial<CharacterProfileState['identity']>) => {
        onChange({ ...profile, identity: { ...profile.identity, ...patch } });
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ember">
                    <span>Character Profile</span>
                </label>
                <Toggle active={active} onChange={onToggle} />
            </div>

            <div className={`space-y-3 border px-3 py-3 bg-void transition-opacity min-h-[100px] ${active ? 'border-border' : 'border-border/40 opacity-50'}`}>
                {/* Identity section — always injected (Tier 1 core) */}
                <div className="space-y-1.5">
                    <p className="text-[9px] uppercase tracking-widest text-text-dim/70">Identity (always sent)</p>
                    <div className="grid grid-cols-2 gap-2">
                        <input
                            type="text"
                            value={profile.identity.name || ''}
                            onChange={(e) => updateIdentity({ name: e.target.value })}
                            placeholder="Name"
                            className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright"
                        />
                        <input
                            type="text"
                            value={profile.identity.race || ''}
                            onChange={(e) => updateIdentity({ race: e.target.value })}
                            placeholder="Race"
                            className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright"
                        />
                        <input
                            type="text"
                            value={profile.identity.class || ''}
                            onChange={(e) => updateIdentity({ class: e.target.value })}
                            placeholder="Class"
                            className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright"
                        />
                        <input
                            type="number"
                            value={profile.identity.level ?? ''}
                            onChange={(e) => updateIdentity({ level: e.target.value ? Number(e.target.value) : undefined })}
                            placeholder="Level"
                            className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright"
                        />
                    </div>
                </div>

                {/* Active traits */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <p className="text-[9px] uppercase tracking-widest text-text-dim/70">
                            Active Traits ({activeTraits.length}/10)
                        </p>
                        <button
                            onClick={addTrait}
                            disabled={activeTraits.length >= 10}
                            className="flex items-center gap-1 text-[10px] text-terminal/70 hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            <Plus size={12} /> Add
                        </button>
                    </div>

                    {activeTraits.length === 0 && (
                        <p className="text-[10px] text-text-dim/40 italic px-1">
                            No active traits. The profile parser will add traits as the story progresses, or add one manually.
                        </p>
                    )}

                    {activeTraits.map(trait => (
                        <TraitRow
                            key={trait.id}
                            trait={trait}
                            onChange={(patch) => updateTrait(trait.id, patch)}
                            onSupersede={() => supersedeTrait(trait.id)}
                            onRemove={() => removeTrait(trait.id)}
                        />
                    ))}
                </div>

                {/* Superseded traits (collapsed) */}
                {supersededTraits.length > 0 && (
                    <div>
                        <button
                            onClick={() => setShowSuperseded(!showSuperseded)}
                            className="text-[9px] text-text-dim/50 hover:text-text-dim"
                        >
                            {showSuperseded ? '▾' : '▸'} {supersededTraits.length} superseded (historical)
                        </button>
                        {showSuperseded && (
                            <div className="space-y-1 mt-1">
                                {supersededTraits.map(trait => (
                                    <div key={trait.id} className="flex items-center gap-2 px-2 py-1 opacity-40">
                                        <AlertCircle size={10} className="text-text-dim shrink-0" />
                                        <span className="text-[10px] text-text-dim line-through flex-1 truncate">{trait.text}</span>
                                        <button
                                            onClick={() => removeTrait(trait.id)}
                                            className="text-text-dim/40 hover:text-red-400"
                                        >
                                            <Trash2 size={10} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Legacy notes (frozen, read-only) */}
                {profile.legacyNotes && (
                    <div>
                        <p className="text-[9px] text-text-dim/50">
                            Legacy profile preserved from upgrade (not injected): {profile.legacyNotes.length.toLocaleString()} chars
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

function TraitRow({ trait, onChange, onSupersede, onRemove }: {
    trait: CharacterTrait;
    onChange: (patch: Partial<CharacterTrait>) => void;
    onSupersede: () => void;
    onRemove: () => void;
}) {
    const toggleTag = (tag: SceneEventType) => {
        const has = trait.eventTags.includes(tag);
        onChange({
            eventTags: has
                ? trait.eventTags.filter(t => t !== tag)
                : [...trait.eventTags, tag],
        });
    };

    return (
        <div className="space-y-1 bg-void-dark/40 border border-border/40 rounded px-2 py-1.5">
            <div className="flex items-start gap-2">
                <textarea
                    value={trait.text}
                    onChange={(e) => onChange({ text: e.target.value })}
                    rows={1}
                    placeholder="Trait text..."
                    className="flex-1 bg-void-dark border border-border/40 rounded px-2 py-1 text-[11px] text-text-bright resize-none min-h-[28px]"
                />
                <input
                    type="number"
                    min={1}
                    max={10}
                    value={trait.importance}
                    onChange={(e) => onChange({ importance: Math.max(1, Math.min(10, Number(e.target.value) || 5)) })}
                    className="w-10 bg-void-dark border border-border/40 rounded px-1 py-1 text-[10px] text-text-bright text-center"
                    title="Importance (1-10)"
                />
                <button onClick={onSupersede} className="text-text-dim/50 hover:text-ember" title="Mark superseded">
                    <AlertCircle size={11} />
                </button>
                <button onClick={onRemove} className="text-text-dim/50 hover:text-red-400" title="Delete">
                    <Trash2 size={11} />
                </button>
            </div>
            <div className="flex flex-wrap gap-1 items-center">
                <select
                    value={trait.category}
                    onChange={(e) => onChange({ category: e.target.value as DivergenceCategory })}
                    className="bg-void-dark border border-border/40 rounded px-1.5 py-0.5 text-[9px] text-text-dim uppercase tracking-wider"
                >
                    {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </select>
                {EVENT_TAGS.map(tag => {
                    const active = trait.eventTags.includes(tag);
                    return (
                        <button
                            key={tag}
                            onClick={() => toggleTag(tag)}
                            className={`px-1.5 py-0.5 rounded text-[8px] uppercase tracking-wider transition-colors ${
                                active ? 'bg-terminal/20 text-terminal border border-terminal/40' : 'bg-void-dark/50 text-text-dim/40 border border-border/20 hover:text-text-dim'
                            }`}
                        >
                            {tag}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}