export { generateNPCProfile, updateExistingNPCs, backfillNPCDrives, buildNPCEmbeddingText } from './npcGeneration';
export { extractNPCNames, classifyNPCNames, validateNPCCandidates, COMBAT_TIER_ARCHETYPE_RUBRIC } from './npcDetector';
export { buildBehaviorDirective, buildDriftAlert } from './npcBehaviorDirective';
export { swapDuplicateNames, decideSwap, detectCollisions, applySwap } from './nameSwap';
export type { SwapResult, SwapContext, SwapVerdict, Collision } from './nameSwap';
export { drawUnusedName, lookupCultures, genderOf, isKnownName, NAME_CULTURES } from './nameBank';
export type { Gender } from './nameBank';
export { scanPressure, buildPressurePatch, applyDecay, DECAY_RATE } from './npcPressureTracker';
export { runNPCReview } from './npcReview';
export type { NPCReviewCandidate, NPCReviewCancelled, NPCReviewResult } from './npcReview';
export {
    deriveStatsFromBudget,
    TIER_DICE_BUDGETS,
    createItemDefFromTemplate,
    createSkillDefFromTemplate,
    resolveOrAddItemDef,
    resolveOrAddSkillDef,
    assignCombatLoadout,
} from './npcCombatGeneration';
