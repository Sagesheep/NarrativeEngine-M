import type { ChatMessage, LoreChunk } from '../../../types';
import type { TurnState, UtilityLLM } from '../turnTypes';
import { recommendContext, type NpcDetailLevel } from '../../payload';
import { tierAllows } from '../aiTier';

export type RecommenderPicks = {
    recommendedNPCNames: string[] | undefined;
    relevantLoreIds: string[];
    /** npcId → full/brief. Undefined when the call did not run or failed, which
     *  keeps every NPC at full detail (pre-detail-level behavior). */
    recommendedNPCDetail: Record<string, NpcDetailLevel> | undefined;
};

const NO_PICKS: RecommenderPicks = { recommendedNPCNames: undefined, relevantLoreIds: [], recommendedNPCDetail: undefined };

/**
 * AI context recommender: asks the utility LLM which NPCs and lore are relevant
 * to the current moment. Needs nothing from the other retrieval stages, so the
 * gather starts it alongside them; its lore picks are merged in afterwards by
 * `injectRecommendedLore`.
 *
 * Skipped when there is nothing to pick from (no NPCs, no optional lore, no pinned
 * chapters): the model can only return items that exist, so on a fresh campaign
 * the call is a round trip the turn waits on for nothing (desktop recommenderGather).
 */
export async function recommenderStage(params: {
    state: TurnState;
    finalInput: string;
    messages: ChatMessage[];
    utilityLLM: UtilityLLM;
    utilityTimeoutMs: number;
}): Promise<RecommenderPicks> {
    const { state, finalInput, messages, utilityLLM, utilityTimeoutMs } = params;
    const { settings, npcLedger, loreChunks } = state;

    const utilityEndpoint = utilityLLM.endpoint();
    if (!tierAllows(settings.aiTier, 'recommender') || !utilityEndpoint?.endpoint) return NO_PICKS;

    const pinnedChaptersForRecommender = state.pinnedChapterIds.length > 0
        ? state.chapters.filter(c => state.pinnedChapterIds.includes(c.chapterId))
        : undefined;
    const hasSelectableContent =
        npcLedger.length > 0 ||
        loreChunks.some(c => !c.alwaysInclude) ||
        (pinnedChaptersForRecommender?.length ?? 0) > 0;
    if (!hasSelectableContent) return NO_PICKS;

    try {
        const result = await recommendContext(utilityEndpoint, npcLedger, loreChunks, messages, finalInput, pinnedChaptersForRecommender, utilityTimeoutMs, state.onStageNpcIds);
        if (!result) return NO_PICKS;
        return {
            recommendedNPCNames: result.relevantNPCNames,
            relevantLoreIds: result.relevantLoreIds,
            recommendedNPCDetail: result.npcDetail ?? {},
        };
    } catch (err) {
        console.warn('[TurnOrchestrator] UtilityAI recommender failed:', err);
        return NO_PICKS;
    }
}

/**
 * Adds the lore chunks the recommender picked that keyword/semantic retrieval
 * missed to `relevantLore` (mutated in place), capped at 600 extra tokens.
 */
export function injectRecommendedLore(
    relevantLore: LoreChunk[] | undefined,
    relevantLoreIds: string[],
    loreChunks: LoreChunk[],
): void {
    if (relevantLoreIds.length === 0 || loreChunks.length === 0 || !relevantLore) return;

    const alreadyIn = new Set(relevantLore.map(c => c.id));
    const RECOMMENDER_EXTRA_BUDGET = 600;
    let extraTokens = 0;

    for (const id of relevantLoreIds) {
        const chunk = loreChunks.find(c => c.id === id);
        if (!chunk || alreadyIn.has(chunk.id) || chunk.alwaysInclude) continue;
        if (extraTokens + chunk.tokens > RECOMMENDER_EXTRA_BUDGET) continue;
        relevantLore.push(chunk);
        alreadyIn.add(chunk.id);
        extraTokens += chunk.tokens;
    }

    if (extraTokens > 0) console.log(`[TurnContext] Recommender injected lore (${extraTokens} extra tokens)`);
}
