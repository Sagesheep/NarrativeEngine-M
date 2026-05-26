import type { ChatMessage, LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    joinPromptSections,
} from './utilityPrompts';

export async function scanCharacterProfile(
    provider: LLMProvider,
    messages: ChatMessage[],
    currentProfile: string
): Promise<string> {
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentProfile;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const prompt = joinPromptSections(
        'You are an AI game engine parser responsible for maintaining the player\'s character profile and sheet.',

        `TASK: Review the recent chat history and the current character profile below. Identify any updates to the character's name, race/species, class/role, level, key abilities, powers, notable traits, or core stats (like HP/Mana) based on the recent narrative.

INSTRUCTIONS:
1. Analyze the chat history for explicit reveals, level-ups, or changes to the player's core character definition.
2. Update the "CURRENT CHARACTER PROFILE" accordingly.
3. Output ONLY the updated, comprehensive profile.
4. Format cleanly (e.g., Name/Class at the top, bullet points for Traits/Abilities/Powers).
5. DO NOT include any conversational text, explanations, or markdown formatting outside of the text itself. If nothing changed, return the current profile exactly as is.`,

        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `=== CURRENT CHARACTER PROFILE ===\n${currentProfile || '(Empty)'}`,
        `=== RECENT CHAT HISTORY ===\n${turns}`,
    );

    try {
        const result = await llmCall(provider, prompt, { priority: 'low' });
        return result.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
    } catch (e) {
        console.error('[CharacterProfileParser]', e);
        throw e;
    }
}
