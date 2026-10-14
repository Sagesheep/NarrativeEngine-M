import type { ChatMessage, PinnedExcerpt } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';

export function buildPinnedMemoriesBlock(pinnedExcerpts: PinnedExcerpt[], messages: ChatMessage[]): string {
    const msgSceneMap = new Map<string, string>();
    for (const m of messages) {
        const sceneNum = (m as Record<string, unknown>).sceneNumber;
        if (sceneNum) msgSceneMap.set(m.id, String(sceneNum));
    }
    const lines = pinnedExcerpts.map(e => {
        const scene = msgSceneMap.get(e.sourceMessageId);
        return scene ? `- "${e.text}" — scene ${scene}` : `- "${e.text}"`;
    });
    return `[PINNED MEMORIES]\n${lines.join('\n')}`;
}

const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>\s*/gi;

/** Tokens left for history once the non-history content and the user message are placed. */
export function computeHistoryBudget(userMessage: string, reservedTokens: number, limit: number): number {
    const reservedTotal = reservedTokens + countTokens(userMessage);
    // Proportional safety margin (was a flat 200): cl100k undercounts local
    // model tokenizers ~10-20%, so the margin scales with the limit (AUDIT F10).
    // Clamp at 0 so a heavy preamble can't produce a negative budget that the
    // loop would misread (AUDIT F6).
    const margin = Math.max(200, Math.floor(limit * 0.05));
    return Math.max(0, limit - reservedTotal - margin);
}

/**
 * Granularity of the history window's oldest edge, as a share of the context limit.
 * Once history outgrows its budget, the window drops old messages a block at a time
 * instead of one or two per turn, so its first message (and with it the provider's
 * prompt cache over the history) stays put for several turns. Measured against the
 * context limit, not the per-turn history budget, so the block edges don't move
 * when the world blocks change size from turn to turn.
 */
const HISTORY_ANCHOR_PCT = 0.10;

export function fitHistory(
    history: ChatMessage[],
    condensedUpToIndex: number | undefined,
    userMessage: string,
    reservedTokens: number,
    limit: number,
): { fitted: OpenAIMessage[]; historyUsed: number; userTokens: number; historyBudget: number } {
    const userTokens = countTokens(userMessage);
    const historyBudget = computeHistoryBudget(userMessage, reservedTokens, limit);

    const candidateMessages = (condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const entries: { msg: OpenAIMessage; cost: number }[] = [];
    for (const msg of candidateMessages) {
        if (msg.role === 'tool') continue;
        // An assistant message with tool_calls but NO content is a pure tool-call
        // envelope — skip it (its matching tool result is skipped on the line above).
        // BUT: when the GM emits story text TOGETHER WITH an update_scene_notebook
        // tool call, the assistant message has BOTH content and tool_calls. The
        // trailing tool-role message is skipped above, so we must drop tool_calls
        // here too — otherwise the API sees a dangling tool_call with no matching
        // tool result. Keeping the content preserves the story in fitted history.
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            if (!msg.content || (typeof msg.content === 'string' && !msg.content.trim())) continue;
        }
        if (msg.name === 'scene-marker') continue;

        let content = msg.content ?? null;
        if (msg.role === 'user' && typeof content === 'string') {
            content = content.replace(/\n?\[(?:DICE OUTCOMES:|SURPRISE EVENT:|ENCOUNTER EVENT:|WORLD_EVENT:|LOOT DROP:|INJECTED EVENT —)[^\]]*\]/g, '');
        }
        if (msg.role === 'assistant' && typeof content === 'string') {
            content = content.replace(THINK_TAG_REGEX, '').trim() || content;
        }

        const openAIMsg = {
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content,
            ...(msg.name ? { name: msg.name } : {}),
            ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
        } as OpenAIMessage;

        entries.push({ msg: openAIMsg, cost: countTokens(content || '') });
    }

    // Newest-first fill: the oldest message that still fits.
    let start = entries.length;
    let budgetLeft = historyBudget;
    while (start > 0 && entries[start - 1].cost <= budgetLeft) {
        start--;
        budgetLeft -= entries[start].cost;
    }
    if (start > 0) start = snapToAnchor(entries, start, Math.max(1, Math.floor(limit * HISTORY_ANCHOR_PCT)));

    const kept = entries.slice(start);
    const fitted = kept.map(e => e.msg);
    const historyUsed = kept.reduce((sum, e) => sum + e.cost, 0);

    while (fitted.length > 0 && fitted[0].role === 'tool') fitted.shift();

    return { fitted, historyUsed, userTokens, historyBudget };
}

/**
 * Moves a window start forward to the first message that opens a new
 * `blockTokens`-sized block, counting from the oldest candidate message. Block
 * edges depend only on the messages themselves, so the same start is chosen turn
 * after turn until the window has to move past it. Returns `start` unchanged when
 * no block opens before the newest message.
 */
function snapToAnchor(entries: { cost: number }[], start: number, blockTokens: number): number {
    let before = 0;
    for (let i = 0; i < entries.length; i++) {
        const block = Math.floor(before / blockTokens);
        if (i >= start && (i === 0 || block > Math.floor((before - entries[i - 1].cost) / blockTokens))) return i;
        before += entries[i].cost;
    }
    return start;
}

export function pinnedExcerptsTokenCost(pinnedExcerpts: PinnedExcerpt[]): number {
    if (!pinnedExcerpts || pinnedExcerpts.length === 0) return 0;
    const block = buildPinnedMemoriesBlock(pinnedExcerpts, []);
    return countTokens(block);
}