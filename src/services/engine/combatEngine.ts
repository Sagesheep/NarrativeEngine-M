import type { CombatTier, Archetype, RecoveryBand, StatBlock, Combatant, CombatState } from '../../types';
export type { CombatTier, Archetype, RecoveryBand, StatBlock, Combatant, CombatState };

export type PositionTag = 'cover' | 'elevated' | 'exposed';
export type RangeRelation = 'Engaged' | 'Apart';

export type AttackResult = {
    hit: boolean;
    critical: boolean;
    naturalRoll: number;
    total: number;
    damage: number;
};

export type MentalSaveResult = {
    saved: boolean;
    naturalRoll: number;
    total: number;
    dc: number;
};

export type InitiativeResult = {
    combatantId: string;
    roll: number;
    modifier: number;
    total: number;
};

export type RiskOnFail = 'none' | 'prone' | 'exposed' | 'drop_weapon' | 'self_stagger';

export type CombatAction = {
    type: 'attack' | 'mental' | 'move' | 'defend';
    actorId: string;
    targetId?: string;
    attackBonus?: number;
    weaponDie?: number;
    scalingStatMod?: number;
    attackerWIL?: number;
    attackerProficiency?: number;
    defenderWIL?: number;
    advantage?: boolean;
    disadvantage?: boolean;
    weaponRange?: 'Close' | 'Reach' | 'Ranged';
    newPosition?: PositionTag;
    moveToTarget?: boolean;
    moveToAway?: boolean;
    forceRoll?: number;
    riskOnFail?: RiskOnFail;
};

export type ActionResolution = {
    actorId: string;
    targetId?: string;
    type: 'attack' | 'mental' | 'move' | 'defend';
    hit?: boolean;
    critical?: boolean;
    damage?: number;
    saved?: boolean;
    naturalRoll?: number;
    total?: number;
    rejected?: boolean;
    rejectionReason?: string;
    coverApplied?: boolean;
    focRecovered?: number;
    newPosition?: PositionTag;
    newRangeRelation?: RangeRelation;
    riskApplied?: RiskOnFail;
};

export type RangeLegalityResult = {
    legal: boolean;
    reason?: string;
};

export type CoverModifier = {
    advantage: boolean;
    disadvantage: boolean;
};

export type DefendBraceResult = {
    focRecovered: number;
    newFOC: number;
};

export type TerminationResult = {
    ended: boolean;
    winner?: string;
    reason?: string;
};

export type RoundResult = {
    resolutions: ActionResolution[];
    updatedCombatants: Record<string, Combatant>;
    updatedRangeRelations: Record<string, Record<string, RangeRelation>>;
    ledgerLine: string;
};

export const COMBAT_TIER_LEVEL_BANDS: Record<CombatTier, number> = {
    minion: 1,
    grunt: 3,
    elite: 6,
    boss: 10,
    legendary: 15,
};

export const FOC_SPELL_COSTS: Record<number, number> = {
    1: 2,
    2: 3,
    3: 5,
    4: 6,
    5: 7,
    6: 9,
    7: 10,
    8: 11,
    9: 13,
};

const HP_BASE = 6;
const HP_K = 4;

const PROFICIENCY_BY_LEVEL: [number, number][] = [
    [4, 2],
    [8, 3],
    [12, 4],
    [16, 5],
    [Infinity, 6],
];

export function proficiencyBonusForTier(tier: CombatTier): number {
    const level = COMBAT_TIER_LEVEL_BANDS[tier];
    for (const [threshold, bonus] of PROFICIENCY_BY_LEVEL) {
        if (level <= threshold) return bonus;
    }
    return 6;
}

export function abilityMod(score: number): number {
    return Math.floor((score - 10) / 2);
}

export function computeAC(resScore: number, armorBonus: number): number {
    return 10 + abilityMod(resScore) + armorBonus;
}

export function computeMaxHP(tier: CombatTier, vitScore: number): number {
    const level = COMBAT_TIER_LEVEL_BANDS[tier];
    const vitMod = abilityMod(vitScore);
    return HP_BASE + vitMod * HP_K + level * 2;
}

