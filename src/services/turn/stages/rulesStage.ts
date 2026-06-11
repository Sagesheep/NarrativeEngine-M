import type { AppSettings, ChatMessage, GameContext, LoreChunk } from '../../../types';
import { retrieveRelevantRules } from '../../lore';
import { countTokens } from '../../infrastructure';

/**
 * Rules RAG: only engages when a rules document exists and exceeds ~1.2× its
 * token budget — below that the verbatim rules are cheaper to pass whole. On
 * retrieval failure returns undefined so the caller falls back to verbatim.
 */
export async function rulesStage(params: {
    context: GameContext;
    settings: AppSettings;
    finalInput: string;
    messages: ChatMessage[];
    semanticRuleIds: string[] | undefined;
}): Promise<LoreChunk[] | undefined> {
    const { context, settings, finalInput, messages, semanticRuleIds } = params;
    if (!context.rulesRaw) return undefined;

    const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
    const rulesBudget = Math.floor((settings.contextLimit || 8192) * rulesBudgetPct);
    const threshold = Math.floor(rulesBudget * 1.2);
    const rulesTokenCount = countTokens(context.rulesRaw);
    if (rulesTokenCount <= threshold) return undefined;

    try {
        const { chunkLoreFile } = await import('../../lore');
        const ruleChunks = chunkLoreFile(context.rulesRaw, 'rule');
        const relevantRules = retrieveRelevantRules(
            ruleChunks,
            context.rulesChunkMeta,
            finalInput,
            rulesBudget,
            messages,
            semanticRuleIds,
        );
        if (relevantRules.length > 0) {
            console.log(`[RulesRAG] Retrieved ${relevantRules.length}/${ruleChunks.length} rule chunks`);
        }
        return relevantRules;
    } catch (e) {
        console.warn('[RulesRAG] Retrieval failed, falling back to verbatim:', e);
        return undefined;
    }
}
