export { rollEngines, rollDiceFairness } from './engineRolls';
export type { EngineRollResult } from './engineRolls';
export { rollCharacterIntroEngine } from './charIntroEngine';
export type { CharIntroResult } from './charIntroEngine';
export { mapTier } from './diceTier';
export { populateEngineTags } from './tagGeneration';
export { generateTroubleOptions } from './troublemaker';
export {
    abilityMod,
    computeAC,
    computeMaxHP,
    computeMaxFOC,
    proficiencyBonusForTier,
    resolveAttack,
    resolveMentalSave,
    rollInitiative,
    materializeCombatant,
    recoveryBandToMaxHPPercent,
    resolveActionQueue,
    checkRangeLegality,
    applyCoverModifier,
    resolveDefendBrace,
    checkTermination,
    runCombatRound,
    generateCombatLedgerLine,
    sortTurnOrderBySPD,
    ARCHETYPE_BUDGETS,
    ARCHETYPE_BEHAVIORS,
    COMBAT_TIER_LEVEL_BANDS,
    FOC_SPELL_COSTS,
} from './combatEngine';
export type {
    CombatTier,
    Archetype,
    RecoveryBand,
    StatBlock,
    Combatant,
    AttackResult,
    MentalSaveResult,
    InitiativeResult,
    CombatAction,
    ActionResolution,
    ResolveAttackInput,
    ResolveMentalSaveInput,
    MaterializeInput,
    BehaviorEntry,
    PositionTag,
    RangeRelation,
    RangeLegalityResult,
    CoverModifier,
    DefendBraceResult,
    TerminationResult,
    RoundResult,
    RiskOnFail,
} from './combatEngine';
