import type { AppSettings, NPCEntry } from '../../../types';
import type { UtilityLLM } from '../turnTypes';
import type { PlannerResult } from './plannerStage';
import type { SemanticCandidates } from './retrievalTypes';
import { semanticSearch, semanticSearchScored, isEmbedderReady } from '../../embedding';
import { tierAllows } from '../aiTier';
import { expandQuery } from './expandQueryStage';

const SEMANTIC_FLOOR_SCENE = 0.30;
const SEMANTIC_FLOOR_LORE = 0.30;

const CALLBACK_REGEX = /\b(remember|earlier|back when|before|previously|that .*(we|i) (did|met|fought|saw|found|got))\b/i;

/**
 * Builds the vector-search candidate sets (scene / lore / rule) that the rest of
 * retrieval refines. Resolves the planner concurrently with query expansion (so
 * the two LLM calls overlap), folds planner sub-queries into the search set, then
 * runs the three semantic searches in parallel.
 *
 * Returns the resolved planner result too: when the embedder is ready the planner
 * is awaited here; when it isn't, this returns `plannerResult: null` and the
 * caller resolves it before archive recall (the planner's filters are still
 * needed even with no vector search).
 */
export async function semanticCandidatesStage(params: {
    activeCampaignId: string | null;
    finalInput: string;
    npcLedger: NPCEntry[];
    settings: AppSettings;
    plannerPromise: Promise<PlannerResult | null>;
    utilityLLM: UtilityLLM;
    utilityTimeoutMs: number;
}): Promise<{ plannerResult: PlannerResult | null; candidates: SemanticCandidates }> {
    const { activeCampaignId, finalInput, npcLedger, settings, plannerPromise, utilityLLM, utilityTimeoutMs } = params;

    let plannerResult: PlannerResult | null = null;
    const candidates: SemanticCandidates = {
        semanticArchiveIds: undefined,
        semanticArchiveHits: [],
        semanticLoreIds: undefined,
        semanticRuleIds: undefined,
    };

    if (isEmbedderReady() && activeCampaignId) {
        try {
            let queries = [finalInput];
            const isCallback = CALLBACK_REGEX.test(finalInput);
            const isShort = finalInput.trim().split(/\s+/).length < 8;
            const expansionEndpoint = utilityLLM.endpoint();

            const [resolvedPlanner, expandedQueries] = await Promise.all([
                plannerPromise,
                (isCallback || isShort) && expansionEndpoint?.endpoint && tierAllows(settings.aiTier, 'expandQuery')
                    ? expandQuery(finalInput, npcLedger, utilityLLM, utilityTimeoutMs)
                    : Promise.resolve([finalInput]),
            ]);

            plannerResult = resolvedPlanner;
            queries = expandedQueries;
            if (expandedQueries.length > 1) {
                console.log(`[QueryExpansion] "${finalInput}" → ${expandedQueries.length} variants`);
            }

            if (plannerResult?.subQueries?.length) {
                const newSubs = plannerResult.subQueries.filter(q => !queries.includes(q));
                queries = [...queries, ...newSubs];
                console.log(`[Planner] Added ${newSubs.length} sub-queries`);
            }

            const [sceneHits, loreIds, ruleIds] = await Promise.all([
                semanticSearchScored(activeCampaignId, queries, 'scene', 40, SEMANTIC_FLOOR_SCENE),
                semanticSearch(activeCampaignId, queries, 'lore', 25, SEMANTIC_FLOOR_LORE),
                semanticSearch(activeCampaignId, queries, 'rule', 25, SEMANTIC_FLOOR_LORE),
            ]);
            candidates.semanticArchiveIds = sceneHits?.map(h => h.id);
            candidates.semanticArchiveHits = sceneHits ?? [];
            candidates.semanticLoreIds = loreIds;
            candidates.semanticRuleIds = ruleIds;

            if (candidates.semanticArchiveIds?.length) console.log(`[Semantic] Found ${candidates.semanticArchiveIds.length} scene candidates`);
            if (candidates.semanticLoreIds?.length) console.log(`[Semantic] Found ${candidates.semanticLoreIds.length} lore candidates`);
            if (candidates.semanticRuleIds?.length) console.log(`[Semantic] Found ${candidates.semanticRuleIds.length} rule candidates`);
        } catch (e) {
            console.warn('[Semantic] Candidate search failed, using keyword fallback:', e);
        }
    }

    return { plannerResult, candidates };
}
