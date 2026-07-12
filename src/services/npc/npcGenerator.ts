/**
 * NPC generator — extracted from npcGeneration.ts (W10).
 * NPC profile generation: propose → roll → render.
 */

import type { LLMProvider, ChatMessage, NPCEntry } from '../../types';
import { uid } from '../../utils/uid';
import { drawUnusedName, lookupCultures, genderOf } from './nameBank';
import { drawShortWants, drawMediumWants } from './agencyWantDraw';
import { affinityToPcRelation, describeHex } from './agencyBands';
import { buildGoalsFromWants } from './agencyGoals';
import { GROUP_KEYS } from './dispositionGroups';
import { rollHex, pickGroups, drawConsistentTraits, rollLooksTier } from './hexRoll';
import { buildVoiceDirective } from './hexVoiceGuide';
import { COMBAT_TIER_ARCHETYPE_RUBRIC } from './npcDetector';
import { KNOWN_TRAITS, offeredTraitNames, defaultLongWant } from './npcValidator';
import { llmParseJson, checkNameCollision, buildDefaultFieldTags } from './npcShared';
import { embedAndStoreNPC } from './npcEmbedding';
import {
    ANCHOR_BEFORE_INPUT, INPUT_DELIMITER, JSON_ONLY_FOOTER,
    TTRPG_PERSONA_GM_ASSISTANT, joinPromptSections,
} from '../infrastructure';

type ProposeResult = { candidateGroups: string[]; anchorTraits: string[] };

type RenderPromptOpts = {
    npcName: string;
    recentHistory: string;
    existingLedger: NPCEntry[] | undefined;
    matureMode: boolean;
    primaryGroup: string;
    secondaryGroup: string | undefined;
    hexBandLine: string;
    looksTier: 'attractive' | 'plain' | 'ugly';
    voiceDirective: string;
};

async function proposeGroupsAndTraits(
    provider: LLMProvider,
    recentHistory: string,
    existingLedger: NPCEntry[] | undefined,
    matureMode: boolean,
): Promise<ProposeResult> {
    const fallback: ProposeResult = { candidateGroups: Array.from(GROUP_KEYS), anchorTraits: [] };
    const rosterLine = existingLedger && existingLedger.length > 0
        ? `EXISTING ROSTER (for contrast — propose groups that distinguish this NPC from these): ${existingLedger.map(n => n.name).join(', ')}`
        : '';
    const prompt = joinPromptSections(
        `${TTRPG_PERSONA_GM_ASSISTANT} Your job is to propose a set of scene-appropriate SOCIAL archetype groups for a new NPC, plus 2 anchor personality traits. You are NOT writing the NPC's profile — only picking abstract groups + traits the engine will roll inside.`,
        `SOCIAL ARCHETYPE GROUPS (pick 2–4 that plausibly appear in this scene; these are SETTING-AGNOSTIC personality templates, NOT combat roles): ${Array.from(GROUP_KEYS).join(', ')}.`,
        `ANCHOR TRAITS (pick exactly 2 from this controlled vocabulary${matureMode ? ' (mature allowed)' : ' (mature tier NOT allowed)'}): ${offeredTraitNames(matureMode).join(', ')}.`,
        `OUTPUT FORMAT — a single JSON object, no other text:
{"candidateGroups": ["group1", "group2", ...], "anchorTraits": ["trait1", "trait2"]}`,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
        rosterLine,
        `[RECENT SCENE]\n${recentHistory}\n[END SCENE]`,
    );
    try {
        const parsed = await llmParseJson<Record<string, unknown>>(provider, prompt, 'NPC Propose');
        if (!parsed) return fallback;
        const candidateGroups = Array.isArray(parsed.candidateGroups)
            ? (parsed.candidateGroups as unknown[]).map(g => String(g).toLowerCase().trim()).filter(Boolean)
            : [];
        const anchorTraits = Array.isArray(parsed.anchorTraits)
            ? (parsed.anchorTraits as unknown[]).map(g => String(g).toLowerCase().trim()).filter(Boolean)
            : [];
        return { candidateGroups, anchorTraits };
    } catch (err) {
        console.warn('[NPC Propose] Falling back to all GROUP_KEYS + no anchors:', err);
        return fallback;
    }
}

