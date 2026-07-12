/**
 * NPC shared utilities — extracted from npcGeneration.ts (W10).
 * LLM JSON parsing, name collision detection, field tags, affinity descriptor.
 */

import type { NPCEntry, LLMProvider, SceneEventType } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJson } from '../infrastructure';

export const RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

export async function llmParseJson<T>(
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
        const retryPrompt = `${prompt}\n\nYour previous response was:\n${firstResponse}\n${RETRY_SUFFIX}`;
        const retryResponse = await llmCall(provider, retryPrompt, { priority: 'low' });
        if (!retryResponse) return null;
        const retryClean = extractJson(retryResponse);
        try {
            return JSON.parse(retryClean) as T;
        } catch (retryErr) {
            console.error(`[${contextLabel}] Retry parse also failed:`, retryErr);
            return null;
        }
    }
}

export function checkNameCollision(name: string, aliasesRaw: string, ledger: NPCEntry[]): boolean {
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

export function buildDefaultFieldTags(npc: NPCEntry): Record<string, SceneEventType[]> {
    const tags: Record<string, SceneEventType[]> = {
        voice: ['relationship_shift', 'revelation', 'other'],
        hardBoundaries: ['relationship_shift', 'promise', 'betrayal'],
        softBoundaries: ['relationship_shift', 'betrayal'],
        behavioralTriggers: ['combat', 'relationship_shift', 'revelation'],
        exampleOutput: ['relationship_shift', 'other'],
        drift: ['relationship_shift', 'revelation'],
        innerState: ['relationship_shift', 'revelation', 'discovery'],
    };
    if (npc.combatTier || npc.archetype || npc.stats) {
        tags.combatTier = ['combat'];
        tags.archetype = ['combat', 'discovery'];
        tags.stats = ['combat'];
    }
    return tags;
}

export function legacyAffinityDescriptor(v: number): string {
    if (v <= 15) return 'Nemesis';
    if (v <= 30) return 'Distrustful';
    if (v <= 45) return 'Wary';
    if (v <= 55) return 'Neutral';
    if (v <= 70) return 'Warm';
    if (v <= 85) return 'Trusted';
    return 'Devoted';
}
