import type { ChatMessage, NPCEntry } from '../../../types';
import { semanticSearch, isEmbedderReady } from '../../embedding';

/** At or under the worker's single-pass limit, so each recent message is one pass. */
const RECENT_TAIL_CHARS = 1500;

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
            // The player's message goes first: the main memory search embeds the same
            // text and shares this vector, so it must not queue behind longer texts.
            // Recent messages are cut to their last RECENT_TAIL_CHARS (one embedder pass;
            // a full GM reply is several, ~1 s each on a phone), and scene markers and
            // tool results are skipped.
            const recentContext = freshMessages
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .slice(-3)
                .map(m => (m.content || '').slice(-RECENT_TAIL_CHARS))
                .filter(Boolean);
            const queryTexts = [finalInput, ...recentContext].filter(t => t.length > 0).slice(0, 4);
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
