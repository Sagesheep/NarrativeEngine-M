import type { LLMProvider, ChatMessage, NPCEntry, StatBlock, CombatTier, Archetype } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import { embedText, getCurrentModelId } from '../embedding';
import { embeddingStorage } from '../storage/embeddingStorage';
import {
    extractJson,
    ANCHOR_BEFORE_INPUT,
    APPEARANCE_UPDATE_RULES,
    DRIVES_UPDATE_RULES,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    TTRPG_PERSONA_GM_ASSISTANT,
    TTRPG_PERSONA_STATE_ANALYZER,
    joinPromptSections,
} from '../infrastructure';
import { COMBAT_TIER_ARCHETYPE_RUBRIC } from './npcDetector';
import { assignCombatLoadout } from './npcCombatGeneration';
import type { ItemDef, SkillDef } from '../../types';
import { getPCTier } from '../engine/pcCreationScript';

const RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

async function llmParseJson<T>(
    provider: LLMProvider,
    prompt: string,
    contextLabel: string,
): Promise<T | null> {
    const firstResponse = await llmCall(provider, prompt, { priority: 'low' });
    if (!firstResponse) return null;

    const firstClean = extractJson(firstResponse);
    try {
        return JSON.parse(firstClean) as T;
    } catch (firstErr) {
        console.warn(`[${contextLabel}] First parse failed, retrying with stricter prompt...`, firstErr);
        console.warn(`[${contextLabel}] Raw JSON was:`, firstClean);

        const retryPrompt = `${prompt}\n\nYour previous response was:\n${firstResponse}\n${RETRY_SUFFIX}`;
        const retryResponse = await llmCall(provider, retryPrompt, { priority: 'low' });
        if (!retryResponse) return null;

        const retryClean = extractJson(retryResponse);
        try {
            return JSON.parse(retryClean) as T;
        } catch (retryErr) {
            console.error(`[${contextLabel}] Retry parse also failed:`, retryErr);
            console.error(`[${contextLabel}] Retry raw JSON:`, retryClean);
            return null;
        }
    }
}

function checkNameCollision(name: string, aliasesRaw: string, ledger: NPCEntry[]): boolean {
    const normalize = (s: string) => s.toLowerCase().trim();
    const newTokens = [normalize(name), ...aliasesRaw.split(',').map(a => normalize(a)).filter(Boolean)];
    for (const existing of ledger) {
        const existingTokens = [normalize(existing.name), ...(existing.aliases || '').split(',').map(a => normalize(a)).filter(Boolean)];
        for (const nt of newTokens) {
            for (const et of existingTokens) {
                if (nt === et) return true;
            }
        }
    }
    return false;
}

export function buildNPCEmbeddingText(npc: NPCEntry): string {
    const parts = [
        npc.name,
        npc.aliases ? `aliases: ${npc.aliases}` : '',
        npc.faction ? `faction: ${npc.faction}` : '',
        npc.tier ? `tier: ${npc.tier}` : '',
        npc.appearance ? `appearance: ${npc.appearance}` : '',
        npc.personality ? `personality: ${npc.personality}` : '',
        npc.voice ? `voice: ${npc.voice}` : '',
        npc.goals ? `goals: ${npc.goals}` : '',
        npc.storyRelevance ? `storyRelevance: ${npc.storyRelevance}` : '',
    ].filter(Boolean);
    return parts.join('; ');
}

export async function embedAndStoreNPC(campaignId: string, npc: NPCEntry): Promise<void> {
    try {
        const text = buildNPCEmbeddingText(npc);
        if (!text) return;
        const vector = await embedText(text);
        if (vector) {
            await embeddingStorage.store(campaignId, npc.id, Array.from(vector), 'npc', getCurrentModelId());
        }
    } catch (e) {
        console.warn(`[NPC Embed] Failed to embed ${npc.name}:`, e);
    }
}

