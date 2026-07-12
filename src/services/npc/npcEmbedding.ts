/**
 * NPC embedding — extracted from npcGeneration.ts (W10).
 */

import type { NPCEntry } from '../../types';
import { embedText, getCurrentModelId } from '../embedding';
import { embeddingStorage } from '../storage/embeddingStorage';

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
