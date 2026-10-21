export {
    EMPTY_REGISTER,
    DIVERGENCE_CATEGORIES,
    CATEGORY_LABELS,
    CATEGORY_DEFINITIONS,
    coerceCategory,
    stripReasoning,
    mergeSealEntries,
    mergeLifecycleEntries,
    isFactActive,
    isValidStateKey,
    normalizeStateKey,
    STATE_KEY_KINDS,
    STATE_KEY_ATTRIBUTES,
    applyStateKeys,
    restoreFact,
    renderRegisterForPayload,
    countRegisterTokens,
    getDivergenceSceneIds,
    toggleChapter,
    toggleCategory,
    pinFact,
    editFact,
    deleteFact,
    deleteChapter,
    toggleFact,
    dismissReviewFlag,
    editKnownBy,
    applySubjectTokens,
    getEntriesForChapter,
    getEntriesForNpc,
    migrateV1ToV2
} from './divergenceRegister';
export { runFactClustering, assignSubjectTokens, deriveSubjectTokenUpdates } from './factClusterer';
export type { ClusteringCancelled, AssignSubjectTokensResult, SubjectTokenUpdate } from './factClusterer';
export { assignStateKeys } from './stateKeyAssigner';
export type { StateKeyCancelled, StateKeyUpdate } from './stateKeyAssigner';
export { runFactDedup } from './factDeduper';
export type { DedupGroup, DedupCancelled, DedupResult } from './factDeduper';
export { fetchFacts, extractContextEntities, queryFacts, formatFactsForContext, queryTraits, formatTraitsForContext } from './semanticMemory';
export type { SelectedTraits } from './semanticMemory';
export { resolveTimeline, queryTimeline, formatResolvedForContext, getEventsByScene, maxImportanceForScene } from './timelineResolver';
export type { ResolvedTruth } from './timelineResolver';
export { scanCharacterProfile, scanCharacterProfileWithPcState } from './characterProfileParser';
export type { ProfileScanResult } from './characterProfileParser';
export { scanInventory } from './inventoryParser';
export { normalizeSubjectToken, parseKnownByToken, isKnownToAnyOnStage, normalizeFaction, compareSceneRef, groupDivergencesBySubject } from './knowledgeScope';
export type { KnownByToken } from './knowledgeScope';
