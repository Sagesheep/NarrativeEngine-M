import type { LLMProvider, ChatMessage, NPCEntry, StatBlock, CombatTier, Archetype, PersonalityHex, HexAxis, NPCWants, RelationGraph, SceneEventType } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import { embedText, getCurrentModelId } from '../embedding';
import { embeddingStorage } from '../storage/embeddingStorage';
import { drawUnusedName, lookupCultures, genderOf } from './nameBank';
import { drawShortWants, drawMediumWants } from './agencyWantDraw';
import { TRAIT_VOCAB, TRAIT_NAMES } from './agencyPools';
import { affinityToPcRelation, relationBand, describeHex } from './agencyBands';
import { RUNG_DEFAULT, RUNG_CEILING_DEFAULT, PC_RELATION_MIN, PC_RELATION_MAX, PC_RELATION_MAX_STEP } from './agencyConstants';
import { hexDelta } from './agencyDrift';
import { buildGoalsFromWants } from './agencyGoals';
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
import { getPCTier } from '../engine/pcCreationScript';

const RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

/**
 * Build default scene-type tags for an NPC's profile fields. Used by the smart
 * context injection layer (payloadWorldContext.ts) to filter which NPC fields
 * reach the GM prompt based on the planner's scene classification.
 *
 * Fields not listed here (or NPCs without fieldTags) always inject — backward
 * compatible. The tags are deliberately broad: a field tagged [social] injects
 * in any social-flavored scene, not just pure "relationship_shift" scenes.
 */
function buildDefaultFieldTags(npc: NPCEntry): Record<string, SceneEventType[]> {
    const tags: Record<string, SceneEventType[]> = {
        voice: ['relationship_shift', 'revelation', 'other'],
        hardBoundaries: ['relationship_shift', 'promise', 'betrayal'],
        softBoundaries: ['relationship_shift', 'betrayal'],
        behavioralTriggers: ['combat', 'relationship_shift', 'revelation'],
        exampleOutput: ['relationship_shift', 'other'],
        drift: ['relationship_shift', 'revelation'],
        innerState: ['relationship_shift', 'revelation', 'discovery'],
    };
    // Combat-specific fields only tagged if the NPC has them.
    if (npc.combatTier || npc.archetype || npc.stats) {
        tags.combatTier = ['combat'];
        tags.archetype = ['combat', 'discovery'];
        tags.stats = ['combat'];
    }
    return tags;
}

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

// ---- NPC Agency Phase 2: generation helpers (LLM = generation only; no dice/heat/tick) ----

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
const MATURE_TRAITS = new Set(TRAIT_VOCAB.filter(t => t.tier === 'mature').map(t => t.text));
const KNOWN_TRAITS = new Set(TRAIT_NAMES);

// The axis meanings, shared by the inline generation prompt and the standalone translator.
const HEX_AXIS_LEGEND = `PERSONALITY AXES — rate each as an INTEGER from -3 to +3 (0 = average/neutral):
- drive: -3 listless … +3 relentlessly driven
- diligence: -3 negligent … +3 exacting
- boldness: -3 timid … +3 reckless
- warmth: -3 frigid … +3 effusive
- empathy: -3 callous … +3 selfless
- composure: -3 volatile … +3 unflappable`;

/** Coerce one axis value to a clamped integer in -3..+3; non-numeric → 0. */
function clampHexValue(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-3, Math.min(3, Math.round(n)));
}

/** Validate raw model output into a full PersonalityHex; missing/garbage axes default to 0. */
export function validatePersonalityHex(raw: unknown): PersonalityHex {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const hex = {} as PersonalityHex;
    for (const axis of HEX_AXES) hex[axis] = clampHexValue(obj[axis]);
    return hex;
}

/** Filter raw model traits to the controlled vocab, gate mature-tier by matureMode, dedupe, cap 5. */
export function validateTraits(raw: unknown, matureMode: boolean): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
        const t = String(item).toLowerCase().trim();
        if (!KNOWN_TRAITS.has(t)) continue;
        if (!matureMode && MATURE_TRAITS.has(t)) continue;
        if (out.includes(t)) continue;
        out.push(t);
        if (out.length >= 5) break;
    }
    return out;
}

