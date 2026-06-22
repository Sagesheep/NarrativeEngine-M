export {
    EMPTY_REGISTER,
    DIVERGENCE_CATEGORIES,
    CATEGORY_LABELS,
    CATEGORY_DEFINITIONS,
    coerceCategory,
    stripReasoning,
    mergeSealEntries,
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
export { runFactDedup } from './factDeduper';
export type { DedupGroup, DedupCancelled, DedupResult } from './factDeduper';
export { fetchFacts, extractContextEntities, queryFacts, formatFactsForContext, queryTraits, formatTraitsForContext } from './semanticMemory';
export type { SelectedTraits } from './semanticMemory';
export { resolveTimeline, queryTimeline, formatResolvedForContext, getEventsByScene, getEventsByChapter, getScenesWithEvents, maxImportanceForScene } from './timelineResolver';
export type { ResolvedTruth } from './timelineResolver';
export { scanCharacterProfile } from './characterProfileParser';
export { scanInventory } from './inventoryParser';
export { normalizeSubjectToken, parseKnownByToken, isKnownToAnyOnStage, normalizeFaction, compareSceneRef, groupDivergencesBySubject } from './knowledgeScope';
export type { KnownByToken } from './knowledgeScope';
