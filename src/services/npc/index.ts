export {
    generateNPCProfile,
    updateExistingNPCs,
    backfillNPCDrives,
    buildNPCEmbeddingText,
    generateLongWant,
    translatePersonalityToHex,
    validatePersonalityHex,
    validateTraits,
    populateAgencyFields,
    bulkNpcUpdate,
} from './npcGeneration';
export { drawShortWants, drawMediumWants } from './agencyWantDraw';
export { affinityToPcRelation, hexBand, relationBand, describeHex, formatRungBand, formatHexShift, formatRungShift } from './agencyBands';
export { buildGoalsFromWants, upgradeWantsToGoals } from './agencyGoals';
export { isAgencyEligible, filterUpdatableNPCs, completeShortWant } from './agencyLifecycle';
export { rollHeartbeat, buildProximityRoster } from './agencyHeartbeat';
export { contextAllow, goalScore, chooseTick, driveMult } from './agencySelection';
export type { TickChoice } from './agencySelection';
export { rollGoal, nextFailStreak, karmaBonus, bandFromMargin } from './agencyDice';
export type { Band } from './agencyDice';
export { applyBandToGoal, progressDelta, canCrossTier, consumeTierCross } from './agencyProgress';
export { buildDigest, visibilityFromBand } from './agencyDigest';
export type { TickDelta } from './agencyDigest';
export { HEARTBEAT_DC, GOAL_BASE_DC, COLLISION_TANGLE_PROB, COLLISION_OPPORTUNITY_BONUS } from './agencyConstants';
export { extractNPCNames, classifyNPCNames, validateNPCCandidates, COMBAT_TIER_ARCHETYPE_RUBRIC } from './npcDetector';
export { buildBehaviorDirective, buildDriftAlert } from './npcBehaviorDirective';
export { swapDuplicateNames, decideSwap, detectCollisions, applySwap } from './nameSwap';
export type { SwapResult, SwapContext, SwapVerdict, Collision } from './nameSwap';
export { drawUnusedName, lookupCultures, genderOf, isKnownName, NAME_CULTURES } from './nameBank';
export type { Gender } from './nameBank';
export { scanPressure, buildPressurePatch, applyDecay, DECAY_RATE } from './npcPressureTracker';
export { runNPCReview } from './npcReview';
export type { NPCReviewCandidate, NPCReviewCancelled, NPCReviewResult } from './npcReview';
export { resolveNpcSelection, normalizeSelection, findLedgerMatches } from './npcManualResolve';
export type { NpcResolution } from './npcManualResolve';
export { addNpcFromSelection } from './manualAdd';
export type { AddNpcResult, AddNpcDeps } from './manualAdd';
export { ticksForDuration, allocateTicks } from './agencyTimeskip';
export { detectTimeskip, runTimeskip } from './agencyTimeskipRun';
export type { TimeskipDetected, TimeskipAmbiguous, TimeskipResult, TimeskipConfig, TimeskipNarrationResult } from './agencyTimeskipRun';
export { hexDelta, applyGoalOutcomeNudge, applyTierCross } from './agencyDrift';
export { currentActivity, activityBumpPatch, selectTickTarget } from './agencyAudition';
export type { SelectTickTargetResult } from './agencyAudition';
export { goalsCoincide, topActiveGoal, relationTone, detectCollision, resolveTangle, buildTangleDeltas } from './agencyCollision';
export type { DetectedCollision, RelationTone, TangleOutcome } from './agencyCollision';