/** Faction-appropriate fallback long want when the model omits or returns an empty one. */
function defaultLongWant(faction: string): string {
    const f = (faction && faction.trim() && faction !== 'Unknown') ? faction.trim() : 'a name of their own';
    return `rise to a position of lasting power within ${f}`;
}

/** The trait names offered to the model, filtered by maturity tier. */
function offeredTraitNames(matureMode: boolean): string[] {
    return TRAIT_VOCAB.filter(t => matureMode || t.tier !== 'mature').map(t => t.text);
}

/**
 * §9.2 #5 — translate free-text personality into the 6-axis hexagon. Utility/generation model.
 * Always returns a valid clamped hex (zeros on empty input or parse failure).
 */
export async function translatePersonalityToHex(
    provider: LLMProvider,
    personalityText: string,
): Promise<PersonalityHex> {
    if (!personalityText || !personalityText.trim()) return validatePersonalityHex(null);

    const prompt = joinPromptSections(
        `${TTRPG_PERSONA_STATE_ANALYZER} Rate a character on six personality axes based on the description.`,
        HEX_AXIS_LEGEND,
        `OUTPUT FORMAT — a single JSON object with exactly these integer keys:
{"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0}`,
        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,
        `[PERSONALITY]\n${personalityText}\n[END PERSONALITY]`,
    );

    const parsed = await llmParseJson<Record<string, unknown>>(provider, prompt, 'NPC Hex Translate');
    return validatePersonalityHex(parsed);
}

/**
 * §9.8 E2 — ground ONE long-term goal against bio + faction. Utility/generation model.
 * Always returns a non-empty string (faction-appropriate default on parse failure).
 */
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
        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,
        `[NPC PROFILE]\n${profile}\n[END PROFILE]`,
        ctx?.recentContext ? `[RECENT CONTEXT]\n${ctx.recentContext}\n[END CONTEXT]` : '',
    );

    const parsed = await llmParseJson<{ longWant?: unknown }>(provider, prompt, `NPC Long Want/${npc.name}`);
    const want = parsed && typeof parsed.longWant === 'string' ? parsed.longWant.trim() : '';
    return want || defaultLongWant(npc.faction || '');
}

