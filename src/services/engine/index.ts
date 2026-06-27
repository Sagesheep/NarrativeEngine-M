export { rollEngines, rollDiceFairness, resolveManualRoll } from './engineRolls';
export type { EngineRollResult, ManualRollResult } from './engineRolls';
export { resolveLootDrop } from './lootEngine';
export type { LootDropResult, LootItem, ResolveLootOpts, LootTree, LootNode, LootProfile } from '../../types';
export { recordLootDrop, clearLootDropHistory, getLootDropHistory, useLootDropHistory } from './lootDropTelemetry';
export type { LootDropRecord } from './lootDropTelemetry';
export { rollCharacterIntroEngine } from './charIntroEngine';
export type { CharIntroResult } from './charIntroEngine';
export { mapTier } from './diceTier';
export { populateEngineTags } from './tagGeneration';
export { generateTroubleOptions } from './troublemaker';
export {
    PC_POINT_BUY,
    STAT_KEYS,
    getPointCost,
    validateAllocation,
    ARCHETYPE_PRESETS,
    CREATION_QUESTIONS,
    getPCTier,
    getPCBudget,
    buildCharacterProfileText,
    DEFAULT_STATS,
} from './pcCreationScript';
export type { PointBuyAllocation, CreationQuestion, StatKey } from './pcCreationScript';
