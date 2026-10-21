/**
 * contextRecommender.ts
 * ---------------------
 * LLM-powered context selection — replaces substring matching when a utilityAI endpoint is configured.
 * Sends the NPC ledger headers + lore chunk headers + recent history excerpt to a cheap/local model,
 * which returns the relevant NPCs (each with a full/brief detail level) and lore IDs.
 *
 * Falls back silently on any error (caller handles fallback to substring scan).
 */

import type { LLMProvider, NPCEntry, LoreChunk, ChatMessage, ArchiveChapter } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    joinPromptSections,
} from '../infrastructure';

/** How much of an NPC's profile the story model gets this turn (see payloadWorldContext). */
export type NpcDetailLevel = 'full' | 'brief';

export type RecommenderResult = {
    relevantNPCNames: string[];   // NPC names the model considers relevant
    relevantLoreIds: string[];    // Lore chunk IDs the model considers relevant
    /** npcId → detail level, only for NPCs the model gave a valid level. */
    npcDetail: Record<string, NpcDetailLevel>;
};

/**
 * Build a compact roster string from the NPC ledger.
 * Only sends handle + name + faction + status (+ a present marker) — enough for the
 * model to judge relevance and involvement without blowing up the prompt. Handles
 * (N1, N2, …) are per-request and map back to ledger entries via `handles`.
 */
function buildNPCRoster(ledger: NPCEntry[], onStageNpcIds: string[] = []): { text: string; handles: Map<string, NPCEntry> } {
    const handles = new Map<string, NPCEntry>();
    if (ledger.length === 0) return { text: 'No NPCs in ledger.', handles };
    const onStage = new Set(onStageNpcIds);
    const MAX_ROSTER = 30;
    const recurring = ledger.filter(npc => npc.tier === 'recurring');
    const others = ledger.filter(npc => npc.tier !== 'recurring');
    const othersCount = Math.max(0, MAX_ROSTER - recurring.length);
    const rotationIndex = Math.floor(Date.now() / 60000) % (others.length > othersCount ? others.length - othersCount + 1 : 1);
    const rotatedOthers = others.slice(rotationIndex, rotationIndex + othersCount);
    if (rotatedOthers.length < othersCount) {
        rotatedOthers.push(...others.slice(0, othersCount - rotatedOthers.length));
    }
    const roster = [...recurring, ...rotatedOthers];
    const text = roster.map((npc, i) => {
        const handle = `N${i + 1}`;
        handles.set(handle, npc);
        const parts = [`${handle}: ${npc.name}`];
        if (npc.aliases) parts.push(`(aka ${npc.aliases})`);
        if (npc.faction) parts.push(`[${npc.faction}]`);
        if (npc.status) parts.push(`— ${npc.status}`);
        if (npc.tier) parts.push(`[${npc.tier}]`);
        if (onStage.has(npc.id)) parts.push('[present]');
        return parts.join(' ');
    }).join('\n');
    return { text, handles };
}

/**
 * Resolve the model's `npcs` array. Accepts the current object form
 * ({"id":"N3","detail":"full"}) and the legacy plain-string form ("Name" or "N3").
 * Unresolvable strings pass through as names (selectActiveNPCs matches names/aliases);
 * an invalid or missing detail level is simply left out (the engine defaults it).
 */
export function parseRecommendedNPCs(
    raw: unknown,
    handles: Map<string, NPCEntry>,
    ledger: NPCEntry[],
): { names: string[]; detail: Record<string, NpcDetailLevel> } {
    const names: string[] = [];
    const detail: Record<string, NpcDetailLevel> = {};
    if (!Array.isArray(raw)) return { names, detail };

    const byName = (n: string): NPCEntry | undefined => {
        const key = n.trim().toLowerCase();
        return ledger.find(npc =>
            npc.name?.toLowerCase() === key ||
            (npc.aliases || '').split(',').some(a => a.trim().toLowerCase() === key));
    };

    for (const item of raw) {
        let ref: string | undefined;
        let level: unknown;
        if (typeof item === 'string') {
            ref = item;
        } else if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            const r = o.id ?? o.name;
            if (typeof r === 'string') ref = r;
            level = o.detail;
        }
        if (!ref || !ref.trim()) continue;
        const npc = handles.get(ref.trim().toUpperCase()) ?? byName(ref);
        if (!npc) {
            if (typeof item === 'string') names.push(ref); // legacy passthrough
            continue;
        }
        if (!names.includes(npc.name)) names.push(npc.name);
        const lv = typeof level === 'string' ? level.trim().toLowerCase() : undefined;
        // Duplicate picks: full wins, so a character is never under-described.
        if ((lv === 'full' || lv === 'brief') && detail[npc.id] !== 'full') detail[npc.id] = lv;
    }
    return { names, detail };
}

