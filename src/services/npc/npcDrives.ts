/**
 * NPC drives — extracted from npcGeneration.ts (W10).
 * Personality translation, long-want generation, drives backfill.
 */

import type { LLMProvider, NPCEntry, PersonalityHex } from '../../types';
import { validatePersonalityHex, defaultLongWant, HEX_AXIS_LEGEND } from './npcValidator';
import { llmParseJson } from './npcShared';
import {
    ANCHOR_BEFORE_INPUT, INPUT_DELIMITER, JSON_ONLY_FOOTER,
    TTRPG_PERSONA_GM_ASSISTANT, TTRPG_PERSONA_STATE_ANALYZER,
    DRIVES_UPDATE_RULES, joinPromptSections,
} from '../infrastructure';

export async function translatePersonalityToHex(provider: LLMProvider, personalityText: string): Promise<PersonalityHex> {
    if (!personalityText || !personalityText.trim()) return validatePersonalityHex(null);
    const prompt = joinPromptSections(
        `${TTRPG_PERSONA_STATE_ANALYZER} Rate a character on six personality axes based on the description.`,
        HEX_AXIS_LEGEND,
        `OUTPUT FORMAT — a single JSON object with exactly these integer keys:
{"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0}`,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
        `[PERSONALITY]\n${personalityText}\n[END PERSONALITY]`,
    );
    const parsed = await llmParseJson<Record<string, unknown>>(provider, prompt, 'NPC Hex Translate');
    return validatePersonalityHex(parsed);
}

export async function generateLongWant(
    provider: LLMProvider,
    npc: { name: string; personality?: string; faction?: string; goals?: string; storyRelevance?: string },
    ctx?: { recentContext?: string },
): Promise<string> {
    const profile = `Name: ${npc.name}\nFaction: ${npc.faction || 'Unknown'}\nPersonality: ${npc.personality || 'Unknown'}\nGoals: ${npc.goals || 'Unknown'}\nStory Relevance: ${npc.storyRelevance || 'Unknown'}`;
    const prompt = joinPromptSections(
        `${TTRPG_PERSONA_GM_ASSISTANT} Give this NPC ONE long-term life goal — the ambition that drives them across the whole campaign. Ground it in their bio and faction. Archetypes to draw from: ascend to power, become the strongest, avenge/restore, transcend/transform.`,
        `OUTPUT FORMAT — a single JSON object:
{"longWant": "String — ONE concise clause naming the long-term goal. No preamble, no trailing period required."}`,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
        `[NPC PROFILE]\n${profile}\n[END PROFILE]`,
        ctx?.recentContext ? `[RECENT CONTEXT]\n${ctx.recentContext}\n[END CONTEXT]` : '',
    );
    const parsed = await llmParseJson<{ longWant?: unknown }>(provider, prompt, `NPC Long Want/${npc.name}`);
    const want = parsed && typeof parsed.longWant === 'string' ? parsed.longWant.trim() : '';
    return want || defaultLongWant(npc.faction || '');
}

export function topUpWants(existing: string[], drawn: string[], target: number): string[] {
    const out = [...existing];
    for (const d of drawn) {
        if (out.length >= target) break;
        if (!out.includes(d)) out.push(d);
    }
    return out;
}

export async function backfillNPCDrives(
    provider: LLMProvider,
    history: { role: string; content: string }[],
    npcsNeedingDrives: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void,
): Promise<void> {
    if (!npcsNeedingDrives.length) return;
    console.log(`[NPC Drives Backfill] Populating drives for ${npcsNeedingDrives.length} legacy NPC(s)...`);
    const recentContext = history.slice(-10).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    for (const npc of npcsNeedingDrives) {
        const npcSummary = `Name: ${npc.name}\nPersonality: ${npc.personality || npc.disposition || 'Unknown'}\nVoice: ${npc.voice || 'Unknown'}\nGoals: ${npc.goals || 'Unknown'}\nFaction: ${npc.faction || 'Unknown'}\nAffinity: ${npc.affinity ?? 50}/100\nStory Relevance: ${npc.storyRelevance || 'Unknown'}`;
        const prompt = joinPromptSections(
            `${TTRPG_PERSONA_GM_ASSISTANT} An existing NPC in a TTRPG campaign needs their drives, behavioral triggers, and boundaries populated.`,
            `OUTPUT FORMAT — respond with a JSON object:
{
  "coreWant": "String — one sentence: a deep character truth this NPC carries (NOT a goal).",
  "sessionWant": "String — one sentence: what this NPC is working toward in the current arc.",
  "sceneWant": "String — one sentence: what this NPC wants from the most recent scene.",
  "behavioralTriggers": [{"keyword": "String", "shift": "String — PHYSICAL/VERBAL behavioral shift (NOT emotion)."}],
  "hardBoundaries": ["String — something this NPC will never do"],
  "softBoundaries": ["String — something this NPC dislikes but may tolerate"]
}`,
            DRIVES_UPDATE_RULES, JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
            `[NPC PROFILE]\n${npcSummary}\n[END PROFILE]`,
            `[RECENT GAME CONTEXT]\n${recentContext}\n[END CONTEXT]`,
        );
        try {
            const parsed = await llmParseJson<Record<string, unknown>>(provider, prompt, `NPC Drives Backfill/${npc.name}`);
            if (parsed) {
                const patch: Partial<NPCEntry> = {
                    drives: {
                        coreWant: (parsed.coreWant as string) || `${npc.name} wants to prove their worth`,
                        sessionWant: (parsed.sessionWant as string) || `${npc.name} is looking for opportunity`,
                        sceneWant: (parsed.sceneWant as string) || `${npc.name} is observing the situation`,
                    },
                    behavioralTriggers: Array.isArray(parsed.behavioralTriggers)
                        ? parsed.behavioralTriggers.filter((t: Record<string, unknown>) => t.keyword && t.shift).map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }))
                        : [],
                    hardBoundaries: Array.isArray(parsed.hardBoundaries) ? parsed.hardBoundaries.map(String).filter(Boolean) : [],
                    softBoundaries: Array.isArray(parsed.softBoundaries) ? parsed.softBoundaries.map(String).filter(Boolean) : [],
                };
                updateNPCStore(npc.id, patch);
                console.log(`[NPC Drives Backfill] Populated drives for ${npc.name}:`, patch.drives);
            }
        } catch (err) {
            console.error(`[NPC Drives Backfill] Failed for ${npc.name}:`, err);
        }
    }
}