export function computeMaxFOC(tier: CombatTier, wilScore: number): number {
    const level = COMBAT_TIER_LEVEL_BANDS[tier];
    const wilMod = abilityMod(wilScore);
    return 2 + wilMod + 2 * level;
}

export function recoveryBandToMaxHPPercent(band: RecoveryBand): number {
    switch (band) {
        case 'healthy': return 100;
        case 'wounded': return 50;
        case 'critical': return 25;
    }
}

function rollD20(): number {
    return Math.floor(Math.random() * 20) + 1;
}

function rollDie(sides: number): number {
    return Math.floor(Math.random() * sides) + 1;
}

export type ResolveAttackInput = {
    attackBonus: number;
    ac: number;
    weaponDie: number;
    scalingStatMod: number;
    advantage?: boolean;
    disadvantage?: boolean;
    forceRoll?: number;
};

export function resolveAttack(input: ResolveAttackInput): AttackResult {
    const { attackBonus, ac, weaponDie, scalingStatMod, forceRoll } = input;
    const advantage = !!input.advantage;
    const disadvantage = !!input.disadvantage;

    let roll: number;
    if (forceRoll !== undefined) {
        roll = forceRoll;
    } else if (advantage && !disadvantage) {
        const r1 = rollD20();
        const r2 = rollD20();
        roll = Math.max(r1, r2);
    } else if (disadvantage && !advantage) {
        const r1 = rollD20();
        const r2 = rollD20();
        roll = Math.min(r1, r2);
    } else {
        roll = rollD20();
    }

    const total = roll + attackBonus;

    if (roll === 1) {
        return { hit: false, critical: false, naturalRoll: roll, total, damage: 0 };
    }

    if (roll === 20) {
        const weaponDamage = rollDie(weaponDie) + rollDie(weaponDie);
        return { hit: true, critical: true, naturalRoll: roll, total, damage: weaponDamage + scalingStatMod };
    }

    const hit = total >= ac;
    let damage = 0;
    if (hit) {
        damage = rollDie(weaponDie) + scalingStatMod;
    }

    return { hit, critical: false, naturalRoll: roll, total, damage };
}

export type ResolveMentalSaveInput = {
    attackerWIL: number;
    attackerProficiency: number;
    defenderWIL: number;
    advantage?: boolean;
    disadvantage?: boolean;
    forceRoll?: number;
};

export function resolveMentalSave(input: ResolveMentalSaveInput): MentalSaveResult {
    const { attackerWIL, attackerProficiency, defenderWIL, forceRoll } = input;
    const advantage = !!input.advantage;
    const disadvantage = !!input.disadvantage;

    const dc = 8 + abilityMod(attackerWIL) + attackerProficiency;

    let roll: number;
    if (forceRoll !== undefined) {
        roll = forceRoll;
    } else if (advantage && !disadvantage) {
        roll = Math.max(rollD20(), rollD20());
    } else if (disadvantage && !advantage) {
        roll = Math.min(rollD20(), rollD20());
    } else {
        roll = rollD20();
    }

    const defenderMod = abilityMod(defenderWIL);
    const total = roll + defenderMod;

    if (roll === 1) {
        return { saved: false, naturalRoll: roll, total, dc };
    }
    if (roll === 20) {
        return { saved: true, naturalRoll: roll, total, dc };
    }

    return { saved: total >= dc, naturalRoll: roll, total, dc };
}

export function rollInitiative(combatantId: string, spdScore: number): InitiativeResult {
    const mod = abilityMod(spdScore);
    const roll = rollD20();
    return {
        combatantId,
        roll,
        modifier: mod,
        total: roll + mod,
    };
}