export async function generateNPCProfile(
    provider: LLMProvider,
    history: ChatMessage[],
    npcName: string,
    addNPCToStore: (npc: NPCEntry) => void,
    existingLedger?: NPCEntry[],
    campaignId?: string,
    matureMode: boolean = false,
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
  "archetype": "String — one of: 'bulwark', 'assassin', 'caster', 'skirmisher', 'brute'. Only for NPCs who could plausibly fight. Omit if purely social/narrative.",
  "longWant": "String — ONE long-term life ambition driving this NPC across the whole campaign, grounded in their bio/faction. Archetypes: ascend to power, become the strongest, avenge/restore, transcend/transform.",
  "traits": ["String — up to 5 personality traits, each chosen ONLY from the CONTROLLED TRAIT VOCABULARY below. Omit any that don't fit; never invent new ones."],
  "personalityHex": {"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0},
  "region": "String — the NPC's coarse home or current location if discernible from context (e.g. 'Ryuten', 'the academy'), else an empty string."
}`,

            HEX_AXIS_LEGEND,
            `CONTROLLED TRAIT VOCABULARY — the "traits" array may only contain words from this list: ${offeredTraitNames(matureMode).join(', ')}.`,

            COMBAT_TIER_ARCHETYPE_RUBRIC,

            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,
        );

        const reservedNames = (existingLedger ?? []).map(n => n.name?.trim()).filter(Boolean);
        const reservedNamesSection = reservedNames.length > 0
            ? `RESERVED NAMES — already used by existing characters. The profile's "name" and "aliases" must NOT collide with any of these (a shared family surname is acceptable only with an explicit in-story relation; never a first name): ${reservedNames.join(', ')}`
            : '';

        const fullPrompt = joinPromptSections(
            systemPrompt,
            `NPC NAME: "${npcName}"`,
            reservedNamesSection,
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
                    reservedNamesSection,
                    `RECENT CHAT HISTORY:\n${recentHistory}`,
                    `Name "${resolvedName}" is already used by an existing NPC. Pick a different name (consider regional/family disambiguators) and re-emit the JSON.`,
                );
                const retryParsed = await llmParseJson<Record<string, unknown>>(provider, retryPrompt, 'NPC Generator (name retry)');

                if (retryParsed && !checkNameCollision((retryParsed.name as string) || resolvedName, (retryParsed.aliases as string) || '', existingLedger)) {
                    finalParsed = retryParsed;
                    console.log(`[NPC Generator] Name disambiguated to: "${(retryParsed.name as string) || resolvedName}"`);
                } else {
                    // Re-prompt also collided. Instead of the old "X the Younger" hack,
                    // draw a real, distinct name from the engine name bank (Plan 05),
                    // culture- and gender-matched to what the model originally minted.
                    const firstTok = resolvedName.trim().split(/\s+/)[0] ?? resolvedName;
                    const exclude = new Set<string>();
                    for (const n of existingLedger) {
                        for (const raw of [n.name, ...(n.aliases || '').split(',')]) {
                            const fn = raw.trim().split(/\s+/)[0]?.toLowerCase();
                            if (fn) exclude.add(fn);
                        }
                    }
                    const drawn = drawUnusedName({ cultures: lookupCultures(firstTok), gender: genderOf(firstTok), exclude });
                    const disambiguated = drawn ?? `${resolvedName} the Younger`; // pool-exhausted last resort
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

            // ---- NPC Agency Phase 2: come out already populated (wants / hexagon / traits / region) ----
            const agencyTraits = validateTraits(finalParsed.traits, matureMode);
            const longWant = (typeof finalParsed.longWant === 'string' && finalParsed.longWant.trim())
                ? finalParsed.longWant.trim()
                : defaultLongWant(newEntry.faction);
            newEntry.traits = agencyTraits;
            newEntry.wants = {
                short: drawShortWants({ matureMode, traits: agencyTraits }),
                medium: drawMediumWants({ matureMode, traits: agencyTraits }),
                long: longWant,
            };
            newEntry.personalityHex = validatePersonalityHex(finalParsed.personalityHex);
            newEntry.region = typeof finalParsed.region === 'string' ? finalParsed.region.trim() : '';
            newEntry.populated = true;
            // Scene-type tags per profile field for smart context injection.
            // Untagged fields (or NPCs without fieldTags) always inject — this
            // is the backward-compatible default. Tagged fields only inject when
            // the planner's eventTypes intersect the field's tags.
            newEntry.fieldTags = buildDefaultFieldTags(newEntry);
            // Phase-3: seed Goal records from the new medium/long wants (engine layer; hidden cols).
            newEntry.goalRecords = buildGoalsFromWants(newEntry.wants.medium, newEntry.wants.long, agencyTraits, 0);

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

/**
 * WO-05 — DEBUG-side band for an un-migrated NPC's legacy 0..100 affinity. Used ONLY in the
 * `[CURRENT NPC STATES]` prompt block when `pcRelation` is absent, so the model has *some* read
 * on the PC-NPC feeling without us re-emitting raw affinity as a field to update. The parse side
 * (§B) accepts only `pcRelation` deltas — never raw affinity — so the legacy number is read-only.
 * Mirrors the private `affinityDescriptor` in npcBehaviorDirective.ts (kept local to avoid
 * cross-module export churn).
 */
function legacyAffinityDescriptor(v: number): string {
    if (v <= 15) return 'Nemesis';
    if (v <= 30) return 'Distrustful';
    if (v <= 45) return 'Wary';
    if (v <= 55) return 'Neutral';
    if (v <= 70) return 'Warm';
    if (v <= 85) return 'Trusted';
    return 'Devoted';
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
        // WO-05 §A — send the Phase-4 truth, NOT legacy. No raw 0–100 affinity; no drives.
        // pcRelation is rendered as a word band (DEBUG-side may show the integer in parens, but
        // we never ask the model for a raw 0–100). personalityHex is sent so the model can propose
        // a ±1 drift, never a full overwrite (parse side enforces delta-only via hexDelta).
        const pcRelationBand = npc.pcRelation !== undefined
            ? `${relationBand(npc.pcRelation)} (${npc.pcRelation >= 0 ? '+' : ''}${npc.pcRelation})`
            : (npc.affinity !== undefined ? `${legacyAffinityDescriptor(npc.affinity)} (${npc.affinity}/100 legacy)` : 'Neutral (0)');

        let data = `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Feeling toward PC: ${pcRelationBand}\n` +
            `Personality: ${npc.personality || npc.disposition || 'Unknown'}\n` +
            `Voice: ${npc.voice || 'not defined'}\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`;

        // WO-05 §A — wants (Phase-4 source of truth), NOT drives. Send medium/long only; `short`
        // is no-LLM (§9.2 #3) and is preserved on the parse side. Legacy drives are read-only
        // fallback for un-migrated NPCs and never sent to the updater.
        if (npc.wants && (npc.wants.long || npc.wants.medium?.length)) {
            data += `LongWant: ${npc.wants.long || 'Unknown'}\n` +
                `MediumWants: ${npc.wants.medium?.join(' | ') || 'none'}\n`;
        }

        // WO-05 §A — personalityHex so the model can propose a drift (delta-only on parse).
        if (npc.personalityHex) {
            data += `PersonalityHex: ${describeHex(npc.personalityHex)}\n`;
        }

        if (npc.traits && npc.traits.length > 0) {
            data += `Traits: ${npc.traits.join(', ')}\n`;
        }

        if (npc.region) {
            data += `Region: ${npc.region}\n`;
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

Each update MUST include "name" and only the fields that fundamentally changed. Allowed changes keys:
  status, disposition, goals, storyRelevance, personality (flavor text), voice, appearance,
  wants (medium/long text only — NEVER include "short"; short is engine-managed),
  pcRelation, personalityHex, traits, region, faction, relations, secondaryGroup.
  "secondaryGroup" is the NPC's SOCIAL/disposition trajectory archetype key (e.g. 'scholar',
  'brute', 'fool') — NOT the combat "archetype". Only send when the NPC's growth trajectory
  has genuinely shifted. "primaryGroup" is immutable and NEVER allowed here.
DO NOT include attributes that stayed the same.

**FORBIDDEN keys** (Phase-4 schema; sending these is a data-model error):
  - "drives" — superseded by "wants". Never send drives.
  - "affinity" — superseded by "pcRelation". Never send a 0–100 affinity number.

PERSONALITY HEX DRIFT (the headline):
  - "personalityHex" is a DELTA MAP, not a full overwrite. Send ONLY the axes that drifted, as
    small integers: e.g. {"personalityHex": {"boldness": +1, "composure": -1}}.
  - Each axis delta is clamped to ±1 by the engine; a "+5" still moves only +1. Drift is rare and
    small — only send a hex delta when the scene contains a genuinely transformative event.
  - NEVER re-emit the full 6-axis hexagon. NEVER send absolute axis values as if setting them.

PC RELATION DRIFT:
  - "pcRelation" is a DELTA: +1, -1, or 0. The engine clamps the result to −3..+3 and rejects any
    larger step. Send +1 when the player gained favor, -1 when they lost it. Skip if unchanged.
  - NEVER send a 0–100 "affinity" number. The legacy field is read-only.`,

        `GENERAL RULES:
- Valid statuses: Alive, Deceased, Missing, Unknown.
- Do NOT change personality or voice unless the scene contains a genuinely transformative event for this character.`,

        APPEARANCE_UPDATE_RULES,

        `EXAMPLES:

GOOD — NPC who died with a transformative emotional arc:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "personality": "consumed by rage in final moments, betrayed and broken", "storyRelevance": "His death sparked a rebellion"}}]}

