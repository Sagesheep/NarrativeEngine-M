import type { ChatMessage, LLMProvider } from '../../types';
import { llmCall } from '../llm/llmCall';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    joinPromptSections,
} from '../infrastructure';

export async function scanInventory(
    provider: LLMProvider,
    messages: ChatMessage[],
    currentInventory: string
): Promise<string> {
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentInventory;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const prompt = joinPromptSections(
        'You are an AI game engine parser responsible for maintaining the player\'s inventory.',

        `TASK: Review the recent chat history and the current inventory list below. Identify any items, currency, or equipment the player recently acquired or lost.

INSTRUCTIONS:
1. Analyze the chat history for explicit gains or losses of items/money.
2. Update the "CURRENT INVENTORY" list accordingly.
3. Output ONLY the updated, comprehensive inventory list.
4. Format as a clean markdown list (e.g., bullet points or categorized sections).
5. DO NOT include any conversational text, explanations, or markdown formatting outside of the list itself. If nothing changed, return the current inventory exactly as is.`,

        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `=== CURRENT INVENTORY ===\n${currentInventory || '(Empty)'}`,
        `=== RECENT CHAT HISTORY ===\n${turns}`,
    );

    try {
        const result = await llmCall(provider, prompt, { priority: 'low' });
        return result.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
    } catch (e) {
        console.error('[InventoryParser]', e);
        throw e;
    }
}
