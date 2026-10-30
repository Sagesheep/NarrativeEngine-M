import type { AppSettings, ChatMessage, LoreChunk } from '../../../types';
import { retrieveRelevantLore } from '../../lore';

const MIN_LORE_BUDGET = 1200;
const AUTO_LORE_BUDGET_PCT = 0.05;

/** Lore tokens per turn: the explicit setting, or 5% of the context limit (never below 1200). */
export function computeLoreBudget(settings: Pick<AppSettings, 'loreBudgetTokens' | 'contextLimit'>): number {
    if (settings.loreBudgetTokens && settings.loreBudgetTokens > 0) return settings.loreBudgetTokens;
    return Math.max(MIN_LORE_BUDGET, Math.floor((settings.contextLimit || 8192) * AUTO_LORE_BUDGET_PCT));
}

/**
 * World-lore RAG: keyword + semantic retrieval over the campaign's lore chunks,
 * budgeted by computeLoreBudget. Returns undefined when there is no lore to search.
 */
export function loreStage(params: {
    loreChunks: LoreChunk[];
    finalInput: string;
    messages: ChatMessage[];
    semanticLoreIds: string[] | undefined;
    tokenBudget: number;
}): LoreChunk[] | undefined {
    const { loreChunks, finalInput, messages, semanticLoreIds, tokenBudget } = params;
    return loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, finalInput, tokenBudget, messages, semanticLoreIds)
        : undefined;
}