GOOD — NPC whose mid/long-term ambition shifted after a major scene (only revise "wants" medium/long; NEVER include "short"):
{"updates": [{"name": "Kael", "changes": {"wants": {"long": "seize the Ironwall garrison and rule the pass himself", "medium": ["turn the captain's lieutenants against her", "stockpile blackpowder"]}}}]}

GOOD — NPC who grew bolder after a crit-success on a bold goal (hex DRIFT, delta-only; pcRelation delta):
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"boldness": +1}, "pcRelation": +1}}]}

GOOD — NPC who lost composure after sustained failure (hex DRIFT, delta-only):
{"updates": [{"name": "Senna", "changes": {"personalityHex": {"composure": -1}}}]}

BAD — re-emitting unchanged attributes (status/personality/voice/appearance all unchanged here):
{"updates": [{"name": "Senna", "changes": {"status": "Alive", "personality": "warm and curious", "voice": "soft alto", "appearance": "tall, dark hair"}}]}
Corrected: include ONLY the field that changed —
{"updates": [{"name": "Senna", "changes": {"personality": "warm but watchful after the ambush"}}}]}

BAD — sending a FORBIDDEN legacy key (drives/affinity):
{"updates": [{"name": "Senna", "changes": {"drives": {"sceneWant": "investigate the tracks at dawn"}, "affinity": 65}}]}
Corrected — use the Phase-4 fields (wants medium/long; pcRelation delta):
{"updates": [{"name": "Senna", "changes": {"wants": {"medium": ["investigate the tracks at dawn"]}, "pcRelation": +1}}]}