/**
 * Build a compact lore index from chunks.
 * Sends id + category + header + summary for relevance judgment.
 */
function buildLoreIndex(chunks: LoreChunk[]): string {
    if (chunks.length === 0) return 'No lore chunks available.';
    return chunks
        .filter(c => !c.alwaysInclude) // alwaysInclude chunks don't need recommendation
        .map(c => {
            const sum = c.summary ? ` — ${c.summary}` : '';
            return `- ID:${c.id} | ${c.category} | ${c.header}${sum}`;
        }).join('\n');
}

/**
 * Extract a concise conversation excerpt from recent messages.
 * Takes the last N messages and truncates long ones. The latest GM reply also keeps
 * its ending: that is where the scene currently stands (who is speaking/acting),
 * which the full/brief detail choice depends on.
 */
export function buildConversationExcerpt(messages: ChatMessage[], userMessage: string, depth: number = 6): string {
    const recent = messages.slice(-depth);
    let lastGmIdx = -1;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i].role === 'assistant') { lastGmIdx = i; break; }
    }
    const lines = recent.map((m, i) => {
        const role = m.role === 'user' ? 'PLAYER' : m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
        const content = m.content || '';
        let text = content.slice(0, 300); // Truncate long messages
        if (i === lastGmIdx && content.length > 300) {
            text = content.length > 900 ? `${content.slice(0, 300)} … ${content.slice(-600)}` : content;
        }
        return `[${role}]: ${text}`;
    });
    lines.push(`[PLAYER]: ${userMessage.slice(0, 300)}`);
    return lines.join('\n\n');
}

function buildPinnedChapterContext(chapters: ArchiveChapter[]): string {
    return chapters.map(ch => {
        const parts = [`[${ch.chapterId}] ${ch.title} (Scenes ${ch.sceneRange[0]}–${ch.sceneRange[1]})`];
        if (ch.summary) parts.push(`  Summary: ${ch.summary.slice(0, 200)}`);
        if (ch.npcs.length > 0) parts.push(`  NPCs: ${ch.npcs.join(', ')}`);
        if (ch.keywords.length > 0) parts.push(`  Keywords: ${ch.keywords.slice(0, 10).join(', ')}`);
        if (ch.majorEvents.length > 0) parts.push(`  Events: ${ch.majorEvents.slice(0, 3).join('; ')}`);
        return parts.join('\n');
    }).join('\n\n');
}

const RECOMMENDER_PROMPT_STATIC = joinPromptSections(
    'You are a context selector for a tabletop RPG game engine. Given a conversation excerpt, a roster of NPCs, and an index of lore entries, determine which NPCs and lore entries are RELEVANT to the current scene, and how much detail the story writer needs about each NPC.',

    `RULES:
1. An NPC is relevant if they are: mentioned by name/alias, physically present in the scene, directly referenced, or their faction/goals are materially involved.
2. A lore entry is relevant if: its subject matter relates to the current location, active quest, mentioned organizations, or ongoing conflict.
3. Be SELECTIVE — only include truly relevant entries, not everything tangentially related.
4. DM-PINNED CHAPTERS are manually flagged as important by the DM. Strongly favor NPCs and lore entries mentioned in pinned chapters.
5. For each relevant NPC choose a detail level:
   - "full": likely to speak or act in the next reply, OR their motives, abilities or reactions matter to it (even if not present).
   - "brief": merely mentioned, or present but in the background.
   Being [present] alone does NOT require "full".
6. Refer to NPCs by their roster handle (N1, N2, ...).
7. Output format: {"npcs": [{"id": "N1", "detail": "full"}, {"id": "N4", "detail": "brief"}], "lore": ["id1", "id2"]}
If nothing is relevant, return: {"npcs": [], "lore": []}`,

    JSON_ONLY_FOOTER,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
);

