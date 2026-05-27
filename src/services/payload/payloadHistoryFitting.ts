import type { ChatMessage, GameContext, PayloadTrace, PinnedExcerpt } from '../../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';

function buildPinnedMemoriesBlock(pinnedExcerpts: PinnedExcerpt[], messages: ChatMessage[]): string {
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

export function splicePinnedMemories(
    fitted: OpenAIMessage[],
    pinnedExcerpts: PinnedExcerpt[],
    messages: ChatMessage[],
): PayloadTrace[] {
    if (!pinnedExcerpts || pinnedExcerpts.length === 0) return [];

    const blockText = buildPinnedMemoriesBlock(pinnedExcerpts, messages);
    const blockMsg: OpenAIMessage = { role: 'system', content: blockText };
    const depth = 3;

    if (fitted.length > 0) {
        const index = Math.max(0, fitted.length - depth);
        fitted.splice(index, 0, blockMsg);
    } else {
        fitted.push(blockMsg);
    }

    return pinnedExcerpts.map(e => ({
        source: `Pinned Excerpt (${e.isFullMessage ? 'full message' : 'span'})`,
        classification: 'summary' as const,
        tokens: countTokens(e.text),
        reason: `Pinned from message ${e.sourceMessageId}`,
        included: true,
        position: 'pinned_memories',
    }));
}

export function spliceSceneNote(context: GameContext, fitted: OpenAIMessage[]): PayloadTrace | null {
    if (!context.sceneNoteActive || !context.sceneNote) return null;

    const noteText = `[SCENE NOTE: VOLATILE GUIDANCE]\n${context.sceneNote}`;
    const noteMsg: OpenAIMessage = { role: 'system', content: noteText };
    const depth = context.sceneNoteDepth ?? 3;

    if (fitted.length > 0) {
        const index = Math.max(0, fitted.length - depth);
        fitted.splice(index, 0, noteMsg);
        return { source: 'Scene Note (Depth)', classification: 'scene_local', tokens: countTokens(noteText), reason: `Injected at depth ${depth}`, included: true, position: `history_at_${depth}` };
    }

    fitted.push(noteMsg);
    return { source: 'Scene Note (Fallback)', classification: 'scene_local', tokens: countTokens(noteText), reason: 'Injected after system (no history)', included: true, position: 'dynamic_suffix' };
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
    const historyBudget = limit - reservedTotal - 200;

    const candidateMessages = (condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const fitted: OpenAIMessage[] = [];
    let historyUsed = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];

        if (msg.role === 'tool') continue;
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue;
        if (msg.name === 'scene-marker') continue;

        let content = msg.content ?? null;
        if (msg.role === 'user' && typeof content === 'string') {
            content = content.replace(/\n?\[(?:DICE OUTCOMES:|SURPRISE EVENT:|ENCOUNTER EVENT:|WORLD_EVENT:)[^\]]*\]/g, '');
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