function buildRenderPrompt(opts: RenderPromptOpts): string {
    const { npcName, recentHistory, existingLedger, matureMode, primaryGroup, secondaryGroup, hexBandLine, looksTier, voiceDirective } = opts;
    const systemPrompt = joinPromptSections(
        `${TTRPG_PERSONA_GM_ASSISTANT} Your job is to RENDER a profile for a new character whose personality skeleton has ALREADY BEEN ROLLED by the engine. You receive the rolled personality (as band-words), the archetype groups, the looks tier, and per-axis voice direction. Express these as vivid world-appropriate prose.`,
        `ROLLED SKELETON (engine-authored — treat as fixed truth; do NOT contradict):
- Primary social group: ${primaryGroup}
- Secondary social group (trajectory): ${secondaryGroup ?? 'none'}
- Personality (band-words): ${hexBandLine}
- Looks tier: ${looksTier}`,
        voiceDirective ? `VOICE DIRECTION (axis extremes — the exampleOutput/voice MUST express these):\n${voiceDirective}` : '',
        `OUTPUT FORMAT — respond with a JSON object matching this structure exactly:
{
  "name": "String", "aliases": "String", "status": "String", "faction": "String",
  "storyRelevance": "String", "disposition": "String", "goals": "String",
  "voice": "String", "appearance": "String", "personality": "String",
  "exampleOutput": "String",
  "drives": {"coreWant": "String", "sessionWant": "String", "sceneWant": "String"},
  "behavioralTriggers": [{"keyword": "String", "shift": "String"}],
  "hardBoundaries": ["String"], "softBoundaries": ["String"],
  "tier": "String", "combatTier": "String", "archetype": "String",
  "longWant": "String", "region": "String"
}
IMPORTANT: Do NOT emit a "personalityHex" field, numeric axis values, or a "traits" array. The engine has already rolled the personality hexagon and chosen the traits; you only render flavour. Numeric personality output will be discarded.`,
        `CONTROLLED TRAIT VOCABULARY — for reference only: ${offeredTraitNames(matureMode).join(', ')}.`,
        COMBAT_TIER_ARCHETYPE_RUBRIC,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
    );
    const reservedNames = (existingLedger ?? []).map(n => n.name?.trim()).filter(Boolean);
    const reservedNamesSection = reservedNames.length > 0
        ? `RESERVED NAMES — already used by existing characters. The profile's "name" and "aliases" must NOT collide with any of these: ${reservedNames.join(', ')}`
        : '';
    return joinPromptSections(systemPrompt, `NPC NAME: "${npcName}"`, reservedNamesSection, `RECENT CHAT HISTORY:\n${recentHistory}`);
}

