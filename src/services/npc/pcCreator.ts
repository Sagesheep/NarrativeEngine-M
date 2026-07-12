/**
 * PC creator — extracted from npcGeneration.ts (W10).
 * Player character creation: LLM profile + engine stats merge.
 */

import type { LLMProvider, ChatMessage, NPCEntry, StatBlock, CombatTier, Archetype } from '../../types';
import { uid } from '../../utils/uid';
import { getPCTier } from '../engine/pcCreationScript';
import { COMBAT_TIER_ARCHETYPE_RUBRIC } from './npcDetector';
import { llmParseJson } from './npcShared';
import { embedAndStoreNPC } from './npcEmbedding';
import {
    JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
    TTRPG_PERSONA_GM_ASSISTANT, joinPromptSections,
} from '../infrastructure';

export type PCCreationOverrides = {
    stats: StatBlock;
    isOP: boolean;
    archetype: Archetype;
    concept?: string;
    playstyle?: string;
    voice?: string;
    drives?: string;
};

export function mergePCWithLLMProfile(llmEntry: NPCEntry, overrides: PCCreationOverrides): NPCEntry {
    const combatTier: CombatTier = getPCTier(overrides.isOP);
    const merged: NPCEntry = { ...llmEntry, isPC: true, stats: overrides.stats, combatTier, archetype: overrides.archetype, condition: 'healthy' };
    if (overrides.concept) merged.storyRelevance = overrides.concept;
    if (overrides.voice && !llmEntry.voice) merged.voice = overrides.voice;
    return merged;
}

export async function generatePCProfile(
    provider: LLMProvider,
    questionnaireHistory: ChatMessage[],
    pcName: string,
    overrides: PCCreationOverrides,
    addNPCToStore: (npc: NPCEntry) => void,
    _existingLedger?: NPCEntry[],
    campaignId?: string,
): Promise<NPCEntry> {
    const combatTier = getPCTier(overrides.isOP);
    const recentHistory = questionnaireHistory.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const systemPrompt = joinPromptSections(
        `${TTRPG_PERSONA_GM_ASSISTANT} Your job is to generate a rich narrative profile for a PLAYER CHARACTER based on their creation questionnaire answers. Fill in personality, voice, drives, and story relevance. Do NOT generate stats — those come from the engine.`,
        `OUTPUT FORMAT — respond with a JSON object matching this structure exactly:
{
  "name": "String", "aliases": "String", "status": "Alive", "faction": "String",
  "storyRelevance": "String", "disposition": "String", "goals": "String",
  "voice": "String", "appearance": "String", "personality": "String", "exampleOutput": "String",
  "drives": {"coreWant": "String", "sessionWant": "String", "sceneWant": "String"},
  "behavioralTriggers": [{"keyword": "String", "shift": "String"}],
  "hardBoundaries": ["String"], "softBoundaries": ["String"],
  "tier": "recurring", "combatTier": "${combatTier}", "archetype": "${overrides.archetype}"
}`,
        COMBAT_TIER_ARCHETYPE_RUBRIC,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
    );

    const fullPrompt = joinPromptSections(
        systemPrompt,
        `PLAYER CHARACTER NAME: "${pcName}"`,
        `ARCHETYPE: ${overrides.archetype}`, `COMBAT TIER: ${combatTier}`,
        overrides.concept ? `CONCEPT: ${overrides.concept}` : '',
        overrides.playstyle ? `PLAYSTYLE: ${overrides.playstyle}` : '',
        overrides.voice ? `VOICE: ${overrides.voice}` : '',
        overrides.drives ? `DRIVES: ${overrides.drives}` : '',
        `QUESTIONNAIRE ANSWERS:\n${recentHistory}`,
    );

    const parsed = await llmParseJson<Record<string, unknown>>(provider, fullPrompt, 'PC Generator');

    if (!parsed) {
        const fallbackEntry: NPCEntry = {
            id: uid(), name: pcName, aliases: '', status: 'Alive', faction: 'Unknown',
            storyRelevance: overrides.concept || 'A new adventurer', appearance: '',
            disposition: 'Neutral', goals: 'Unknown', voice: overrides.voice || '',
            personality: 'Unknown', exampleOutput: '', affinity: 50,
            drives: { coreWant: overrides.drives || 'To prove their worth', sessionWant: 'To find their place in the world', sceneWant: 'To make a first impression' },
            tier: 'recurring', isPC: true, combatTier, archetype: overrides.archetype,
            stats: overrides.stats, condition: 'healthy',
        };
        addNPCToStore(fallbackEntry);
        if (campaignId) { embedAndStoreNPC(campaignId, fallbackEntry).catch(e => console.warn(`[PC Generator] Embedding failed:`, e)); }
        return fallbackEntry;
    }

    const rawEntry: NPCEntry = {
        id: uid(),
        name: (parsed.name as string) || pcName,
        aliases: (parsed.aliases as string) || '',
        status: 'Alive',
        faction: (parsed.faction as string) || 'Unknown',
        storyRelevance: (parsed.storyRelevance as string) || overrides.concept || 'Unknown',
        appearance: (parsed.appearance as string) || '',
        disposition: (parsed.disposition as string) || 'Neutral',
        goals: (parsed.goals as string) || 'Unknown',
        voice: (parsed.voice as string) || overrides.voice || '',
        personality: (parsed.personality as string) || '',
        exampleOutput: (parsed.exampleOutput as string) || '',
        affinity: 50,
        drives: parsed.drives ? {
            coreWant: ((parsed.drives as Record<string, string>).coreWant) || '',
            sessionWant: ((parsed.drives as Record<string, string>).sessionWant) || '',
            sceneWant: ((parsed.drives as Record<string, string>).sceneWant) || '',
        } : { coreWant: overrides.drives || '', sessionWant: '', sceneWant: '' },
        behavioralTriggers: Array.isArray(parsed.behavioralTriggers)
            ? parsed.behavioralTriggers.filter((t: Record<string, unknown>) => t.keyword && t.shift).map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }))
            : undefined,
        hardBoundaries: Array.isArray(parsed.hardBoundaries) ? parsed.hardBoundaries.map(String).filter(Boolean) : undefined,
        softBoundaries: Array.isArray(parsed.softBoundaries) ? parsed.softBoundaries.map(String).filter(Boolean) : undefined,
        tier: 'recurring',
    };

    const mergedEntry = mergePCWithLLMProfile(rawEntry, overrides);
    addNPCToStore(mergedEntry);
    if (campaignId) { embedAndStoreNPC(campaignId, mergedEntry).catch(e => console.warn(`[PC Generator] Embedding failed:`, e)); }
    console.log(`[PC Generator] Successfully created PC: ${mergedEntry.name} (${mergedEntry.archetype}/${mergedEntry.combatTier})`);
    return mergedEntry;
}
