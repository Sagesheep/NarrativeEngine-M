import type { LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';
import { extractJson } from './payloadBuilder';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ARRAY_ONLY_FOOTER,
    joinPromptSections,
} from './utilityPrompts';

/**
 * AI-powered tag population for Surprise & World engines.
 * Sends current tags + world lore to the AI, returns 3-12 contextually relevant tags.
 */
export async function populateEngineTags(
    provider: LLMProvider,
    worldLore: string,
    currentTags: string[],
    field: 'surpriseTypes' | 'surpriseTones' | 'encounterTypes' | 'encounterTones' | 'worldWho' | 'worldWhere' | 'worldWhy' | 'worldWhat'
): Promise<string[]> {
    const fieldDescriptions: Record<typeof field, string> = {
        surpriseTypes: 'mundane world-flavor event TYPES (e.g. STREET_DRAMA, FOUND_OBJECT, VENDOR_DISPUTE). These are everyday ambient moments that add texture — NOT combat or major events. The GM AI resolves the genre-specific detail from context.',
        surpriseTones: 'surprise event TONES (e.g. MUNDANE, AMUSING, AWKWARD, CURIOUS). These describe the emotional flavor of the everyday moment.',
        encounterTypes: 'encounter SITUATION TYPES (e.g. HOSTILE_PRESENCE, TERRITORIAL_THREAT, PATROL_CONFRONTATION). These are threat archetypes — do NOT name specific enemies. The GM AI will resolve the actual enemy from the current location context.',
        encounterTones: 'encounter event TONES (e.g. TENSE, DESPERATE, SUDDEN, PREDATORY). These describe the emotional flavor of the threat situation.',
        worldWho: '"Who" elements for world rumours — the person spreading or involved in the hook (e.g. "a passing merchant", "a frightened local", "a wounded survivor"). Keep it grounded and local.',
        worldWhere: '"Where" elements for world rumours — a local/regional area, NOT world-scale locations (e.g. "on the northern road", "near the old ruins", "at the river crossing").',
        worldWhy: '"Why it matters" elements for world rumours — the hook or stakes (e.g. "and a reward is offered", "hinting at treasure involved", "and locals are too frightened to investigate").',
        worldWhat: '"What happened" elements for world rumours — the inciting action that creates a quest hook (e.g. "spotted raiders near", "claims something was found at", "saw lights moving around"). These should create hooks, NOT permanent world-state changes.',
    };

    const prompt = joinPromptSections(
        'You are a Campaign Tag Generator.',

        `TASK: Analyze the provided WORLD LORE and CURRENT TAGS, then generate contextually appropriate tags that fit this specific campaign's theme, factions, locations, and tone.

[FIELD TO GENERATE]
${fieldDescriptions[field]}`,

        `RULES:
- Generate MINIMUM 3 and MAXIMUM 12 tags.
- Tags must be thematically appropriate for this specific campaign world.
- Keep the same format style as the current tags (uppercase for surprise types/tones, descriptive phrases for world engine).
- Do NOT repeat any current tags verbatim — generate NEW ones inspired by the lore.`,

        JSON_ARRAY_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `[CURRENT TAGS — Use as reference for format and style]\n${currentTags.join(', ')}`,
        `[WORLD LORE — Use to make tags thematically relevant]\n${worldLore.slice(0, 6000)}`,
    );

    const fullJsonStr = await llmCall(provider, prompt, { priority: 'low' });

    if (fullJsonStr) {
        const cleanStr = extractJson(fullJsonStr);
        try {
            const parsed = JSON.parse(cleanStr);
            if (Array.isArray(parsed) && parsed.length >= 3 && parsed.every((t: unknown) => typeof t === 'string')) {
                console.log(`[Tag Populator] Generated ${parsed.length} tags for ${field}:`, parsed);
                return parsed.slice(0, 12);
            }
        } catch (e) {
            console.error('[Tag Populator] Failed to parse JSON:', e, '\nRaw:', cleanStr);
        }
    }

    return currentTags; // Fallback to current tags if generation fails
}
