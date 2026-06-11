import type { ChatMessage, LoreChunk } from '../../../types';
import { retrieveRelevantLore } from '../../lore';

/**
 * World-lore RAG: keyword + semantic retrieval over the campaign's lore chunks,
 * budgeted at 1200 tokens. Returns undefined when there is no lore to search.
 */
export function loreStage(params: {
    loreChunks: LoreChunk[];
    finalInput: string;
    messages: ChatMessage[];
    semanticLoreIds: string[] | undefined;
}): LoreChunk[] | undefined {
    const { loreChunks, finalInput, messages, semanticLoreIds } = params;
    return loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, finalInput, 1200, messages, semanticLoreIds)
        : undefined;
}
