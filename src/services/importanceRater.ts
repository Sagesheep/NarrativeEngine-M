import type { ChatMessage, LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';

const IMPORTANCE_PROMPT = `Rate the narrative importance of the scene below on a 1-10 scale.

CRITERIA:
1-2 — Trivial: passing greeting, mundane travel, routine shopping, small talk
3-4 — Minor: routine conversation, minor discovery, atmospheric description
5-6 — Notable: meaningful dialogue, new NPC introduced, new location explored, skill check
7-8 — Significant: combat encounter, major reveal, relationship shift, item acquired/lost, plot milestone
9-10 — Critical: character death, betrayal, major plot twist, world-changing event, irreversible consequence

RULES:
- Output ONLY a single digit or two-digit number 1-10, nothing else
- When uncertain, round DOWN (prefer lower importance)

RECENT CONTEXT:
{context}

SCENE TO RATE:
User: {userText}
GM: {gmText}`;

export async function rateImportance(
    provider: LLMProvider,
    userText: string,
    gmText: string,
    recentMessages?: ChatMessage[],
): Promise<number> {
    const contextLines = recentMessages
        ?.slice(-4)
        .map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 200)}`)
        .join('\n') ?? '';

    const prompt = IMPORTANCE_PROMPT
        .replace('{context}', contextLines)
        .replace('{userText}', userText.slice(0, 600))
        .replace('{gmText}', gmText.slice(0, 1200));

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 5 });
        const match = raw.trim().match(/\b([1-9]|10)\b/);
        if (match) return parseInt(match[1], 10);
    } catch (err) {
        console.warn('[ImportanceRater] LLM call failed, using heuristic fallback:', err);
    }
    return heuristicImportance(`${userText}\n${gmText}`);
}

export function heuristicImportance(text: string): number {
    const lower = text.toLowerCase();
    let score = 3;
    if (/\b(killed|slain|died|defeated|destroyed|executed|murdered|sacrificed)\b/.test(lower)) score += 3;
    if (/\[MEMORABLE:/.test(text)) score += 2;
    if (/\b(king|queen|emperor|empress|lord|lady|prince|princess|archmage|general|commander|champion)\b/.test(lower)) score += 1;
    if (/\b(acquired|obtained|rewarded|treasure|legendary|artifact|enchanted)\b/.test(lower)) score += 1;
    if (/\b(quest|mission|objective|prophecy|oath|vow|alliance|betrayal|treaty)\b/.test(lower)) score += 1;
    return Math.min(10, Math.max(1, score));
}