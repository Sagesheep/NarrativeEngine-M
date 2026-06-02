import { useState, useMemo } from 'react';
import { Sword, Move, Shield, Crosshair, Send, LogOut } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { checkRangeLegality } from '../../services/engine/combatEngine';
import type { CombatAction } from '../../services/engine/combatEngine';
import type { ItemDef, SkillDef } from '../../types';
import { handleCombatAction, buildCombatNarrationPrompt, type CombatActionSource } from '../../services/turn/turnOrchestrator';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import { toast } from '../Toast';

type CombatHUDProps = {
    onActionCommitted?: () => void;
};

type ActionType = 'attack' | 'move' | 'defend';
type MoveSubtype = 'close' | 'retreat' | 'setup';

export function CombatHUD({ onActionCommitted }: CombatHUDProps) {
    const {
        combatState,
        setCombatState,
        terminateCombat,
        updateContext,
        addMessage,
        getActiveAuxiliaryEndpoint,
        getActiveStoryEndpoint,
        npcLedger,
        items,
        skills,
    } = useAppStore(useShallow(s => ({
        combatState: s.combatState,
        setCombatState: s.setCombatState,
        terminateCombat: s.terminateCombat,
        updateContext: s.updateContext,
        addMessage: s.addMessage,
        getActiveAuxiliaryEndpoint: s.getActiveAuxiliaryEndpoint,
        getActiveStoryEndpoint: s.getActiveStoryEndpoint,
        npcLedger: s.npcLedger,
        items: s.items,
        skills: s.skills,
    })));

    const [selectedAction, setSelectedAction] = useState<ActionType>('attack');
    const [moveSubtype, setMoveSubtype] = useState<MoveSubtype>('close');
    const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
    const [selectedSkillOrWeapon, setSelectedSkillOrWeapon] = useState<string | null>(null);
    const [selectedPosition, setSelectedPosition] = useState<'cover' | 'elevated' | undefined>(undefined);
    const [freeformText, setFreeformText] = useState('');
    const [isResolving, setIsResolving] = useState(false);

    const pcCombatant = useMemo(() => {
        if (!combatState) return null;
        return Object.values(combatState.combatants).find(c => c.isPC) ?? null;
    }, [combatState]);

    const enemies = useMemo(() => {
        if (!combatState) return [];
        return Object.values(combatState.combatants).filter(c => !c.isPC && c.currentHP > 0);
    }, [combatState]);

    const pcNpcEntry = useMemo(() => {
        if (!pcCombatant) return null;
        return npcLedger.find(n => n.id === pcCombatant.id) ?? null;
    }, [pcCombatant, npcLedger]);

    const availableWeapons = useMemo(() => {
        if (!pcNpcEntry) return items.slice(0, 3);
        const equippedId = pcNpcEntry.equippedWeapon;
        if (equippedId) {
            const equipped = items.find(i => i.id === equippedId);
            const rest = items.filter(i => i.id !== equippedId && (pcNpcEntry.inventory ?? []).includes(i.id));
            return equipped ? [equipped, ...rest] : rest;
        }
        return items.filter(i => (pcNpcEntry.inventory ?? []).includes(i.id));
    }, [pcNpcEntry, items]);

    const availableSkills = useMemo(() => {
        if (!pcNpcEntry) return skills.slice(0, 3);
        const knownIds = pcNpcEntry.knownSkills ?? [];
        return skills.filter(s => knownIds.includes(s.id));
    }, [pcNpcEntry, skills]);

    const selectedWeapon: ItemDef | null = useMemo(() => {
        if (selectedSkillOrWeapon) {
            const item = items.find(i => i.id === selectedSkillOrWeapon);
            if (item) return item;
        }
        if (pcNpcEntry?.equippedWeapon) {
            return items.find(i => i.id === pcNpcEntry.equippedWeapon) ?? null;
        }
        return availableWeapons[0] ?? null;
    }, [selectedSkillOrWeapon, pcNpcEntry, items, availableWeapons]);

    const selectedSkill: SkillDef | null = useMemo(() => {
        if (!selectedSkillOrWeapon) return null;
        return skills.find(s => s.id === selectedSkillOrWeapon) ?? null;
    }, [selectedSkillOrWeapon, skills]);

    const weaponRange = useMemo((): 'Close' | 'Reach' | 'Ranged' => {
        if (selectedSkill) return selectedSkill.range;
        if (selectedWeapon) return selectedWeapon.range;
        return 'Close';
    }, [selectedSkill, selectedWeapon]);

    const rangeRelation = useMemo((): 'Engaged' | 'Apart' => {
        if (!combatState || !selectedTargetId || !pcCombatant) return 'Apart';
        return combatState.rangeRelations[pcCombatant.id]?.[selectedTargetId] ?? 'Apart';
    }, [combatState, selectedTargetId, pcCombatant]);

    const isRangeLegal = useMemo(() => {
        if (selectedAction === 'move' || selectedAction === 'defend') return true;
        return checkRangeLegality({ weaponRange, rangeRelation, actionType: selectedAction }).legal;
    }, [weaponRange, rangeRelation, selectedAction]);

    const buildCombatAction = (): CombatAction => {
        if (!pcCombatant || !combatState) throw new Error('No PC combatant');

        if (selectedAction === 'attack') {
            const isSkillAttack = selectedSkill && selectedSkill.type === 'attack';
            return {
                type: isSkillAttack ? 'mental' : 'attack',
                actorId: pcCombatant.id,
                targetId: selectedTargetId ?? undefined,
                attackBonus: isSkillAttack ? undefined : (pcCombatant.stats.PWR >= pcCombatant.stats.SPD || weaponRange === 'Close'
                    ? (Math.floor((pcCombatant.stats.PWR - 10) / 2) + pcCombatant.proficiencyBonus)
                    : (Math.floor((pcCombatant.stats.SPD - 10) / 2) + pcCombatant.proficiencyBonus)),
                weaponDie: isSkillAttack ? (selectedSkill!.damageDice ?? 6) : (selectedWeapon?.damageDice ?? 6),
                scalingStatMod: isSkillAttack
                    ? Math.floor((pcCombatant.stats.WIL - 10) / 2)
                    : Math.floor((pcCombatant.stats.PWR - 10) / 2),
                weaponRange,
                attackerWIL: isSkillAttack ? pcCombatant.stats.WIL : undefined,
                attackerProficiency: isSkillAttack ? pcCombatant.proficiencyBonus : undefined,
                defenderWIL: isSkillAttack && selectedTargetId
                    ? combatState.combatants[selectedTargetId]?.stats.WIL : undefined,
            };
        }

        if (selectedAction === 'move') {
            return {
                type: 'move',
                actorId: pcCombatant.id,
                targetId: selectedTargetId ?? undefined,
                moveToTarget: moveSubtype === 'close',
                moveToAway: moveSubtype === 'retreat',
                newPosition: selectedPosition,
                weaponRange,
            };
        }

        return { type: 'defend', actorId: pcCombatant.id };
    };

    const handleCommit = async () => {
        if (!combatState || !pcCombatant || isResolving) return;
        setIsResolving(true);

        try {
            let source: CombatActionSource;
            if (freeformText.trim()) {
                const baseAction = buildCombatAction();
                source = { kind: 'freeform', freeformText: freeformText.trim(), baseAction };
            } else {
                if (selectedAction === 'attack' && !selectedTargetId) {
                    toast.warning('Select a target');
                    setIsResolving(false);
                    return;
                }
                if (!isRangeLegal) {
                    toast.warning('Out of range — move closer first');
                    setIsResolving(false);
                    return;
                }
                source = { kind: 'button', action: buildCombatAction() };
            }

            const auxProvider = getActiveAuxiliaryEndpoint?.();
            const storyProvider = getActiveStoryEndpoint();

            await handleCombatAction(source, combatState, {
                addMessage,
                updateContext,
                setCombatState,
                terminateCombat,
                getAuxiliaryProvider: () => auxProvider?.modelName ? auxProvider : undefined,
                getStoryProvider: () => storyProvider,
                narrateCombatOutcome: async (ledgerLine, resolutions, updatedState) => {
                    if (!storyProvider) return;
                    const prompt = buildCombatNarrationPrompt(ledgerLine, resolutions, updatedState, freeformText.trim() || undefined);
                    try {
                        const narration = await llmCall(storyProvider, prompt, {
                            temperature: 0.7,
                            priority: 'normal',
                            maxTokens: 400,
                        });
                        if (narration?.trim()) {
                            addMessage({
                                id: uid(),
                                role: 'assistant',
                                content: narration.trim(),
                                timestamp: Date.now(),
                            });
                        }
                    } catch (err) {
                        console.warn('[CombatHUD] Narration call failed:', err);
                    }
                },
            });

            setFreeformText('');
            onActionCommitted?.();
        } catch (err) {
            console.error('[CombatHUD] Action failed:', err);
            toast.error('Combat action failed');
        } finally {
            setIsResolving(false);
        }
    };

    if (!combatState || !pcCombatant) {
        return (
            <div className="px-3 py-4 text-center text-text-dim text-xs uppercase tracking-widest">
                No active combat
            </div>
        );
    }

    const hpPercent = pcCombatant.maxHP > 0 ? (pcCombatant.currentHP / pcCombatant.maxHP) * 100 : 0;
    const focPercent = pcCombatant.maxFOC > 0 ? (pcCombatant.currentFOC / pcCombatant.maxFOC) * 100 : 0;
    const hpColor = hpPercent > 50 ? 'bg-emerald-500' : hpPercent > 25 ? 'bg-amber-500' : 'bg-red-500';

    return (
        <div className="flex-shrink-0 bg-void border-t border-border px-2 md:px-4 pb-2 pt-1 space-y-2">
            {/* HP/FOC bars */}
            <div className="flex items-center gap-3">
                <div className="flex-1">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-widest mb-0.5">
                        <span className="text-emerald-400 font-bold">HP</span>
                        <span className="text-text-dim">{pcCombatant.currentHP}/{pcCombatant.maxHP}</span>
                    </div>
                    <div className="h-2 bg-void-lighter rounded-full overflow-hidden">
                        <div className={`h-full ${hpColor} transition-all duration-300 rounded-full`} style={{ width: `${Math.max(0, hpPercent)}%` }} />
                    </div>
                </div>
                <div className="flex-1">
                    <div className="flex items-center justify-between text-[10px] uppercase tracking-widest mb-0.5">
                        <span className="text-blue-400 font-bold">FOC</span>
                        <span className="text-text-dim">{pcCombatant.currentFOC}/{pcCombatant.maxFOC}</span>
                    </div>
                    <div className="h-2 bg-void-lighter rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 transition-all duration-300 rounded-full" style={{ width: `${Math.max(0, focPercent)}%` }} />
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[9px] text-text-dim uppercase tracking-widest">R{combatState.round}</span>
                    <button
                        onClick={() => {
                            terminateCombat({ writeBack: true });
                            toast.success('Combat ended');
                            onActionCommitted?.();
                        }}
                        title="End combat"
                        className="flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-widest font-bold rounded border border-red-500/40 text-red-400/80 hover:bg-red-500/10 hover:text-red-400 transition-all min-h-[32px]"
                    >
                        <LogOut size={11} /> End
                    </button>
                </div>
            </div>

            {/* Action buttons row */}
            <div className="flex gap-1">
                <button
                    onClick={() => setSelectedAction('attack')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-widest font-bold rounded transition-all min-h-[36px] ${
                        selectedAction === 'attack' ? 'bg-red-500/20 border border-red-500/50 text-red-400' : 'bg-void-lighter border border-border text-text-dim hover:text-red-400'
                    }`}
                >
                    <Sword size={12} /> ATK
                </button>
                <button
                    onClick={() => setSelectedAction('move')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-widest font-bold rounded transition-all min-h-[36px] ${
                        selectedAction === 'move' ? 'bg-blue-500/20 border border-blue-500/50 text-blue-400' : 'bg-void-lighter border border-border text-text-dim hover:text-blue-400'
                    }`}
                >
                    <Move size={12} /> MOV
                </button>
                <button
                    onClick={() => setSelectedAction('defend')}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] uppercase tracking-widest font-bold rounded transition-all min-h-[36px] ${
                        selectedAction === 'defend' ? 'bg-amber-500/20 border border-amber-500/50 text-amber-400' : 'bg-void-lighter border border-border text-text-dim hover:text-amber-400'
                    }`}
                >
                    <Shield size={12} /> DEF
                </button>
            </div>

            {/* Target selector + weapon/skill dropdown */}
            {selectedAction === 'attack' && (
                <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="text-[9px] text-text-dim uppercase tracking-widest block mb-0.5">Target</label>
                        <select
                            value={selectedTargetId ?? ''}
                            onChange={e => setSelectedTargetId(e.target.value || null)}
                            className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-xs font-mono text-text-primary focus:border-terminal outline-none min-h-[36px]"
                        >
                            <option value="">Select target...</option>
                            {enemies.map(e => (
                                <option key={e.id} value={e.id}>
                                    {e.name} HP:{e.currentHP}/{e.maxHP} {e.position ? `[${e.position}]` : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="flex-1">
                        <label className="text-[9px] text-text-dim uppercase tracking-widest block mb-0.5">
                            ATK <span className="text-terminal/60">&#9662;</span>
                        </label>
                        <select
                            value={selectedSkillOrWeapon ?? ''}
                            onChange={e => setSelectedSkillOrWeapon(e.target.value || null)}
                            className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-xs font-mono text-text-primary focus:border-terminal outline-none min-h-[36px]"
                        >
                            {availableWeapons.map(w => (
                                <option key={w.id} value={w.id}>{w.name} ({w.range})</option>
                            ))}
                            {availableSkills.map(s => (
                                <option key={s.id} value={s.id}>{s.name} ({s.range}, FOC:{s.focCost})</option>
                            ))}
                        </select>
                    </div>
                    {!isRangeLegal && selectedTargetId && (
                        <div className="text-[9px] text-red-400 uppercase tracking-widest self-end pb-1">
                            Out of range!
                        </div>
                    )}
                </div>
            )}

            {/* MOV options */}
            {selectedAction === 'move' && (
                <div className="flex gap-2">
                    <div className="flex gap-1 flex-1">
                        {([
                            { key: 'close' as MoveSubtype, label: 'Close' },
                            { key: 'retreat' as MoveSubtype, label: 'Retreat' },
                            { key: 'setup' as MoveSubtype, label: 'Setup' },
                        ]).map(opt => (
                            <button
                                key={opt.key}
                                onClick={() => setMoveSubtype(opt.key)}
                                className={`flex-1 px-2 py-1 text-[9px] uppercase tracking-widest font-bold rounded transition-all min-h-[32px] ${
                                    moveSubtype === opt.key ? 'bg-blue-500/20 border border-blue-500/50 text-blue-400' : 'bg-void-lighter border border-border text-text-dim'
                                }`}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-1">
                        {(['cover', 'elevated'] as const).map(pos => (
                            <button
                                key={pos}
                                onClick={() => setSelectedPosition(selectedPosition === pos ? undefined : pos)}
                                className={`px-2 py-1 text-[9px] uppercase tracking-widest font-bold rounded transition-all min-h-[32px] ${
                                    selectedPosition === pos ? 'bg-amber-500/20 border border-amber-500/50 text-amber-400' : 'bg-void-lighter border border-border text-text-dim'
                                }`}
                            >
                                {pos}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Freeform text box */}
            <div className="flex gap-1">
                <input
                    type="text"
                    value={freeformText}
                    onChange={e => setFreeformText(e.target.value)}
                    placeholder={selectedAction === 'move' && moveSubtype === 'setup'
                        ? 'Describe your setup maneuver...'
                        : '...or describe your action'}
                    className="flex-1 bg-surface border border-border px-2 py-1.5 text-[16px] md:text-xs font-mono text-text-primary placeholder:text-text-dim/40 focus:border-terminal outline-none min-h-[36px]"
                />
                <button
                    onClick={handleCommit}
                    disabled={isResolving || (selectedAction === 'attack' && !selectedTargetId && !freeformText.trim())}
                    className={`flex items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold rounded transition-all min-h-[36px] ${
                        isResolving
                            ? 'bg-void-lighter border border-border text-text-dim'
                            : 'bg-terminal/20 border border-terminal/50 text-terminal hover:bg-terminal/30'
                    } disabled:opacity-40`}
                >
                    {isResolving ? (
                        <span className="animate-pulse">Resolving...</span>
                    ) : (
                        <>
                            <Send size={12} />
                            <Crosshair size={12} /> COMMIT
                        </>
                    )}
                </button>
            </div>

            {/* Enemy HP summary row */}
            <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                {enemies.map(e => {
                    const eHpPct = e.maxHP > 0 ? (e.currentHP / e.maxHP) * 100 : 0;
                    const eHpColor = eHpPct > 50 ? 'bg-red-500' : eHpPct > 25 ? 'bg-amber-500' : 'bg-red-700';
                    return (
                        <div
                            key={e.id}
                            onClick={() => { setSelectedTargetId(e.id); setSelectedAction('attack'); }}
                            className={`shrink-0 px-2 py-1 rounded border cursor-pointer transition-all ${
                                selectedTargetId === e.id
                                    ? 'border-red-500/50 bg-red-500/10'
                                    : 'border-border bg-void-lighter hover:border-red-500/30'
                            }`}
                        >
                            <div className="text-[9px] text-text-dim uppercase tracking-widest truncate max-w-[80px]">{e.name}</div>
                            <div className="w-12 h-1 bg-void rounded-full overflow-hidden mt-0.5">
                                <div className={`h-full ${eHpColor} transition-all duration-300`} style={{ width: `${eHpPct}%` }} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}