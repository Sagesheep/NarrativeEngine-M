import type { NPCEntry } from '../../../types';
import type { UtilityLLM } from '../turnTypes';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    TTRPG_PERSONA_RETRIEVAL_PLANNER,
    joinPromptSections,
} from '../../infrastructure';

export type PlannerResult = {
    subQueries?: string[];
    filters?: {
        characters?: string[];
        locations?: string[];
        items?: string[];
        concepts?: string[];
        eventTypes?: string[];
    };
    sceneIdRange?: [string, string] | null;
};

/**
 * Retrieval planner: asks the utility LLM for sub-queries + entity/event filters
 * to focus archive recall. Returns null on any failure (parse, timeout, network)
 * — the caller falls back to unfiltered recall.
 */
export async function runPlannerCall(
    userMessage: string,
    recentMessages: Array<{ role?: string; content?: string }>,
    npcLedger: NPCEntry[],
    chapterSummary: string | undefined,
    utilityLLM: UtilityLLM,
    timeoutSeconds?: number,
): Promise<PlannerResult | null> {
    try {
        const timeoutMs = (timeoutSeconds ?? 45) * 1000;

        const recentContextText = recentMessages
            .slice(-8)
            .map(m => `${m.role === 'assistant' ? 'GM' : 'Player'}: ${(m.content ?? '').slice(0, 200)}`)
            .join('\n');

        const npcRosterText = npcLedger.slice(0, 30).map(n => `${n.id}: ${n.name}`).join('\n') || '(none)';

        const prompt = joinPromptSections(
            TTRPG_PERSONA_RETRIEVAL_PLANNER,

            `OUTPUT — a single JSON object (example values shown for shape; emit your own based on the input):
{
  "subQueries": ["query rephrase 1", "query rephrase 2"],
  "filters": {
    "characters": ["Astarion"],
    "locations": ["Baldur's Gate"],
    "items": [],
    "concepts": [],
    "eventTypes": ["promise", "betrayal"]
  },
  "sceneIdRange": null
}`,

            `RULES:
- subQueries: 0-3 alternative phrasings of what to search for. Optional — omit or use [] if the user message is already specific.
- filters.characters: NPC names (from the roster below) that should heavily influence recall. Only include if the user message clearly references them.
- filters.locations / items / concepts: domain entities mentioned or strongly implied.
- filters.eventTypes: any of [combat, discovery, item_acquired, item_lost, relationship_shift, travel, promise, betrayal, death, revelation, quest_milestone, other]. Only include when the user message references that kind of event (e.g. "what did I promise" → ["promise"]).
- sceneIdRange: only set if the user message clearly anchors to a time window (e.g. "back in Waterdeep" → range covering those scenes); otherwise null.
- If nothing is clear, output {} — empty filters is valid. DO NOT hallucinate filters.`,

            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `USER MESSAGE: """${userMessage}"""`,
            `RECENT CONTEXT (last few turns):\n${recentContextText}`,
            `NPC ROSTER:\n${npcRosterText}`,
            `CHAPTER SUMMARY (if any):\n${chapterSummary || '(no chapter summary)'}`,
        );

        const raw = await utilityLLM.call(prompt, {
            temperature: 0.1,
            priority: 'high',
            maxTokens: 400,
            timeoutMs,
            trackingLabel: 'planner',
        });

        let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const braceStart = clean.indexOf('{');
        const braceEnd = clean.lastIndexOf('}');
        if (braceStart === -1 || braceEnd === -1) return null;

        const parsed: PlannerResult = JSON.parse(clean.substring(braceStart, braceEnd + 1));
        return parsed;
    } catch {
        return null;
    }
}
