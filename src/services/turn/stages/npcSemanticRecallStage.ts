import type { ChatMessage, NPCEntry } from '../../../types';
import { semanticSearch, isEmbedderReady } from '../../embedding';

/**
 * Semantic NPC recall: embeds the last few turns + the current input and returns
 * NPC ids whose profiles vector-match, so off-stage-but-relevant NPCs can be
 * surfaced. Returns [] when the embedder isn't ready or on any failure.
 */
export async function recallNpcsSemantically(params: {
    activeCampaignId: string | null;
    npcLedger: NPCEntry[];
    freshMessages: ChatMessage[];
    finalInput: string;
}): Promise<string[]> {
    const { activeCampaignId, npcLedger, freshMessages, finalInput } = params;

    if (isEmbedderReady() && npcLedger && npcLedger.length > 0 && activeCampaignId) {
        try {
            const recentContext = freshMessages.slice(-3).map(m => m.content || '').filter(Boolean);
            const queryTexts = [...recentContext, finalInput].filter(t => t.length > 0).slice(-4);
            if (queryTexts.length > 0) {
                const hits = await semanticSearch(activeCampaignId, queryTexts, 'npc', 5, 0.4);
                if (hits && hits.length > 0) {
                    console.log(`[NPC] semantic recall hits=[${hits.join(',')}] query="${finalInput.slice(0, 60)}..."`);
                    return hits;
                }
            }
        } catch (e) {
            console.warn('[TurnContext] NPC semantic recall failed:', e);
        }
    }
    return [];
}