export async function generateNPCProfile(
    provider: LLMProvider,
    history: ChatMessage[],
    npcName: string,
    addNPCToStore: (npc: NPCEntry) => void,
    existingLedger?: NPCEntry[],
    campaignId?: string,
    existingItems?: ItemDef[],
    addItemDef?: (item: ItemDef) => void,
    existingSkills?: SkillDef[],
    addSkillDef?: (skill: SkillDef) => void,
): Promise<void> {
    try {
        console.log(`[NPC Generator] Initiating background profile generation for: ${npcName}`);

        const recentHistory = history.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

        const systemPrompt = joinPromptSections(
            `${TTRPG_PERSONA_GM_ASSISTANT} Your job is to generate a profile for a new character based on the recent chat history. If the character is barely mentioned, invent a plausible, tropes-appropriate profile that fits the current scene context.`,

            `OUTPUT FORMAT — respond with a JSON object matching this structure exactly:
{
  "name": "String (The primary name)",
  "aliases": "String (Comma separated aliases or titles)",
  "status": "String (Alive, Deceased, Missing, or Unknown)",
  "faction": "String (The faction, group, or origin this NPC belongs to)",
  "storyRelevance": "String (Why this NPC matters to the current story)",
  "disposition": "String (current mood/attitude: Helpful, Hostile, Suspicious, etc)",
  "goals": "String (Core motive)",
  "voice": "String — describe HOW this NPC speaks: sentence length, vocabulary level, verbal quirks, catchphrases, accent notes. Be specific.",
  "appearance": "String — physical description grounded in the RECENT CHAT HISTORY. Quote details mentioned in prose (hair color, clothing, distinguishing marks). If the chat history does not describe them, write a minimal trope-appropriate description and mark it as inferred with prefix '[inferred] '.",
  "personality": "String — core personality traits in plain language. What drives them? How do they treat others? What do they fear?",
  "exampleOutput": "String — one line of in-character dialogue that demonstrates their voice and personality. Include a brief action in brackets if needed.",
  "drives": {
    "coreWant": "String — one sentence: a deep character truth this NPC carries (NOT a goal). Example: 'to be seen as capable, not just loyal'",
    "sessionWant": "String — one sentence: what this NPC is working toward in the current arc. Example: 'convince the party to take the northern route'",
    "sceneWant": "String — one sentence: what this NPC wants from the immediate scene. Example: 'get the player to trust her enough to share information'"
  },
  "behavioralTriggers": [
    { "keyword": "String — a word or phrase that, when it appears in player input or narrative, activates this trigger", "shift": "String — a PHYSICAL or VERBAL behavioral shift (NOT an emotion). Good: 'crosses arms, answers in single syllables'. Bad: 'becomes angry'." }
  ],
  "hardBoundaries": ["String — something this NPC will never do. Example: 'will not betray her sister'"],
  "softBoundaries": ["String — something this NPC dislikes but may tolerate under pressure. Example: 'dislikes being excluded from plans'"],
  "tier": "String — one of: 'recurring' (named character likely to return), 'oneshot' (named but scene-bound), 'walkon' (background, minor speaking role). Default 'oneshot' if uncertain.",
  "combatTier": "String — one of: 'minion', 'grunt', 'elite', 'boss', 'legendary'. Only for NPCs who could plausibly fight. Omit if purely social/narrative.",
  "archetype": "String — one of: 'bulwark', 'assassin', 'caster', 'skirmisher', 'brute'. Only for NPCs who could plausibly fight. Omit if purely social/narrative."
}`,

            COMBAT_TIER_ARCHETYPE_RUBRIC,

            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,
        );

        const fullPrompt = joinPromptSections(
            systemPrompt,
            `NPC NAME: "${npcName}"`,
            `RECENT CHAT HISTORY:\n${recentHistory}`,
        );

        const parsed = await llmParseJson<Record<string, unknown>>(provider, fullPrompt, 'NPC Generator');

        if (parsed) {
            let finalParsed = parsed;
            const resolvedName = (parsed.name as string) || npcName;
            const resolvedAliases = (parsed.aliases as string) || '';

            if (existingLedger && existingLedger.length > 0 && checkNameCollision(resolvedName, resolvedAliases, existingLedger)) {
                console.warn(`[NPC Generator] Name collision detected: "${resolvedName}" already exists in ledger. Re-prompting for disambiguation.`);
                const retryPrompt = joinPromptSections(
                    systemPrompt,
                    `NPC NAME: "${npcName}"`,
                    `RECENT CHAT HISTORY:\n${recentHistory}`,
                    `Name "${resolvedName}" is already used by an existing NPC. Pick a different name (consider regional/family disambiguators) and re-emit the JSON.`,
                );
                const retryParsed = await llmParseJson<Record<string, unknown>>(provider, retryPrompt, 'NPC Generator (name retry)');

                if (retryParsed && !checkNameCollision((retryParsed.name as string) || resolvedName, (retryParsed.aliases as string) || '', existingLedger)) {
                    finalParsed = retryParsed;
                    console.log(`[NPC Generator] Name disambiguated to: "${(retryParsed.name as string) || resolvedName}"`);
                } else {
                    const disambiguated = resolvedName + ' the Younger';
                    console.warn(`[NPC Generator] Re-prompt also collided. Appending disambiguator: "${disambiguated}"`);
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
                hardBoundaries: Array.isArray(finalParsed.hardBoundaries)
                    ? finalParsed.hardBoundaries.map(String).filter(Boolean)
                    : undefined,
                softBoundaries: Array.isArray(finalParsed.softBoundaries)
                    ? finalParsed.softBoundaries.map(String).filter(Boolean)
                    : undefined,
                tier: validTiers.has(rawTier) ? rawTier as NPCEntry['tier'] : 'oneshot',
                combatTier: (['minion', 'grunt', 'elite', 'boss', 'legendary'].includes(finalParsed.combatTier as string))
                    ? (finalParsed.combatTier as NPCEntry['combatTier'])
                    : undefined,
                archetype: (['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'].includes(finalParsed.archetype as string))
                    ? (finalParsed.archetype as NPCEntry['archetype'])
                    : undefined,
            };

            if (newEntry.combatTier && newEntry.archetype) {
                const loadout = assignCombatLoadout(
                    newEntry.combatTier,
                    newEntry.archetype,
                    existingItems ?? [],
                    existingSkills ?? [],
                );
                newEntry.stats = loadout.stats;
                newEntry.equippedWeapon = loadout.equippedWeapon;
                newEntry.knownSkills = loadout.knownSkills;
                newEntry.inventory = loadout.inventory;
                newEntry.overrides = loadout.overrides;

                if (addItemDef && loadout.newItemDefs.length > 0) {
                    for (const itemDef of loadout.newItemDefs) {
                        addItemDef(itemDef);
                    }
                }
                if (addSkillDef && loadout.newSkillDefs.length > 0) {
                    for (const skillDef of loadout.newSkillDefs) {
                        addSkillDef(skillDef);
                    }
                }

                console.log(`[NPC Generator] Assigned combat loadout for ${newEntry.name}: weapon=${loadout.equippedWeapon}, skills=${JSON.stringify(loadout.knownSkills)}`);
            }

            addNPCToStore(newEntry);
            console.log(`[NPC Generator] Successfully generated and added profile for: ${newEntry.name} (tier=${newEntry.tier})`);

            if (campaignId) {
                embedAndStoreNPC(campaignId, newEntry).catch((e) => console.warn(`[NPC Generator] Embedding failed for ${newEntry.name}:`, e));
            }
        }

    } catch (err) {
        console.error('[NPC Generator] Fatal error during generation:', err);
    }
}

export async function updateExistingNPCs(
    provider: LLMProvider,
    history: ChatMessage[],
    npcsToCheck: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void,
    _campaignId?: string
) {
    if (!npcsToCheck.length) return;

    console.log(`[NPC Updater] Checking for attribute shifts on ${npcsToCheck.length} existing NPC(s)...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const npcDatas = npcsToCheck.map(npc => {
        let data = `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Affinity: ${npc.affinity ?? 50}/100\n` +
            `Personality: ${npc.personality || npc.disposition || 'Unknown'}\n` +
            `Voice: ${npc.voice || 'not defined'}\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`;

        if (npc.drives) {
            data += `CoreWant: ${npc.drives.coreWant || 'Unknown'}\n` +
                `SessionWant: ${npc.drives.sessionWant || 'Unknown'}\n` +
                `SceneWant: ${npc.drives.sceneWant || 'Unknown'}\n`;
        } else {
            data += `Drives: NOT YET POPULATED\n`;
        }

        if (npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
            data += `Triggers: ${npc.behavioralTriggers.map(t => `"${t.keyword}" → ${t.shift}`).join('; ')}\n`;
        }

        return data;
    }).join('\n\n');

    const prompt = joinPromptSections(
        `${TTRPG_PERSONA_STATE_ANALYZER} Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, personality, goals, disposition, faction, or relevance.`,

        `OUTPUT FORMAT — a single JSON object:

If NO changes occurred for ANY of these NPCs, respond EXACTLY with:
{"updates": []}

If ANY changes occurred, respond with:
{"updates": [{"name": "<NPC name>", "changes": { ...only the fields that changed... }}]}

Each update MUST include "name" and only the attributes that fundamentally changed (status, disposition, goals, personality, voice, appearance, affinity, faction, storyRelevance, drives). DO NOT include attributes that stayed the same.`,

        `GENERAL RULES:
- Valid statuses: Alive, Deceased, Missing, Unknown.
- "affinity" is a 0-100 scale of how much they like the player (0=Nemesis, 50=Neutral, 100=Ally). Update this if the player did something to gain or lose favor.
- Do NOT change personality or voice unless the scene contains a genuinely transformative event for this character.`,

        APPEARANCE_UPDATE_RULES,
        DRIVES_UPDATE_RULES,

        `EXAMPLES:

GOOD — NPC who died with a transformative emotional arc:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "personality": "consumed by rage in final moments, betrayed and broken", "storyRelevance": "His death sparked a rebellion"}}]}