export const ARCHETYPE_BUDGETS: Record<Archetype, StatBlock> = {
    bulwark:   { VIT: 16, PWR: 10, RES: 16, FOC:  8, SPD:  8, WIL: 10 },
    assassin:  { VIT: 10, PWR: 14, RES: 10, FOC: 10, SPD: 16, WIL: 12 },
    caster:    { VIT:  8, PWR:  8, RES: 10, FOC: 16, SPD: 10, WIL: 18 },
    skirmisher:{ VIT: 12, PWR: 12, RES: 10, FOC: 10, SPD: 14, WIL: 12 },
    brute:     { VIT: 14, PWR: 18, RES: 12, FOC:  8, SPD:  8, WIL:  8 },
};

export type BehaviorEntry = {
    action: string;
    weight: number;
};

export const ARCHETYPE_BEHAVIORS: Record<Archetype, BehaviorEntry[]> = {
    bulwark: [
        { action: 'guard',        weight: 0.40 },
        { action: 'defend_attack', weight: 0.25 },
        { action: 'reposition',    weight: 0.10 },
        { action: 'attack',        weight: 0.25 },
    ],
    assassin: [
        { action: 'attack',        weight: 0.45 },
        { action: 'reposition',    weight: 0.30 },
        { action: 'setup',         weight: 0.15 },
        { action: 'defend',        weight: 0.10 },
    ],
    caster: [
        { action: 'cast',          weight: 0.50 },
        { action: 'reposition',    weight: 0.25 },
        { action: 'defend',        weight: 0.15 },
        { action: 'setup',         weight: 0.10 },
    ],
    skirmisher: [
        { action: 'attack',        weight: 0.35 },
        { action: 'reposition',    weight: 0.30 },
        { action: 'setup',         weight: 0.20 },
        { action: 'defend',        weight: 0.15 },
    ],
    brute: [
        { action: 'attack',        weight: 0.55 },
        { action: 'guard',         weight: 0.20 },
        { action: 'defend_attack', weight: 0.15 },
        { action: 'reposition',    weight: 0.10 },
    ],
};

export type MaterializeInput = {
    combatTier: CombatTier;
    archetype: Archetype;
    id?: string;
    name?: string;
    armorBonus?: number;
};

function jitter(value: number): number {
    const factor = 0.9 + Math.random() * 0.2;
    return Math.round(value * factor);
}

export function materializeCombatant(input: MaterializeInput): Combatant {
    const { combatTier, archetype, armorBonus = 0 } = input;
    const budget = ARCHETYPE_BUDGETS[archetype];

    const stats: StatBlock = {
        VIT: jitter(budget.VIT),
        PWR: jitter(budget.PWR),
        RES: jitter(budget.RES),
        FOC: jitter(budget.FOC),
        SPD: jitter(budget.SPD),
        WIL: jitter(budget.WIL),
    };

    const maxHP = computeMaxHP(combatTier, stats.VIT);
    const maxFOC = computeMaxFOC(combatTier, stats.WIL);
    const ac = computeAC(stats.RES, armorBonus);
    const prof = proficiencyBonusForTier(combatTier);

    return {
        id: input.id ?? `${archetype}_${combatTier}_${Date.now()}`,
        name: input.name ?? `${archetype} ${combatTier}`,
        stats,
        currentHP: maxHP,
        maxHP,
        currentFOC: maxFOC,
        maxFOC,
        combatTier,
        archetype,
        ac,
        proficiencyBonus: prof,
    };
}

