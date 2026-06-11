import type { SearchHit } from '../../embedding/vectorSearch';

/**
 * The candidate IDs that the semantic → rerank → lore/rules stages share and
 * progressively refine. Carrier object so these stages pass explicit state
 * instead of mutating closure-scoped `let` variables (Plan 4.4).
 */
export interface SemanticCandidates {
    /** Scene IDs (rerank may reorder/trim). */
    semanticArchiveIds: string[] | undefined;
    /** Scene hits with scores — kept in sync with semanticArchiveIds. */
    semanticArchiveHits: SearchHit[];
    /** Lore chunk IDs (rerank may reorder/trim). */
    semanticLoreIds: string[] | undefined;
    /** Rule chunk IDs (never reranked). */
    semanticRuleIds: string[] | undefined;
}
