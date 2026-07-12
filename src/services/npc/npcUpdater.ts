/**
 * NPC updater — extracted from npcGeneration.ts (W10).
 * LLM-driven NPC attribute drift detection and application.
 */

import type { LLMProvider, ChatMessage, NPCEntry, HexAxis, RelationGraph } from '../../types';
import { relationBand, describeHex } from './agencyBands';
import { applyRelationTone, isRelationTone } from './relationMeter';
import { hexDelta } from './agencyDrift';
import { legacyAffinityDescriptor, llmParseJson } from './npcShared';
import {
    APPEARANCE_UPDATE_RULES, JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER, TTRPG_PERSONA_STATE_ANALYZER, joinPromptSections,
} from '../infrastructure';

export async function updateExistingNPCs(
    provider: LLMProvider,
    history: ChatMessage[],
    npcsToCheck: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void,
    _campaignId?: string,
): Promise<void> {
    if (!npcsToCheck.length) return;
    console.log(`[NPC Updater] Checking for attribute shifts on ${npcsToCheck.length} existing NPC(s)...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const npcDatas = npcsToCheck.map(npc => {
        const pcRelationBand = npc.pcRelation !== undefined
            ? `${relationBand(npc.pcRelation)} (${npc.pcRelation >= 0 ? '+' : ''}${npc.pcRelation})`
            : (npc.affinity !== undefined ? `${legacyAffinityDescriptor(npc.affinity)} (${npc.affinity}/100 legacy)` : 'Neutral (0)');
        let data = `[NPC: ${npc.name}]\nStatus: ${npc.status || 'Alive'}\nAppearance: ${npc.appearance || 'Unknown'}\nDisposition: ${npc.disposition || 'Unknown'}\nGoals: ${npc.goals || 'Unknown'}\nFeeling toward PC: ${pcRelationBand}\nPersonality: ${npc.personality || npc.disposition || 'Unknown'}\nVoice: ${npc.voice || 'not defined'}\nFaction: ${npc.faction || 'Unknown'}\nStory Relevance: ${npc.storyRelevance || 'Unknown'}\n`;
        if (npc.wants && (npc.wants.long || npc.wants.medium?.length)) {
            data += `LongWant: ${npc.wants.long || 'Unknown'}\nMediumWants: ${npc.wants.medium?.join(' | ') || 'none'}\n`;
        }
        if (npc.personalityHex) { data += `PersonalityHex: ${describeHex(npc.personalityHex)}\n`; }
        if (npc.traits && npc.traits.length > 0) { data += `Traits: ${npc.traits.join(', ')}\n`; }
        if (npc.region) { data += `Region: ${npc.region}\n`; }
        if (npc.behavioralTriggers && npc.behavioralTriggers.length > 0) { data += `Triggers: ${npc.behavioralTriggers.map(t => `"${t.keyword}" → ${t.shift}`).join('; ')}\n`; }
        return data;
    }).join('\n\n');

    const prompt = joinPromptSections(
        `${TTRPG_PERSONA_STATE_ANALYZER} Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, personality, goals, disposition, faction, or relevance.`,
        `OUTPUT FORMAT — a single JSON object with TWO channels: "updates" (rare) and "tones" (always):
{"updates": [ ... ], "tones": [ ... ]}
CHANNEL 1 — "updates" (only when something fundamentally changed; usually empty []):
{"updates": [{"name": "<NPC name>", "changes": { ...only the fields that changed... }}]}
Each update MUST include "name" and only the fields that fundamentally changed. Allowed changes keys:
  status, disposition, goals, storyRelevance, personality, voice, appearance,
  wants (medium/long text only — NEVER include "short"; short is engine-managed),
  personalityHex, traits, region, faction, relations, secondaryGroup.
DO NOT include attributes that stayed the same. If nothing fundamental changed, "updates" is [].
CHANNEL 2 — "tones" (MANDATORY: one entry for EVERY NPC listed below, every time):
{"tones": [{"name": "<NPC name>", "tone": "<friendly|tense|neutral|bonding|betrayal>"}]}
Judge how THIS scene felt for each NPC toward the player.
FORBIDDEN keys in "changes": "drives", "affinity", "pcRelation" — these are engine-owned.
PERSONALITY HEX DRIFT: "personalityHex" is a DELTA MAP, not a full overwrite. Send ONLY the axes that drifted, as small integers.`,
        `GENERAL RULES:\n- Valid statuses: Alive, Deceased, Missing, Unknown.\n- Do NOT change personality or voice unless the scene contains a genuinely transformative event.`,
        APPEARANCE_UPDATE_RULES,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
        `[RECENT CONTEXT]\n${recentContext}\n[END CONTEXT]`,
        `[CURRENT NPC STATES]\n${npcDatas}\n[END STATES]`,
    );

    try {
        const parsed = await llmParseJson<{
            updates?: Array<{ name?: string; changes?: Partial<NPCEntry> }>;
            tones?: Array<{ name?: string; tone?: string }>;
        }>(provider, prompt, 'NPC Updater');

        const findTarget = (name: string) => npcsToCheck.find(n =>
            n.name?.toLowerCase() === name.toLowerCase() ||
            (n.aliases && n.aliases.toLowerCase().includes(name.toLowerCase())));

        const tonePatchById = new Map<string, Partial<NPCEntry>>();
        if (Array.isArray(parsed?.tones)) {
            for (const t of parsed.tones) {
                if (!t?.name || !isRelationTone(t.tone)) continue;
                const target = findTarget(t.name);
                if (!target || target.isPC) continue;
                const patch = applyRelationTone(target, t.tone);
                if (Object.keys(patch).length > 0) tonePatchById.set(target.id, patch);
            }
        }
        const handledToneIds = new Set<string>();

        if (parsed?.updates && Array.isArray(parsed.updates)) {
            for (const update of parsed.updates) {
                if (!update.name || !update.changes) continue;
                const targetNpc = findTarget(update.name);
                if (targetNpc) {
                    const changes = { ...update.changes };
                    delete (changes as Partial<NPCEntry>).drives;
                    delete (changes as Partial<NPCEntry>).affinity;
                    delete (changes as Partial<NPCEntry>).pcRelation;

                    const tonePatch = tonePatchById.get(targetNpc.id);
                    if (tonePatch) { Object.assign(changes, tonePatch); handledToneIds.add(targetNpc.id); }

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

                    if (changes.relations !== undefined && changes.relations !== null && typeof changes.relations === 'object') {
                        const existing = targetNpc.relations ?? {};
                        const incoming = changes.relations as RelationGraph;
                        changes.relations = { ...existing, ...incoming };
                    }

                    if (changes.wants && typeof changes.wants === 'object') {
                        const existingWants = targetNpc.wants || { short: [], medium: [], long: '' };
                        const incoming = changes.wants as Partial<NPCEntry['wants']>;
                        changes.wants = {
                            short: existingWants.short,
                            medium: Array.isArray(incoming?.medium) ? incoming!.medium.map(String).filter(Boolean) : existingWants.medium,
                            long: (typeof incoming?.long === 'string' && incoming.long.trim()) ? incoming.long.trim() : existingWants.long,
                        };
                    }

                    if (Array.isArray(changes.behavioralTriggers)) {
                        changes.behavioralTriggers = changes.behavioralTriggers
                            .filter((t: Record<string, unknown>) => t.keyword && t.shift)
                            .map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }));
                    }
                    if (Array.isArray(changes.hardBoundaries)) { changes.hardBoundaries = changes.hardBoundaries.map(String).filter(Boolean); }
                    if (Array.isArray(changes.softBoundaries)) { changes.softBoundaries = changes.softBoundaries.map(String).filter(Boolean); }

                    updateNPCStore(targetNpc.id, changes);
                    console.log(`[NPC Updater] Applied changes to ${targetNpc.name}:`, changes);
                }
            }
        } else {
            console.log(`[NPC Updater] No updates required.`);
        }

        for (const [id, patch] of tonePatchById) {
            if (handledToneIds.has(id)) continue;
            const target = npcsToCheck.find(n => n.id === id);
            if (!target) continue;
            const changes: Partial<NPCEntry> = { ...patch };
            if (changes.pcRelation !== undefined) {
                changes.previousSnapshot = {
                    personality: target.personality || target.disposition || '',
                    voice: target.voice || '',
                    affinity: target.affinity,
                    personalityHex: target.personalityHex,
                    pcRelation: target.pcRelation,
                    skillRung: target.skillRung,
                };
                changes.shiftTurnCount = 0;
            }
            updateNPCStore(id, changes);
            console.log(`[NPC Updater] Relationship meter moved ${target.name}:`, changes);
        }
    } catch (err) {
        console.error('[NPC Updater] Failed to parse generated JSON or fatal error:', err);
    }
}