GOOD — NPC whose immediate scene goal shifted (note: only sceneWant changed, so only sceneWant appears):
{"updates": [{"name": "Senna", "changes": {"drives": {"sceneWant": "convince the party to camp here tonight — she spotted tracks earlier and wants to investigate at dawn"}}}]}

BAD — re-emitting unchanged attributes (status/personality/voice/appearance all unchanged here):
{"updates": [{"name": "Senna", "changes": {"status": "Alive", "personality": "warm and curious", "voice": "soft alto", "appearance": "tall, dark hair", "drives": {"sceneWant": "investigate the tracks at dawn"}}}]}
Corrected: include ONLY the field that changed —
{"updates": [{"name": "Senna", "changes": {"drives": {"sceneWant": "investigate the tracks at dawn"}}}]}`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `[RECENT CONTEXT]\n${recentContext}\n[END CONTEXT]`,
        `[CURRENT NPC STATES]\n${npcDatas}\n[END STATES]`,
    );

    try {
        const parsed = await llmParseJson<{ updates?: Array<{ name?: string; changes?: Partial<NPCEntry> }> }>(provider, prompt, 'NPC Updater');

        if (parsed?.updates && Array.isArray(parsed.updates)) {
            for (const update of parsed.updates) {
                if (!update.name || !update.changes) continue;

                const targetNpc = npcsToCheck.find(n =>
                    n.name?.toLowerCase() === update.name!.toLowerCase() ||
                    (n.aliases && n.aliases.toLowerCase().includes(update.name!.toLowerCase()))
                );

                if (targetNpc) {
                    const changes = { ...update.changes };

                    const hasPersonalityChange = changes.personality !== undefined || changes.voice !== undefined;
                    const hasAffinityChange = changes.affinity !== undefined;

                    if (hasPersonalityChange || hasAffinityChange) {
                        changes.previousSnapshot = {
                            personality: targetNpc.personality || targetNpc.disposition || '',
                            voice: targetNpc.voice || '',
                            affinity: targetNpc.affinity,
                        };
                        changes.shiftTurnCount = 0;
                    } else if (targetNpc.shiftTurnCount !== undefined && targetNpc.shiftTurnCount < 3) {
                        changes.shiftTurnCount = (targetNpc.shiftTurnCount || 0) + 1;
                    }

                    if (changes.drives && typeof changes.drives === 'object') {
                        const existingDrives = targetNpc.drives || { coreWant: '', sessionWant: '', sceneWant: '' };
                        changes.drives = {
                            coreWant: (changes.drives as Record<string, string>).coreWant || existingDrives.coreWant,
                            sessionWant: (changes.drives as Record<string, string>).sessionWant || existingDrives.sessionWant,
                            sceneWant: (changes.drives as Record<string, string>).sceneWant || existingDrives.sceneWant,
                        };
                    }

                    if (Array.isArray(changes.behavioralTriggers)) {
                        changes.behavioralTriggers = changes.behavioralTriggers
                            .filter((t: Record<string, unknown>) => t.keyword && t.shift)
                            .map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }));
                    }

                    if (Array.isArray(changes.hardBoundaries)) {
                        changes.hardBoundaries = changes.hardBoundaries.map(String).filter(Boolean);
                    }

                    if (Array.isArray(changes.softBoundaries)) {
                        changes.softBoundaries = changes.softBoundaries.map(String).filter(Boolean);
                    }

                    updateNPCStore(targetNpc.id, changes);
                    console.log(`[NPC Updater] Applied changes to ${targetNpc.name}:`, changes);
                }
            }
        } else {
            console.log(`[NPC Updater] No updates required.`);
        }
    } catch (err) {
        console.error('[NPC Updater] Failed to parse generated JSON or fatal error:', err);
    }
}

export type PCCreationOverrides = {
    stats: StatBlock;
    isOP: boolean;
    archetype: Archetype;
    concept?: string;
    playstyle?: string;
    voice?: string;
    drives?: string;
};

export function mergePCWithLLMProfile(
    llmEntry: NPCEntry,
    overrides: PCCreationOverrides,
): NPCEntry {
    const combatTier: CombatTier = getPCTier(overrides.isOP);

    const merged: NPCEntry = {
        ...llmEntry,
        isPC: true,
        stats: overrides.stats,
        combatTier,
        archetype: overrides.archetype,
        condition: 'healthy',
    };

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
    existingItems?: ItemDef[],
    addItemDef?: (item: ItemDef) => void,
    existingSkills?: SkillDef[],
    addSkillDef?: (skill: SkillDef) => void,
): Promise<NPCEntry> {
    const combatTier = getPCTier(overrides.isOP);

    const recentHistory = questionnaireHistory.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const systemPrompt = joinPromptSections(
        `${TTRPG_PERSONA_GM_ASSISTANT} Your job is to generate a rich narrative profile for a PLAYER CHARACTER based on their creation questionnaire answers. Fill in personality, voice, drives, and story relevance. Do NOT generate stats — those come from the engine.`,

        `OUTPUT FORMAT — respond with a JSON object matching this structure exactly:
{
  "name": "String (The primary name — use the name provided)",
  "aliases": "String (Comma separated aliases, titles, or nicknames)",
  "status": "Alive",
  "faction": "String (The faction, group, or origin this PC belongs to)",
  "storyRelevance": "String (Why this PC matters to the story)",
  "disposition": "String (starting disposition toward the world)",
  "goals": "String (Core goal driving this character)",
  "voice": "String — describe HOW this PC speaks: sentence length, vocabulary, verbal quirks, catchphrases. Be specific and vivid.",
  "appearance": "String — physical description. Invent a plausible, evocative description fitting the character concept.",
  "personality": "String — core personality traits. What drives them? How do they treat others? What do they fear?",
  "exampleOutput": "String — one line of in-character dialogue demonstrating their voice and personality.",
  "drives": {
    "coreWant": "String — a deep character truth (NOT a goal).",
    "sessionWant": "String — what they're working toward in the first arc.",
    "sceneWant": "String — what they want from their opening scene."
  },
  "behavioralTriggers": [
    { "keyword": "String — activation phrase", "shift": "String — physical/verbal behavioral shift (NOT emotion)." }
  ],
  "hardBoundaries": ["String — something this PC will never do."],
  "softBoundaries": ["String — something this PC dislikes but may tolerate."],
  "tier": "recurring",
  "combatTier": "${combatTier}",
  "archetype": "${overrides.archetype}"
}`,

        COMBAT_TIER_ARCHETYPE_RUBRIC,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,
    );

    const fullPrompt = joinPromptSections(
        systemPrompt,
        `PLAYER CHARACTER NAME: "${pcName}"`,
        `ARCHETYPE: ${overrides.archetype}`,
        `COMBAT TIER: ${combatTier}`,
        overrides.concept ? `CONCEPT: ${overrides.concept}` : '',
        overrides.playstyle ? `PLAYSTYLE: ${overrides.playstyle}` : '',
        overrides.voice ? `VOICE: ${overrides.voice}` : '',
        overrides.drives ? `DRIVES: ${overrides.drives}` : '',
        `QUESTIONNAIRE ANSWERS:\n${recentHistory}`,
    );

    const parsed = await llmParseJson<Record<string, unknown>>(provider, fullPrompt, 'PC Generator');

    if (!parsed) {
        const fallbackEntry: NPCEntry = {
            id: uid(),
            name: pcName,
            aliases: '',
            status: 'Alive',
            faction: 'Unknown',
            storyRelevance: overrides.concept || 'A new adventurer',
            appearance: '',
            disposition: 'Neutral',
            goals: 'Unknown',
            voice: overrides.voice || '',
            personality: 'Unknown',
            exampleOutput: '',
            affinity: 50,
            drives: {
                coreWant: overrides.drives || 'To prove their worth',
                sessionWant: 'To find their place in the world',
                sceneWant: 'To make a first impression',
            },
            tier: 'recurring',
            isPC: true,
            combatTier,
            archetype: overrides.archetype,
            stats: overrides.stats,
            condition: 'healthy',
        };

        const loadout = assignCombatLoadout(combatTier, overrides.archetype, existingItems ?? [], existingSkills ?? []);
        fallbackEntry.equippedWeapon = loadout.equippedWeapon;
        fallbackEntry.knownSkills = loadout.knownSkills;
        fallbackEntry.inventory = loadout.inventory;
        fallbackEntry.overrides = loadout.overrides;
        if (addItemDef) loadout.newItemDefs.forEach(addItemDef);
        if (addSkillDef) loadout.newSkillDefs.forEach(addSkillDef);

        addNPCToStore(fallbackEntry);

        if (campaignId) {
            embedAndStoreNPC(campaignId, fallbackEntry).catch((e) => console.warn(`[PC Generator] Embedding failed for ${fallbackEntry.name}:`, e));
        }

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
        } : {
            coreWant: overrides.drives || '',
            sessionWant: '',
            sceneWant: '',
        },
        behavioralTriggers: Array.isArray(parsed.behavioralTriggers)
            ? parsed.behavioralTriggers.filter((t: Record<string, unknown>) => t.keyword && t.shift).map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }))
            : undefined,
        hardBoundaries: Array.isArray(parsed.hardBoundaries)
            ? parsed.hardBoundaries.map(String).filter(Boolean)
            : undefined,
        softBoundaries: Array.isArray(parsed.softBoundaries)
            ? parsed.softBoundaries.map(String).filter(Boolean)
            : undefined,
        tier: 'recurring',
    };

    const mergedEntry = mergePCWithLLMProfile(rawEntry, overrides);

    const loadout = assignCombatLoadout(combatTier, overrides.archetype, existingItems ?? [], existingSkills ?? []);
    mergedEntry.equippedWeapon = loadout.equippedWeapon;
    mergedEntry.knownSkills = loadout.knownSkills;
    mergedEntry.inventory = loadout.inventory;
    mergedEntry.overrides = loadout.overrides;
    if (addItemDef) loadout.newItemDefs.forEach(addItemDef);
    if (addSkillDef) loadout.newSkillDefs.forEach(addSkillDef);

    addNPCToStore(mergedEntry);

    if (campaignId) {
        embedAndStoreNPC(campaignId, mergedEntry).catch((e) => console.warn(`[PC Generator] Embedding failed for ${mergedEntry.name}:`, e));
    }

    console.log(`[PC Generator] Successfully created PC: ${mergedEntry.name} (${mergedEntry.archetype}/${mergedEntry.combatTier})`);
    return mergedEntry;
}

export async function backfillNPCDrives(
    provider: LLMProvider,
    history: ChatMessage[],
    npcsNeedingDrives: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void
): Promise<void> {
    if (!npcsNeedingDrives.length) return;

    console.log(`[NPC Drives Backfill] Populating drives for ${npcsNeedingDrives.length} legacy NPC(s)...`);

    const recentContext = history.slice(-10).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    for (const npc of npcsNeedingDrives) {
        const npcSummary = `Name: ${npc.name}\nPersonality: ${npc.personality || npc.disposition || 'Unknown'}\nVoice: ${npc.voice || 'Unknown'}\nGoals: ${npc.goals || 'Unknown'}\nFaction: ${npc.faction || 'Unknown'}\nAffinity: ${npc.affinity ?? 50}/100\nStory Relevance: ${npc.storyRelevance || 'Unknown'}`;

        const prompt = joinPromptSections(
            `${TTRPG_PERSONA_GM_ASSISTANT} An existing NPC in a TTRPG campaign needs their drives, behavioral triggers, and boundaries populated. Based on their profile and recent game context, generate these fields.`,

            `OUTPUT FORMAT — respond with a JSON object:
{
  "coreWant": "String — one sentence: a deep character truth this NPC carries (NOT a goal). Example: 'to be seen as capable, not just loyal'",
  "sessionWant": "String — one sentence: what this NPC is working toward in the current arc based on context. If unclear, invent a plausible arc goal.",
  "sceneWant": "String — one sentence: what this NPC wants from the most recent scene. Base this on the recent context if possible.",
  "behavioralTriggers": [
    { "keyword": "String — a word/phrase that activates this trigger based on their personality", "shift": "String — PHYSICAL/VERBAL behavioral shift (NOT emotion). Good: 'crosses arms, single-syllable answers'. Bad: 'becomes angry'." }
  ],
  "hardBoundaries": ["String — something this NPC will never do"],
  "softBoundaries": ["String — something this NPC dislikes but may tolerate"]
}`,

            DRIVES_UPDATE_RULES,

            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

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
                    hardBoundaries: Array.isArray(parsed.hardBoundaries)
                        ? parsed.hardBoundaries.map(String).filter(Boolean)
                        : [],
                    softBoundaries: Array.isArray(parsed.softBoundaries)
                        ? parsed.softBoundaries.map(String).filter(Boolean)
                        : [],
                };

                updateNPCStore(npc.id, patch);
                console.log(`[NPC Drives Backfill] Populated drives for ${npc.name}:`, patch.drives);
            }
        } catch (err) {
            console.error(`[NPC Drives Backfill] Failed for ${npc.name}:`, err);
        }
    }
}
