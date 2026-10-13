/**
 * Witness stage — extracted from turnPostProcess.ts (W10).
 */

import type { NPCEntry, LLMProvider } from '../../../types';
import { classifyNPCNames } from '../../npc';
import { llmCall } from '../../../utils/llmCall';
import { extractJson, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER, JSON_ARRAY_ONLY_FOOTER, TTRPG_PERSONA_GM_ASSISTANT, joinPromptSections } from '../../infrastructure';

// The bundled rulesets ask for `👥 [Present] Rin, Mira`, but custom rulesets write the
// field their own way. The old exact-label regex matched none of them (desktop measured
// 0 of ~1,600 header lines), so the on-stage set was always empty. Accepted shapes:
//   `👥 [Present] Rin, Mira`          (bundled rulesets)
//   `👥 Present: Rin, Mira`           (labeled, no brackets)
//   `👥 [**Rin**], [**Mira**]`        (bracketed, bold)
//   `👥 [Headman **Lao Cheng**, grieving boy]`
//   `👥 Nobody`                        (→ an empty list, not "no header")
// Port of mainApp's services/npc/presentHeader.ts.
const PRESENT_HEADER_RE = /👥\s*([^|\n]*)/gu;
const NOBODY_RE = /^(?:nobody|no ?one|none|empty|alone|n\/a|-+|—|–)$/i;
// Placeholders for someone unidentified. They must not reach the resolver, whose
// prefix/suffix match would pin them on an NPC with a stray alias ("Name Unknown").
const PLACEHOLDER_RE = /^(?:unknown|someone|somebody|stranger|others?|various)$/i;

export async function tryWithFallback<T>(label: string, primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try { return await primary(); }
    catch (err) { console.warn(`[${label}] primary failed, falling back:`, err); return await fallback(); }
}

/** The `👥` names of a GM reply. `null` when the reply has no `👥` field at all;
 *  `[]` when the field says nobody is there. With several `👥` fields (a mid-reply
 *  scene shift) the LAST one wins: it says who is there where the scene ended. */
export function parsePresentHeader(gmText: string): string[] | null {
    const matches = [...gmText.matchAll(PRESENT_HEADER_RE)];
    if (matches.length === 0) return null;
    // Strip markup BEFORE the label: models bold it too ("👥 **Present:** [**Grey**], …").
    let raw = matches[matches.length - 1][1]
        .split(/📅|📍/u)[0]
        .replace(/\([^)]*\)/g, '')
        .replace(/[[\]*_`"«»]/g, '')
        .replace(/^\s*present\b\s*:?/i, '');
    raw = raw.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim();
    if (!raw || NOBODY_RE.test(raw)) return [];
    return raw
        .split(/\s*(?:[,;&]|\band\b)\s*/i)
        .map(name => name.trim())
        .filter(name => name.length > 0 && name.length < 60 && !NOBODY_RE.test(name) && !PLACEHOLDER_RE.test(name));
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
