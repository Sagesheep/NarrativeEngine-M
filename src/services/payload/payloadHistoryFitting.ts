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

export function fitHistory(
    history: ChatMessage[],
    condensedUpToIndex: number | undefined,
    userMessage: string,
    reservedTokens: number,
    limit: number,
): { fitted: OpenAIMessage[]; historyUsed: number; userTokens: number; historyBudget: number } {
    const userTokens = countTokens(userMessage);
    const reservedTotal = reservedTokens + userTokens;
    // Proportional safety margin (was a flat 200): cl100k undercounts local
    // model tokenizers ~10-20%, so the margin scales with the limit (AUDIT F10).
    // Clamp at 0 so a heavy preamble can't produce a negative budget that the
    // loop would misread (AUDIT F6).
    const margin = Math.max(200, Math.floor(limit * 0.05));
    const historyBudget = Math.max(0, limit - reservedTotal - margin);

    const candidateMessages = (condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const fitted: OpenAIMessage[] = [];
    let historyUsed = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];

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
            content = content.replace(/\n?\[(?:DICE OUTCOMES:|SURPRISE EVENT:|ENCOUNTER EVENT:|WORLD_EVENT:|LOOT DROP:)[^\]]*\]/g, '');
        }
        if (msg.role === 'assistant' && typeof content === 'string') {
            content = content.replace(THINK_TAG_REGEX, '').trim() || content;
        }

        const textToEstimate = content || '';
        const cost = countTokens(textToEstimate);
        if (historyUsed + cost > historyBudget) break;

        const openAIMsg = {
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content,
            ...(msg.name ? { name: msg.name } : {}),
            ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
        } as OpenAIMessage;

        fitted.unshift(openAIMsg);
        historyUsed += cost;
    }

    while (fitted.length > 0 && fitted[0].role === 'tool') fitted.shift();

    return { fitted, historyUsed, userTokens, historyBudget };
}

export function pinnedExcerptsTokenCost(pinnedExcerpts: PinnedExcerpt[]): number {
    if (!pinnedExcerpts || pinnedExcerpts.length === 0) return 0;
    const block = buildPinnedMemoriesBlock(pinnedExcerpts, []);
    return countTokens(block);
}