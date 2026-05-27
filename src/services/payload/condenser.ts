import type { ChatMessage, CondenseAggressiveness } from '../../types';

import { countTokens } from '../infrastructure';

const VERBATIM_WINDOW = 10;
const DEFAULT_BUDGET_RATIO = 0.75;

export const AGGRESSIVENESS_RATIOS: Record<CondenseAggressiveness, number> = {
    aggressive: 0.50,
    balanced: 0.75,
    quality: 0.90,
};

export function getCondenseBudgetRatio(aggressiveness?: CondenseAggressiveness): number {
    if (!aggressiveness) return DEFAULT_BUDGET_RATIO;
    return AGGRESSIVENESS_RATIOS[aggressiveness] ?? DEFAULT_BUDGET_RATIO;
}

export function shouldCondense(
    messages: ChatMessage[],
    contextLimit: number,
    condensedUpToIndex: number,
    budgetRatio = DEFAULT_BUDGET_RATIO
): boolean {
    const uncondensedMessages = messages.slice(condensedUpToIndex + 1);
    if (uncondensedMessages.length <= VERBATIM_WINDOW) return false;

    const historyTokens = countTokens(
        uncondensedMessages.map((m) => m.content).join('')
    );
    return historyTokens > contextLimit * budgetRatio;
}

export function getVerbatimWindow(): number {
    return VERBATIM_WINDOW;
}

export function computeTrimIndex(messages: ChatMessage[], condensedUpToIndex: number): number {
    const trimTarget = messages.length - VERBATIM_WINDOW;
    if (trimTarget <= condensedUpToIndex) return condensedUpToIndex;
    return trimTarget;
}