export function resolveActionQueue(
    actions: CombatAction[],
    combatants: Record<string, Combatant>,
): ActionResolution[] {
    return actions.map(action => {
        const actor = combatants[action.actorId];

        if (action.type === 'attack') {
            const target = combatants[action.targetId!];
            const attackBonus = action.attackBonus
                ?? (abilityMod(actor.stats.PWR) + actor.proficiencyBonus);
            const scalingStatMod = action.scalingStatMod ?? abilityMod(actor.stats.PWR);
            const weaponDie = action.weaponDie ?? 6;

            const result = resolveAttack({
                attackBonus,
                ac: target.ac,
                weaponDie,
                scalingStatMod,
                advantage: action.advantage,
                disadvantage: action.disadvantage,
            });

            return {
                actorId: action.actorId,
                targetId: action.targetId,
                type: 'attack' as const,
                hit: result.hit,
                critical: result.critical,
                damage: result.damage,
                naturalRoll: result.naturalRoll,
                total: result.total,
            };
        }

        if (action.type === 'mental') {
            const attackerWIL = action.attackerWIL ?? actor.stats.WIL;
            const attackerProficiency = action.attackerProficiency ?? actor.proficiencyBonus;
            const target = combatants[action.targetId!];
            const defenderWIL = action.defenderWIL ?? target.stats.WIL;

            const result = resolveMentalSave({
                attackerWIL,
                attackerProficiency,
                defenderWIL,
                advantage: action.advantage,
                disadvantage: action.disadvantage,
            });

            return {
                actorId: action.actorId,
                targetId: action.targetId,
                type: 'mental' as const,
                saved: result.saved,
                naturalRoll: result.naturalRoll,
                total: result.total,
            };
        }

        if (action.type === 'defend') {
            return {
                actorId: action.actorId,
                type: 'defend' as const,
            };
        }

        if (action.type === 'move') {
            return {
                actorId: action.actorId,
                type: 'move' as const,
            };
        }

        return {
            actorId: action.actorId,
            type: action.type,
        };
    });
}

export function checkRangeLegality(input: {
    weaponRange: 'Close' | 'Reach' | 'Ranged';
    rangeRelation: RangeRelation;
    actionType?: 'attack' | 'mental' | 'move' | 'defend';
}): RangeLegalityResult {
    if (input.actionType === 'move' || input.actionType === 'defend') {
        return { legal: true };
    }
    const { weaponRange, rangeRelation } = input;
    if (rangeRelation === 'Engaged') {
        return { legal: true };
    }
    if (weaponRange === 'Ranged') {
        return { legal: true };
    }
    return {
        legal: false,
        reason: `${weaponRange} weapon cannot be used at ${rangeRelation} range`,
    };
}

export function applyCoverModifier(
    targetPosition: PositionTag | undefined,
    weaponRange: 'Close' | 'Reach' | 'Ranged',
    attackerPosition?: PositionTag,
): CoverModifier {
    let advantage = false;
    let disadvantage = false;

    if (targetPosition === 'cover' && weaponRange === 'Ranged') {
        disadvantage = true;
    }
    if (targetPosition === 'cover' && weaponRange !== 'Ranged') {
        // melee ignores cover — no change
    }
    if (targetPosition === 'exposed') {
        advantage = true;
    }
    if (attackerPosition === 'elevated') {
        advantage = true;
    }

    return { advantage, disadvantage };
}

export function resolveDefendBrace(combatant: Combatant): DefendBraceResult {
    const wilMod = abilityMod(combatant.stats.WIL);
    const recovery = Math.max(1, 2 + wilMod);
    const newFOC = Math.min(combatant.maxFOC, combatant.currentFOC + recovery);
    return {
        focRecovered: newFOC - combatant.currentFOC,
        newFOC,
    };
}

export function checkTermination(state: CombatState): TerminationResult {
    const allCombatants = Object.entries(state.combatants);

    const totalPCs = allCombatants.filter(([, c]) => c.isPC).length;
    const totalNPCs = allCombatants.filter(([, c]) => !c.isPC).length;

    const livingPCs = allCombatants.filter(([, c]) => c.isPC && c.currentHP > 0).map(([id]) => id);
    const livingNPCs = allCombatants.filter(([, c]) => !c.isPC && c.currentHP > 0).map(([id]) => id);
    const allLiving = [...livingPCs, ...livingNPCs];

    if (allLiving.length === 0) {
        return { ended: true, winner: undefined, reason: 'all_fallen' };
    }
    if (totalPCs > 0 && livingPCs.length === 0) {
        return { ended: true, winner: livingNPCs[0], reason: 'pc_defeated' };
    }
    if (totalNPCs > 0 && livingNPCs.length === 0) {
        return { ended: true, winner: livingPCs[0], reason: 'enemy_defeated' };
    }
    return { ended: false };
}

