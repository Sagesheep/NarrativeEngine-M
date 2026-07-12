/**
 * Witness stage — extracted from turnPostProcess.ts (W10).
 */

import type { NPCEntry, LLMProvider } from '../../../types';
import { classifyNPCNames } from '../../npc';
import { llmCall } from '../../../utils/llmCall';
import { extractJson, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER, JSON_ARRAY_ONLY_FOOTER, TTRPG_PERSONA_GM_ASSISTANT, joinPromptSections } from '../../infrastructure';

const PRESENT_HEADER_RE = /👥\s*\[Present\]\s*[:\-–—]?\s*(.+?)(?:\n|$)/i;

export async function tryWithFallback<T>(label: string, primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try { return await primary(); }
    catch (err) { console.warn(`[${label}] primary failed, falling back:`, err); return await fallback(); }
}

export function parsePresentHeader(gmText: string): string[] {
    const match = gmText.match(PRESENT_HEADER_RE);
    if (!match) return [];
    const raw = match[1].trim();
    return raw.split(/[,;]\s*/).map(n => n.trim()).filter(n => n.length > 0 && n.length < 40);
}

export function resolveNPCIds(names: string[], ledger: NPCEntry[]): string[] {
    const { existingNpcs } = classifyNPCNames(names, ledger);
    return existingNpcs.map(n => n.id);
}

export async function auxWitnessFallback(gmText: string, ledger: NPCEntry[], provider: LLMProvider): Promise<string[]> {
    const roster = ledger.map(n => `- ${n.name} (id: ${n.id}${n.aliases ? ', aka: ' + n.aliases : ''})`).join('\n');
    const prompt = joinPromptSections(
        TTRPG_PERSONA_GM_ASSISTANT,
        `TASK: Given the GM narration below, list the canonical NPC IDs of characters who are PHYSICALLY PRESENT in the scene (not just mentioned).
Output schema: a JSON array of NPC ID strings, e.g. ["npc_1", "npc_3"]. If no NPCs are physically present, return [].`,
        JSON_ARRAY_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
        `NPC LEDGER:\n${roster || '(none)'}`,
        `GM NARRATION:\n${gmText.slice(0, 2000)}`,
    );
    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 200, thinkingEffort: 'off' });
        const cleaned = extractJson(raw.trim());
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            const knownIds = new Set(ledger.map(n => n.id));
            return parsed.filter((id: unknown) => typeof id === 'string' && knownIds.has(id));
        }
    } catch { /* malformed LLM JSON → no recallable ids */ }
    return [];
}
