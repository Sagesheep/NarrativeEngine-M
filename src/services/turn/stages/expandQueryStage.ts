import type { NPCEntry } from '../../../types';
import type { UtilityLLM } from '../turnTypes';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ARRAY_ONLY_FOOTER,
    joinPromptSections,
} from '../../infrastructure';

/**
 * Query expansion: rephrases a short/callback query into alternates that expand
 * pronouns and add likely entity names, improving vector recall. Returns
 * `[query]` (the original only) on any failure.
 */
export async function expandQuery(query: string, npcLedger: NPCEntry[], utilityLLM: UtilityLLM, timeoutMs?: number): Promise<string[]> {
    try {
        const npcContext = npcLedger.slice(0, 10).map(n => n.name).join(', ');
        const prompt = joinPromptSections(
            'You are a query expansion assistant for a TTRPG archive search.',

            'Generate 2 alternative phrasings of the user query that expand pronouns, add likely entity names from context, and use synonyms. Output a JSON array of exactly 2 strings.',

            JSON_ARRAY_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `User query: "${query}"`,
            `Known NPCs: ${npcContext}`,
        );

        const raw = await utilityLLM.call(prompt, {
            temperature: 0.2,
            priority: 'high',
            maxTokens: 200,
            ...(timeoutMs ? { timeoutMs, trackingLabel: 'expandQuery' } : {}),
        });

        let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const bracketStart = clean.indexOf('[');
        const bracketEnd = clean.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1) return [query];

        const parsed = JSON.parse(clean.substring(bracketStart, bracketEnd + 1));
        if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((x: unknown) => typeof x === 'string')) {
            return [query, parsed[0], parsed[1]];
        }
        return [query];
    } catch {
        return [query];
    }
}