export async function generateNPCProfile(
    provider: LLMProvider,
    history: ChatMessage[],
    npcName: string,
    addNPCToStore: (npc: NPCEntry) => void,
    existingLedger?: NPCEntry[],
    campaignId?: string,
    matureMode: boolean = false,
    rng: () => number = Math.random,
): Promise<void> {
    try {
        console.log(`[NPC Generator] Initiating background profile generation for: ${npcName}`);
        const recentHistory = history.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

        const proposal = await proposeGroupsAndTraits(provider, recentHistory, existingLedger, matureMode);
        const validGroups = proposal.candidateGroups.filter(k => (GROUP_KEYS as readonly string[]).includes(k));
        const candidateGroups = validGroups.length > 0 ? Array.from(new Set(validGroups)) : Array.from(GROUP_KEYS);
        const anchorTraits = proposal.anchorTraits.filter(t => KNOWN_TRAITS.has(t)).slice(0, 2);

        const { primary, secondary } = pickGroups(candidateGroups, rng);
        const rolledHex = rollHex(primary, secondary, anchorTraits, rng);
        const drawnTraits = drawConsistentTraits(rolledHex, anchorTraits, rng, matureMode);
        const finalTraits = [...anchorTraits, ...drawnTraits].slice(0, 5);
        const looksTier = rollLooksTier(rng);
        const voiceDirective = buildVoiceDirective(rolledHex);
        const hexBandLine = describeHex(rolledHex);

        const renderPrompt = buildRenderPrompt({
            npcName, recentHistory, existingLedger, matureMode,
            primaryGroup: primary, secondaryGroup: secondary,
            hexBandLine, looksTier, voiceDirective,
        });

        const parsed = await llmParseJson<Record<string, unknown>>(provider, renderPrompt, 'NPC Generator');

        if (parsed) {
            let finalParsed = parsed;
            const resolvedName = (parsed.name as string) || npcName;
            const resolvedAliases = (parsed.aliases as string) || '';

            if (existingLedger && existingLedger.length > 0 && checkNameCollision(resolvedName, resolvedAliases, existingLedger)) {
                console.warn(`[NPC Generator] Name collision detected: "${resolvedName}". Re-prompting for disambiguation.`);
                const retryPrompt = joinPromptSections(renderPrompt, `Name "${resolvedName}" is already used by an existing NPC. Pick a different name and re-emit the JSON.`);
                const retryParsed = await llmParseJson<Record<string, unknown>>(provider, retryPrompt, 'NPC Generator (name retry)');
                if (retryParsed && !checkNameCollision((retryParsed.name as string) || resolvedName, (retryParsed.aliases as string) || '', existingLedger)) {
                    finalParsed = retryParsed;
                    console.log(`[NPC Generator] Name disambiguated to: "${(retryParsed.name as string) || resolvedName}"`);
                } else {
                    const firstTok = resolvedName.trim().split(/\s+/)[0] ?? resolvedName;
                    const exclude = new Set<string>();
                    for (const n of existingLedger) {
                        for (const raw of [n.name, ...(n.aliases || '').split(',')]) {
                            const fn = raw.trim().split(/\s+/)[0]?.toLowerCase();
                            if (fn) exclude.add(fn);
                        }
                    }
                    const drawn = drawUnusedName({ cultures: lookupCultures(firstTok), gender: genderOf(firstTok), exclude });
                    const disambiguated = drawn ?? `${resolvedName} the Younger`;
                    console.warn(`[NPC Generator] Re-prompt also collided. ${drawn ? `Drew pool name: "${disambiguated}"` : `Pool exhausted, fell back to: "${disambiguated}"`}`);
                    finalParsed = { ...parsed, name: disambiguated };
                }
            }

            const validTiers = new Set(['recurring', 'oneshot', 'walkon']);
            const rawTier = (finalParsed.tier as string) || '';
            const newEntry: NPCEntry = {
                id: uid(),
                name: (finalParsed.name as string) || npcName,
                aliases: (finalParsed.aliases as string) || '',
                status: (finalParsed.status as string) || 'Alive',
                faction: (finalParsed.faction as string) || 'Unknown',
                storyRelevance: (finalParsed.storyRelevance as string) || 'Unknown',
                appearance: (finalParsed.appearance as string) || '',
                disposition: (finalParsed.disposition as string) || 'Neutral',
                goals: (finalParsed.goals as string) || 'Unknown',
                voice: (finalParsed.voice as string) || '',
                personality: (finalParsed.personality as string) || (finalParsed.disposition as string) || 'Unknown',
                exampleOutput: (finalParsed.exampleOutput as string) || '',
                affinity: 50,
                drives: finalParsed.drives ? {
                    coreWant: ((finalParsed.drives as Record<string, string>).coreWant) || '',
                    sessionWant: ((finalParsed.drives as Record<string, string>).sessionWant) || '',
                    sceneWant: ((finalParsed.drives as Record<string, string>).sceneWant) || '',
                } : undefined,
                behavioralTriggers: Array.isArray(finalParsed.behavioralTriggers)
                    ? finalParsed.behavioralTriggers.filter((t: Record<string, unknown>) => t.keyword && t.shift).map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }))
                    : undefined,
                hardBoundaries: Array.isArray(finalParsed.hardBoundaries) ? finalParsed.hardBoundaries.map(String).filter(Boolean) : undefined,
                softBoundaries: Array.isArray(finalParsed.softBoundaries) ? finalParsed.softBoundaries.map(String).filter(Boolean) : undefined,
                tier: validTiers.has(rawTier) ? rawTier as NPCEntry['tier'] : 'oneshot',
                combatTier: (['minion', 'grunt', 'elite', 'boss', 'legendary'].includes(finalParsed.combatTier as string)) ? (finalParsed.combatTier as NPCEntry['combatTier']) : undefined,
                archetype: (['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'].includes(finalParsed.archetype as string)) ? (finalParsed.archetype as NPCEntry['archetype']) : undefined,
            };

            const longWant = (typeof finalParsed.longWant === 'string' && finalParsed.longWant.trim()) ? finalParsed.longWant.trim() : defaultLongWant(newEntry.faction);
            newEntry.traits = finalTraits;
            newEntry.wants = { short: drawShortWants({ matureMode, traits: finalTraits }), medium: drawMediumWants({ matureMode, traits: finalTraits }), long: longWant };
            newEntry.personalityHex = rolledHex;
            newEntry.primaryGroup = primary;
            newEntry.secondaryGroup = secondary;
            newEntry.region = typeof finalParsed.region === 'string' ? finalParsed.region.trim() : '';
            newEntry.populated = true;
            if (newEntry.pcRelation === undefined) { newEntry.pcRelation = affinityToPcRelation(newEntry.affinity ?? 50); }
            newEntry.fieldTags = buildDefaultFieldTags(newEntry);
            newEntry.goalRecords = buildGoalsFromWants(newEntry.wants.medium, newEntry.wants.long, finalTraits, 0);

            addNPCToStore(newEntry);
            console.log(`[NPC Generator] Successfully generated and added profile for: ${newEntry.name} (tier=${newEntry.tier}, primaryGroup=${primary}, secondaryGroup=${secondary ?? 'none'})`);

            if (campaignId) {
                embedAndStoreNPC(campaignId, newEntry).catch((e) => console.warn(`[NPC Generator] Embedding failed for ${newEntry.name}:`, e));
            }
        }
    } catch (err) {
        console.error('[NPC Generator] Fatal error during generation:', err);
    }
}