export function runCombatRound(
    state: CombatState,
    actions: CombatAction[],
): RoundResult {
    const combatants: Record<string, Combatant> = {};
    for (const [id, c] of Object.entries(state.combatants)) {
        combatants[id] = { ...c, stats: { ...c.stats }, statusEffects: c.statusEffects ? [...c.statusEffects] : undefined };
    }
    const rangeRelations: Record<string, Record<string, RangeRelation>> = {};
    for (const [actorId, targets] of Object.entries(state.rangeRelations)) {
        rangeRelations[actorId] = { ...targets };
    }

    const resolutions: ActionResolution[] = [];

    for (const action of actions) {
        const actor = combatants[action.actorId];
        if (!actor || actor.currentHP <= 0) {
            resolutions.push({ actorId: action.actorId, type: action.type, rejected: true, rejectionReason: 'incapacitated' });
            continue;
        }

        if (action.type === 'move') {
            const newPos: PositionTag | undefined = action.newPosition;
            const resolution: ActionResolution = {
                actorId: action.actorId,
                type: 'move',
                newPosition: newPos,
            };

            if (action.moveToTarget && action.targetId) {
                rangeRelations[action.actorId] = rangeRelations[action.actorId] ?? {};
                rangeRelations[action.targetId] = rangeRelations[action.targetId] ?? {};
                rangeRelations[action.actorId][action.targetId] = 'Engaged';
                rangeRelations[action.targetId][action.actorId] = 'Engaged';
                resolution.newRangeRelation = 'Engaged';
            } else if (action.moveToAway && action.targetId) {
                rangeRelations[action.actorId] = rangeRelations[action.actorId] ?? {};
                rangeRelations[action.targetId] = rangeRelations[action.targetId] ?? {};
                rangeRelations[action.actorId][action.targetId] = 'Apart';
                rangeRelations[action.targetId][action.actorId] = 'Apart';
                resolution.newRangeRelation = 'Apart';
            }

            if (newPos) {
                combatants[action.actorId] = { ...combatants[action.actorId], position: newPos };
            }

            resolutions.push(resolution);
            continue;
        }

        if (action.type === 'defend') {
            const braceResult = resolveDefendBrace(actor);
            combatants[action.actorId] = {
                ...combatants[action.actorId],
                currentFOC: braceResult.newFOC,
            };
            resolutions.push({
                actorId: action.actorId,
                type: 'defend',
                focRecovered: braceResult.focRecovered,
            });
            continue;
        }

        if (action.type === 'attack' || action.type === 'mental') {
            const target = action.targetId ? combatants[action.targetId] : undefined;
            if (!target) {
                resolutions.push({
                    actorId: action.actorId,
                    targetId: action.targetId,
                    type: action.type,
                    rejected: true,
                    rejectionReason: 'no target',
                });
                continue;
            }

            if (target.currentHP <= 0) {
                resolutions.push({
                    actorId: action.actorId,
                    targetId: action.targetId,
                    type: action.type,
                    rejected: true,
                    rejectionReason: 'target already down',
                });
                continue;
            }

            if (action.type === 'attack') {
                const weaponRange = action.weaponRange ?? 'Close';
                const rangeRel = rangeRelations[action.actorId]?.[action.targetId ?? ''] ?? 'Apart';
                const legality = checkRangeLegality({
                    weaponRange,
                    rangeRelation: rangeRel,
                    actionType: 'attack',
                });

                if (!legality.legal) {
                    resolutions.push({
                        actorId: action.actorId,
                        targetId: action.targetId,
                        type: 'attack',
                        rejected: true,
                        rejectionReason: legality.reason,
                    });
                    continue;
                }

                const coverMod = applyCoverModifier(target.position, weaponRange, actor.position);
                const attackBonus = action.attackBonus
                    ?? (abilityMod(actor.stats.PWR) + actor.proficiencyBonus);
                const scalingStatMod = action.scalingStatMod ?? abilityMod(actor.stats.PWR);
                const weaponDie = action.weaponDie ?? 6;

                const result = resolveAttack({
                    attackBonus,
                    ac: target.ac,
                    weaponDie,
                    scalingStatMod,
                    advantage: action.advantage || coverMod.advantage,
                    disadvantage: action.disadvantage || coverMod.disadvantage,
                    forceRoll: action.forceRoll,
                });

                if (result.hit && result.damage > 0) {
                    combatants[action.targetId!] = {
                        ...combatants[action.targetId!],
                        currentHP: Math.max(0, target.currentHP - result.damage),
                    };
                }

                let riskApplied: RiskOnFail | undefined;
                if (!result.hit && action.riskOnFail && action.riskOnFail !== 'none') {
                    riskApplied = action.riskOnFail;
                    const currentEffects = actor.statusEffects ? [...actor.statusEffects] : [];
                    switch (action.riskOnFail) {
                        case 'prone':
                            currentEffects.push('prone');
                            combatants[action.actorId] = { ...combatants[action.actorId], statusEffects: currentEffects };
                            break;
                        case 'exposed':
                            combatants[action.actorId] = { ...combatants[action.actorId], position: 'exposed' };
                            break;
                        case 'drop_weapon':
                            currentEffects.push('disarmed');
                            combatants[action.actorId] = { ...combatants[action.actorId], statusEffects: currentEffects };
                            break;
                        case 'self_stagger':
                            currentEffects.push('staggered');
                            combatants[action.actorId] = { ...combatants[action.actorId], statusEffects: currentEffects };
                            break;
                    }
                }

                resolutions.push({
                    actorId: action.actorId,
                    targetId: action.targetId,
                    type: 'attack',
                    hit: result.hit,
                    critical: result.critical,
                    damage: result.damage,
                    naturalRoll: result.naturalRoll,
                    total: result.total,
                    coverApplied: coverMod.disadvantage || coverMod.advantage,
                    riskApplied,
                });
                continue;
            }

            if (action.type === 'mental') {
                const attackerWIL = action.attackerWIL ?? actor.stats.WIL;
                const attackerProficiency = action.attackerProficiency ?? actor.proficiencyBonus;
                const defenderWIL = action.defenderWIL ?? target.stats.WIL;

                const result = resolveMentalSave({
                    attackerWIL,
                    attackerProficiency,
                    defenderWIL,
                    advantage: action.advantage,
                    disadvantage: action.disadvantage,
                    forceRoll: action.forceRoll,
                });

                resolutions.push({
                    actorId: action.actorId,
                    targetId: action.targetId,
                    type: 'mental',
                    saved: result.saved,
                    naturalRoll: result.naturalRoll,
                    total: result.total,
                });
                continue;
            }
        }

        resolutions.push({
            actorId: action.actorId,
            type: action.type,
        });
    }

    const ledgerLine = generateCombatLedgerLine(state.round, combatants);

    return {
        resolutions,
        updatedCombatants: combatants,
        updatedRangeRelations: rangeRelations,
        ledgerLine,
    };
}

export function generateCombatLedgerLine(
    round: number,
    combatants: Record<string, Combatant>,
): string {
    const parts: string[] = [];
    for (const c of Object.values(combatants)) {
        let entry = `${c.name ?? c.id} ${c.currentHP}/${c.maxHP}`;
        if (c.currentFOC !== undefined && c.maxFOC !== undefined) {
            entry += ` FOC:${c.currentFOC}/${c.maxFOC}`;
        }
        if (c.position) {
            entry += ` [${c.position}]`;
        }
        if (c.statusEffects && c.statusEffects.length > 0) {
            entry += ` [${c.statusEffects.join(', ')}]`;
        }
        parts.push(entry);
    }
    return `Round ${round} · ${parts.join(' · ')}`;
}

export function sortTurnOrderBySPD(
    combatants: Record<string, Combatant>,
): string[] {
    return Object.values(combatants)
        .filter(c => c.currentHP > 0)
        .sort((a, b) => b.stats.SPD - a.stats.SPD)
        .map(c => c.id);
}