BAD — re-emitting the full hexagon as absolute values (this is a full-overwrite attempt; the engine will clamp it to ±1 anyway, but it signals a misunderstanding):
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"drive": 2, "diligence": 1, "boldness": 3, "warmth": 0, "empathy": 1, "composure": 2}}]}
Corrected — send ONLY the axis that drifted, as a small delta:
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"boldness": +1}}}]}`,

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

                    // WO-05 §B — defensively strip the FORBIDDEN legacy keys. The prompt forbids them,
                    // but the parse must never write a superseded field as truth (the data-model fork
                    // this phase closes). `drives` and raw `affinity` are read-only fallback for
                    // un-migrated NPCs only; the lazy fill (Piece B) seeds the Phase-4 fields from them.
                    delete (changes as Partial<NPCEntry>).drives;
                    delete (changes as Partial<NPCEntry>).affinity;

                    // WO-05 §C — capture the pre-change state into `previousSnapshot` so the
                    // `buildDriftAlert` consumer can surface a SHIFT word-band on the next payload
                    // read. Capture personality/voice (legacy drift), personalityHex (hex drift),
                    // pcRelation (relation drift), and skillRung (rung drift — set by WO-06). Only
                    // snapshot fields that are present and might change.
                    const hasPersonalityChange = changes.personality !== undefined || changes.voice !== undefined;
                    const hasHexChange = changes.personalityHex !== undefined;
                    const hasPcRelationChange = changes.pcRelation !== undefined;
                    const hasRungChange = changes.skillRung !== undefined;
                    if (hasPersonalityChange || hasHexChange || hasPcRelationChange || hasRungChange) {
                        changes.previousSnapshot = {
                            personality: targetNpc.personality || targetNpc.disposition || '',
                            voice: targetNpc.voice || '',
                            affinity: targetNpc.affinity,
                            personalityHex: targetNpc.personalityHex,
                            pcRelation: targetNpc.pcRelation,
                            skillRung: targetNpc.skillRung,
                        };
                        changes.shiftTurnCount = 0;
                    } else if (targetNpc.shiftTurnCount !== undefined && targetNpc.shiftTurnCount < 3) {
                        changes.shiftTurnCount = (targetNpc.shiftTurnCount || 0) + 1;
                    }

                    // WO-05 §A — pcRelation DELTA. Accept +1/-1 (or an absolute target the engine
                    // clamps). Step is clamped to ±PC_RELATION_MAX_STEP; result to [PC_RELATION_MIN,
                    // PC_RELATION_MAX]. Never accept a 0–100 number. Only apply when the NPC already
                    // has a pcRelation (un-populated NPCs get theirs from Piece B first).
                    if (changes.pcRelation !== undefined && typeof changes.pcRelation === 'number'
                        && Number.isFinite(changes.pcRelation) && targetNpc.pcRelation !== undefined) {
                        const current = targetNpc.pcRelation;
                        // Treat the incoming value as a delta. (The model is told to send +1/-1; if it
                        // sends an absolute target like 2, hexDelta-style clamping would be wrong here,
                        // so we clamp the STEP against the delta interpretation. A +5 request → +1.)
                        const step = Math.max(-PC_RELATION_MAX_STEP, Math.min(PC_RELATION_MAX_STEP, Math.round(changes.pcRelation)));
                        const next = Math.max(PC_RELATION_MIN, Math.min(PC_RELATION_MAX, current + step));
                        changes.pcRelation = next;
                    } else {
                        // No valid pcRelation delta or NPC has no baseline — drop it (don't write raw).
                        delete (changes as Partial<NPCEntry>).pcRelation;
                    }

                    // WO-05 §A — personalityHex DELTA-ONLY. Accept a delta map (e.g.
                    // {boldness: +1, composure: -1}). For each axis, apply via `hexDelta` (WO-03),
                    // which clamps the step to ±HEX_DRIFT_MAX_STEP and the result to −3..+3. A
                    // full-overwrite attempt (all 6 axes as "absolute" values) is neutralized:
                    // hexDelta treats each value as a delta, so a "5" becomes +1. Only apply when
                    // the NPC already has a personalityHex (un-populated NPCs get theirs from Piece B).
                    if (changes.personalityHex !== undefined && changes.personalityHex !== null
                        && typeof changes.personalityHex === 'object' && targetNpc.personalityHex) {
                        const incoming = changes.personalityHex as Record<HexAxis, number>;
                        let merged = { ...targetNpc.personalityHex };
                        const axes: HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
                        for (const axis of axes) {
                            if (incoming[axis] !== undefined && typeof incoming[axis] === 'number' && Number.isFinite(incoming[axis])) {
                                merged = hexDelta(merged, axis, incoming[axis]);
                            }
                        }
                        changes.personalityHex = merged;
                    } else {
                        delete (changes as Partial<NPCEntry>).personalityHex;
                    }

                    // WO-05 §B — relations: sparse edge add/update, shallow-merge into existing.
                    // Never wholesale replace. Optional/minimal.
                    if (changes.relations !== undefined && changes.relations !== null
                        && typeof changes.relations === 'object') {
                        const existing = targetNpc.relations ?? {};
                        const incoming = changes.relations as RelationGraph;
                        changes.relations = { ...existing, ...incoming };
                    }

                    // Want edits (Phase 2 / WO-05 §B): the model may revise medium/long ambition text
                    // only. `short` is no-LLM (§9.2 #3) — always preserve the existing short list.
                    // Drives are gone (superseded); this block stays as-is.
                    if (changes.wants && typeof changes.wants === 'object') {
                        const existingWants = targetNpc.wants || { short: [], medium: [], long: '' };
                        const incoming = changes.wants as Partial<NPCEntry['wants']>;
                        changes.wants = {
                            short: existingWants.short,
                            medium: Array.isArray(incoming?.medium)
                                ? incoming!.medium.map(String).filter(Boolean)
                                : existingWants.medium,
                            long: (typeof incoming?.long === 'string' && incoming.long.trim())
                                ? incoming.long.trim()
                                : existingWants.long,
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

    addNPCToStore(mergedEntry);

    if (campaignId) {
        embedAndStoreNPC(campaignId, mergedEntry).catch((e) => console.warn(`[PC Generator] Embedding failed for ${mergedEntry.name}:`, e));
    }

    console.log(`[PC Generator] Successfully created PC: ${mergedEntry.name} (${mergedEntry.archetype}/${mergedEntry.combatTier})`);
    return mergedEntry;
}

/** Append items from `drawn` to `existing` (dedup, no repeats) until reaching `target` length. */
function topUpWants(existing: string[], drawn: string[], target: number): string[] {
    const out = [...existing];
    for (const d of drawn) {
        if (out.length >= target) break;
        if (!out.includes(d)) out.push(d);
    }
    return out;
}

/**
 * §9.4 hole 6 — lazily fill agency fields for un-populated NPCs (old-save migration AND big-bang
 * relocation). Cheapest-first: deterministic seed (pcRelation from affinity; wants from legacy
 * drives) → pool top-up → ONE batched LLM call for personalityHex/traits/region. Idempotent:
 * never overwrites a field the NPC already has, so it is safe to re-run. Skips isPC NPCs.
 */
export async function populateAgencyFields(
    provider: LLMProvider,
    history: ChatMessage[],
    npcs: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void,
    matureMode: boolean = false,
): Promise<void> {
    const targets = npcs.filter(n => !n.isPC);
    if (!targets.length) return;

    console.log(`[NPC Agency Fill] Populating agency fields for ${targets.length} NPC(s)...`);

    // ---- Phase 1: deterministic seed + pool fill (no LLM). Build a per-NPC patch. ----
    const patches = new Map<string, Partial<NPCEntry>>();
    const needLLM: NPCEntry[] = [];

    for (const npc of targets) {
        const patch: Partial<NPCEntry> = {};

        // pcRelation re-homed from affinity (never clobber an explicit value; affinity preserved).
        if (npc.pcRelation === undefined) {
            patch.pcRelation = affinityToPcRelation(npc.affinity ?? 50);
        }

        // WO-04 (Piece B) — cover the remaining engine-read fields. Each null-guarded with
        // `=== undefined` (NEVER falsy `!`): `skillRung: 0` and `relations: {}` are valid values.
        // Re-running over a fully-populated NPC must still write nothing (idempotency contract).
        if (npc.relations === undefined) {
            patch.relations = {};  // explicit sparse seed so roster `npc.relations` reads never hit undefined
        }
        if (npc.skillRung === undefined) {
            patch.skillRung = RUNG_DEFAULT;  // 0 = Novice
        }
        if (npc.rungCeiling === undefined) {
            patch.rungCeiling = RUNG_CEILING_DEFAULT;  // 3 = Veteran cap when the LLM didn't set one
        }

        // wants: seed from legacy drives when absent, then top up from the pools.
        const drives = npc.drives;
        const existing = npc.wants;
        let short = existing?.short?.length ? [...existing.short] : (drives?.sceneWant ? [drives.sceneWant] : []);
        let medium = existing?.medium?.length ? [...existing.medium] : (drives?.sessionWant ? [drives.sessionWant] : []);
        const long = existing?.long || drives?.coreWant || defaultLongWant(npc.faction);
        const traitsForDraw = npc.traits ?? [];
        short = topUpWants(short, drawShortWants({ matureMode, traits: traitsForDraw, count: 4 }), 4);
        medium = topUpWants(medium, drawMediumWants({ matureMode, traits: traitsForDraw, count: 3 }), 3);

        const wantsChanged = !existing
            || (existing.short?.length ?? 0) !== short.length
            || (existing.medium?.length ?? 0) !== medium.length
            || existing.long !== long;
        if (wantsChanged) patch.wants = { short, medium, long };

        patches.set(npc.id, patch);

        const needsHex = !npc.personalityHex;
        const needsTraits = !npc.traits || npc.traits.length === 0;
        const needsRegion = npc.region === undefined || npc.region === '';
        if (needsHex || needsTraits || needsRegion) needLLM.push(npc);
    }

    // ---- Phase 2: ONE batched LLM call for the inferred fields (hex / traits / region). ----
    if (needLLM.length > 0) {
        const recentContext = history.slice(-10).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        const npcBlocks = needLLM.map(n =>
            `- name: ${n.name}\n  faction: ${n.faction || 'Unknown'}\n  personality: ${n.personality || n.disposition || 'Unknown'}\n  bio: ${n.storyRelevance || 'Unknown'}; goals: ${n.goals || 'Unknown'}`
        ).join('\n');

        const prompt = joinPromptSections(
            `${TTRPG_PERSONA_STATE_ANALYZER} For EACH NPC below, infer their personality hexagon, a few defining traits, and home region. Data generation only — no narrative, no prose.`,
            HEX_AXIS_LEGEND,
            `CONTROLLED TRAIT VOCABULARY — each NPC's "traits" may only contain words from this list (≤5, omit any that don't fit, never invent): ${offeredTraitNames(matureMode).join(', ')}.`,
            `OUTPUT FORMAT — a single JSON object, one entry per NPC, names matching EXACTLY:
{"npcs": [{"name": "<exact name>", "personalityHex": {"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0}, "traits": ["..."], "region": "coarse home/current location, or empty string"}]}`,
            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,
            `[NPCS]\n${npcBlocks}\n[END NPCS]`,
            `[RECENT CONTEXT]\n${recentContext}\n[END CONTEXT]`,
        );

        let rows: Array<Record<string, unknown>> = [];
        try {
            const parsed = await llmParseJson<{ npcs?: Array<Record<string, unknown>> }>(provider, prompt, 'NPC Agency Fill');
            if (Array.isArray(parsed?.npcs)) rows = parsed!.npcs;
        } catch (err) {
            console.error('[NPC Agency Fill] Batched LLM inference failed; applying deterministic fields + safe defaults:', err);
        }

        for (const npc of needLLM) {
            const row = rows.find(r => typeof r.name === 'string' && (r.name as string).toLowerCase() === npc.name.toLowerCase());
            const patch = patches.get(npc.id)!;
            if (!npc.personalityHex) patch.personalityHex = validatePersonalityHex(row?.personalityHex);
            if (!npc.traits || npc.traits.length === 0) patch.traits = validateTraits(row?.traits, matureMode);
            if (npc.region === undefined || npc.region === '') {
                patch.region = row && typeof row.region === 'string' ? (row.region as string).trim() : '';
            }
        }
    }

    // ---- Phase 3: persist. populated:true marks the NPC done; an empty patch is a true no-op. ----
    for (const npc of targets) {
        const patch = patches.get(npc.id) ?? {};
        if (!npc.populated) patch.populated = true;

        // Phase-3 migration: seed Goal records from the (just-resolved) medium/long wants. Idempotent
        // — only when the NPC has none yet. `now` seeds at 0; the heartbeat advances ticks from there.
        if (!npc.goalRecords || npc.goalRecords.length === 0) {
            const wants = (patch.wants as NPCWants | undefined) ?? npc.wants;
            if (wants) {
                const traits = (patch.traits as string[] | undefined) ?? npc.traits ?? [];
                const goals = buildGoalsFromWants(wants.medium ?? [], wants.long ?? '', traits, 0);
                if (goals.length > 0) patch.goalRecords = goals;
            }
        }

        if (Object.keys(patch).length === 0) continue;
        updateNPCStore(npc.id, patch);
        console.log(`[NPC Agency Fill] Populated ${npc.name}:`, Object.keys(patch).join(', '));
    }
}

/**
 * §9.3 hole 6 / WO-01 §4 — the single unifying bulk entry point shared by retroactive fill and
 * future graduation/relocation. Thin wrapper around `populateAgencyFields` so there is exactly one
 * fill path. No background sweep (locked this session): callers pass only the NPCs they want filled.
 * Idempotent + null-guarded + isPC-skipping (carried from `populateAgencyFields`).
 *
 * `needsGeneration: true` → run the full agency fill (the current `populateAgencyFields` body).
 * Future non-generation bulk ops (graduation/relocation) branch here without touching the fill path.
 */
export async function bulkNpcUpdate(
    provider: LLMProvider,
    history: ChatMessage[],
    npcs: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void,
    opts: { needsGeneration?: boolean; matureMode?: boolean },
): Promise<void> {
    if (opts.needsGeneration) {
        await populateAgencyFields(provider, history, npcs, updateNPCStore, opts.matureMode ?? false);
    }
    // future: non-generation bulk ops (graduation/relocation) branch here.
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
