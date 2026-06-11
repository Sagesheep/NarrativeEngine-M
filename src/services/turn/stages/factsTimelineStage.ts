import type { ChatMessage, NPCEntry, SemanticFact, TimelineEvent } from '../../../types';
import { queryFacts, formatFactsForContext, formatResolvedForContext } from '../../campaign-state';

/**
 * Builds the semantic-fact context block: relevant queried facts plus, if a
 * timeline exists, the resolved-state summary appended underneath. Each half is
 * independently fault-tolerant — a failure in one still yields the other.
 */
export async function gatherFactsAndTimeline(params: {
    semanticFacts: SemanticFact[];
    finalInput: string;
    messages: ChatMessage[];
    npcLedger: NPCEntry[];
    timeline: TimelineEvent[] | undefined;
}): Promise<string> {
    const { semanticFacts, finalInput, messages, npcLedger, timeline } = params;

    let semanticFactText = '';
    try {
        semanticFactText = formatFactsForContext(queryFacts(semanticFacts, finalInput, messages, npcLedger, 500));
    } catch (err) {
        console.warn('[TurnContext] Failed to query semantic facts:', err);
    }

    try {
        if (timeline && timeline.length > 0) {
            const { resolveTimeline } = await import('../../campaign-state');
            const resolvedText = formatResolvedForContext(resolveTimeline(timeline));
            if (resolvedText) semanticFactText += '\n' + resolvedText;
        }
    } catch (err) {
        console.warn('[TurnContext] Failed to resolve timeline:', err);
    }

    return semanticFactText;
}