/**
 * Calls the utility AI endpoint to determine which NPCs and lore chunks
 * are relevant to the current conversation context.
 *
 * @throws on network/API errors — caller MUST catch and fall back to substring scan.
 */
export async function recommendContext(
    utilityEndpoint: LLMProvider,
    npcLedger: NPCEntry[],
    loreChunks: LoreChunk[],
    messages: ChatMessage[],
    userMessage: string,
    pinnedChapters?: ArchiveChapter[],
    timeoutMs?: number,
    onStageNpcIds?: string[],
): Promise<RecommenderResult> {
    const startTime = Date.now();
    const { text: npcRoster, handles } = buildNPCRoster(npcLedger, onStageNpcIds);
    const loreIndex = buildLoreIndex(loreChunks);
    const conversation = buildConversationExcerpt(messages, userMessage);

    const pinnedSection = (pinnedChapters && pinnedChapters.length > 0)
        ? `[DM-PINNED CHAPTERS — manually selected as relevant]\n${buildPinnedChapterContext(pinnedChapters)}`
        : '';

    const userContent = joinPromptSections(
        RECOMMENDER_PROMPT_STATIC,
        `[NPC ROSTER — ${npcLedger.length} characters]\n${npcRoster}`,
        `[LORE INDEX — ${loreChunks.filter(c => !c.alwaysInclude).length} entries]\n${loreIndex}`,
        pinnedSection,
        `[RECENT CONVERSATION]\n${conversation}`,
    );

    console.log(`[ContextRecommender] Sending recommendation request to ${utilityEndpoint.modelName}...`);

    let rawContent: string;
    try {
        rawContent = await llmCall(utilityEndpoint, userContent, {
            temperature: 0.1,
            // A full 30-NPC roster + lore picks is ~600 tokens; the cap stops a runaway reply.
            maxTokens: 1024,
            priority: 'high',
            thinkingEffort: 'off',
            ...(timeoutMs ? { timeoutMs, trackingLabel: 'recommender' } : {}),
        });
    } catch (err) {
        const elapsed = Date.now() - startTime;
        console.warn(`[NPC] recommender failed — falling back to substring scan (elapsed=${elapsed}ms)`, err);
        throw err;
    }

    // Parse the JSON response — handle <think> blocks and markdown wrapping
    let cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = cleanContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) cleanContent = mdMatch[1];

    // Find JSON object in the response
    const jsonStart = cleanContent.indexOf('{');
    const jsonEnd = cleanContent.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        console.warn('[ContextRecommender] Failed to find JSON in response:', rawContent.slice(0, 200));
        throw new Error('No valid JSON in recommender response');
    }

    const parsed = JSON.parse(cleanContent.substring(jsonStart, jsonEnd + 1));

    const npcs = parseRecommendedNPCs(parsed.npcs, handles, npcLedger);
    const result: RecommenderResult = {
        relevantNPCNames: npcs.names,
        relevantLoreIds: Array.isArray(parsed.lore) ? parsed.lore.filter((n: unknown) => typeof n === 'string') : [],
        npcDetail: npcs.detail,
    };

    console.log(`[ContextRecommender] Recommended ${result.relevantNPCNames.length} NPCs, ${result.relevantLoreIds.length} lore entries.`);
    const elapsed = Date.now() - startTime;
    const detailStr = Object.entries(result.npcDetail)
        .map(([id, lv]) => `${npcLedger.find(n => n.id === id)?.name ?? id}:${lv}`).join(',');
    console.log(`[NPC] recommender returned=[${result.relevantNPCNames.join(',')}] detail=[${detailStr}] roster_size=${npcLedger.length} elapsed=${elapsed}ms`);

    return result;
}
