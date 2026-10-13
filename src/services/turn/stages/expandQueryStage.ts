import type { ChatMessage, NPCEntry } from '../../../types';
import type { UtilityLLM } from '../turnTypes';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ARRAY_ONLY_FOOTER,
    joinPromptSections,
} from '../../infrastructure';

// Name words that say nothing about who someone is ("The Broker", "Lady Soll").
const NON_NAME_WORDS = new Set(['the', 'lady', 'lord', 'sir', 'master', 'mistress', 'captain', 'old', 'young', 'madam', 'mister', 'doctor', 'dr', 'mr', 'mrs', 'ms']);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ledger NPCs a text names in any form: full name, alias, or a capitalised name
 *  word ("Rin" for "Rin Holmes"). Port of mainApp's `mentionedNpcs`. */
export function npcsNamedIn(text: string, ledger: readonly NPCEntry[]): NPCEntry[] {
    const lower = text.toLowerCase();
    return ledger.filter(npc => {
        if (typeof npc.name !== 'string' || npc.name.trim() === '') return false;
        const keys = [npc.name, ...(npc.aliases || '').split(',')].map(k => k.trim().toLowerCase()).filter(Boolean);
        if (keys.some(key => key.length >= 3 && lower.includes(key))) return true;
        return npc.name.split(/\s+/).some(word => word.length >= 3 && /^\p{Lu}/u.test(word)
            && !NON_NAME_WORDS.has(word.toLowerCase())
            && new RegExp(`(?<![\\p{L}])${escapeRegex(word)}(?![\\p{L}])`, 'u').test(text));
    });
}

/** The last exchange, trimmed: what "her", "it" or "the job" in a short message refers to. */
export function recentSceneText(messages: readonly ChatMessage[]): string {
    const recent = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-2);
    return recent.map(m => `${m.role === 'assistant' ? 'GM' : 'PLAYER'}: ${(m.content ?? '').slice(0, m.role === 'assistant' ? 1500 : 400)}`).join('\n\n');
}

/**
 * Query expansion: rewrites a short/callback query as standalone search queries,
 * replacing pronouns with the people, places and things they refer to. Returns
 * `[query]` (the original only) on any failure.
 *
 * It used to get the first 10 ledger NPCs (the oldest, usually unrelated) and no
 * scene, so the model wove random names into the query. It now sees the last
 * exchange and only the NPCs named in it (port of mainApp 0c3a501).
 */
export async function expandQuery(query: string, messages: readonly ChatMessage[], npcLedger: NPCEntry[], utilityLLM: UtilityLLM, timeoutMs?: number): Promise<string[]> {
    try {
        const scene = recentSceneText(messages);
        const names = npcsNamedIn(`${scene}\n${query}`, npcLedger).slice(0, 12).map(n => n.name);
        const prompt = joinPromptSections(
            'You are a query expansion assistant for a TTRPG archive search.',

            'The player\'s message below is short, so a memory search on it alone may miss the past scene they mean. Rewrite it as 2 standalone search queries for the campaign archive. Replace pronouns and vague references ("her", "it", "the job", "that place") with the specific people, places and things they refer to. Use ONLY names that appear in the recent scene, the character list, or the message itself. Do not invent names, events or details. Output a JSON array of exactly 2 strings.',

            JSON_ARRAY_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `RECENT SCENE:\n"""\n${scene || '(none)'}\n"""`,
            `CHARACTERS IN THE RECENT SCENE: ${names.join(', ') || '(none)'}`,
            `PLAYER MESSAGE: "${query}"`,
        );

        const raw = await utilityLLM.call(prompt, {
            temperature: 0.2,
            priority: 'high',
            maxTokens: 200,
            thinkingEffort: 'off',
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
