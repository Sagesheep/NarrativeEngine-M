/**
 * NPC agency fill — extracted from npcGeneration.ts (W10).
 * Lazily populate agency fields for un-populated NPCs.
 */

import type { LLMProvider, ChatMessage, NPCEntry, NPCWants } from '../../types';
import { drawShortWants, drawMediumWants } from './agencyWantDraw';
import { affinityToPcRelation } from './agencyBands';
import { RUNG_DEFAULT, RUNG_CEILING_DEFAULT } from './agencyConstants';
import { buildGoalsFromWants } from './agencyGoals';
import { validatePersonalityHex, validateTraits, offeredTraitNames, defaultLongWant, HEX_AXIS_LEGEND } from './npcValidator';
import { llmParseJson } from './npcShared';
import { topUpWants } from './npcDrives';
import {
    JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
    TTRPG_PERSONA_STATE_ANALYZER, joinPromptSections,
} from '../infrastructure';

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

    const patches = new Map<string, Partial<NPCEntry>>();
    const needLLM: NPCEntry[] = [];

    for (const npc of targets) {
        const patch: Partial<NPCEntry> = {};
        if (npc.pcRelation === undefined) { patch.pcRelation = affinityToPcRelation(npc.affinity ?? 50); }
        if (npc.relations === undefined) { patch.relations = {}; }
        if (npc.skillRung === undefined) { patch.skillRung = RUNG_DEFAULT; }
        if (npc.rungCeiling === undefined) { patch.rungCeiling = RUNG_CEILING_DEFAULT; }

        const drives = npc.drives;
        const existing = npc.wants;
        let short = existing?.short?.length ? [...existing.short] : (drives?.sceneWant ? [drives.sceneWant] : []);
        let medium = existing?.medium?.length ? [...existing.medium] : (drives?.sessionWant ? [drives.sessionWant] : []);
        const long = existing?.long || drives?.coreWant || defaultLongWant(npc.faction);
        const traitsForDraw = npc.traits ?? [];
        short = topUpWants(short, drawShortWants({ matureMode, traits: traitsForDraw, count: 4 }), 4);
        medium = topUpWants(medium, drawMediumWants({ matureMode, traits: traitsForDraw, count: 3 }), 3);

        const wantsChanged = !existing || (existing.short?.length ?? 0) !== short.length || (existing.medium?.length ?? 0) !== medium.length || existing.long !== long;
        if (wantsChanged) patch.wants = { short, medium, long };
        patches.set(npc.id, patch);

        const needsHex = !npc.personalityHex;
        const needsTraits = !npc.traits || npc.traits.length === 0;
        const needsRegion = npc.region === undefined || npc.region === '';
        if (needsHex || needsTraits || needsRegion) needLLM.push(npc);
    }

    if (needLLM.length > 0) {
        const recentContext = history.slice(-10).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        const npcBlocks = needLLM.map(n => `- name: ${n.name}\n  faction: ${n.faction || 'Unknown'}\n  personality: ${n.personality || n.disposition || 'Unknown'}\n  bio: ${n.storyRelevance || 'Unknown'}; goals: ${n.goals || 'Unknown'}`).join('\n');
        const prompt = joinPromptSections(
            `${TTRPG_PERSONA_STATE_ANALYZER} For EACH NPC below, infer their personality hexagon, a few defining traits, and home region. Data generation only — no narrative, no prose.`,
            HEX_AXIS_LEGEND,
            `CONTROLLED TRAIT VOCABULARY — each NPC's "traits" may only contain words from this list (≤5): ${offeredTraitNames(matureMode).join(', ')}.`,
            `OUTPUT FORMAT — a single JSON object:
{"npcs": [{"name": "<exact name>", "personalityHex": {"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0}, "traits": ["..."], "region": "coarse home/current location, or empty string"}]}`,
            JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
            `[NPCS]\n${npcBlocks}\n[END NPCS]`,
            `[RECENT CONTEXT]\n${recentContext}\n[END CONTEXT]`,
        );
        let rows: Array<Record<string, unknown>> = [];
        try {
            const parsed = await llmParseJson<{ npcs?: Array<Record<string, unknown>> }>(provider, prompt, 'NPC Agency Fill');
            if (Array.isArray(parsed?.npcs)) rows = parsed!.npcs;
        } catch (err) { console.error('[NPC Agency Fill] Batched LLM inference failed:', err); }

        for (const npc of needLLM) {
            const row = rows.find(r => typeof r.name === 'string' && (r.name as string).toLowerCase() === npc.name.toLowerCase());
            const patch = patches.get(npc.id)!;
            if (!npc.personalityHex) patch.personalityHex = validatePersonalityHex(row?.personalityHex);
            if (!npc.traits || npc.traits.length === 0) patch.traits = validateTraits(row?.traits, matureMode);
            if (npc.region === undefined || npc.region === '') { patch.region = row && typeof row.region === 'string' ? (row.region as string).trim() : ''; }
        }
    }

    for (const npc of targets) {
        const patch = patches.get(npc.id) ?? {};
        if (!npc.populated) patch.populated = true;
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
}
