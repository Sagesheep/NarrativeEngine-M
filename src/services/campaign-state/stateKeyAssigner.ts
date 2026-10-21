import type { DivergenceRegister, LLMProvider, NPCEntry } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    extractJsonRobust,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    joinPromptSections,
} from '../infrastructure';
import { isFactActive, isValidStateKey, normalizeStateKey, STATE_KEY_KINDS, STATE_KEY_ATTRIBUTES } from './divergenceRegister';
import { compareSceneRef } from './knowledgeScope';

export type StateKeyCancelled = { cancelled: boolean };
export type StateKeyUpdate = { id: string; stateKey: string };

const BATCH_SIZE = 100;

/**
 * "Build current state" migration. Asks the utility model which existing loose
 * facts state the current value of a single-value slot and what that slot's key
 * is. Facts go in scene order, in batches, and each batch sees the keys chosen
 * so far so the same slot gets the same key across batches. Returns key
 * assignments only — applyStateKeys does the collapsing, so nothing is lost if
 * the run is cancelled or a batch fails.
 */
export async function assignStateKeys(
    register: DivergenceRegister,
    npcLedger: NPCEntry[],
    utilityProvider: LLMProvider,
    cancel: StateKeyCancelled,
    onStatus: (msg: string) => void,
): Promise<StateKeyUpdate[]> {
    const candidates = register.entries
        .filter(e => isFactActive(e) && !isValidStateKey(e.stateKey))
        .sort((a, b) => compareSceneRef(a.sceneRef, b.sceneRef));
    if (candidates.length === 0) return [];

    // key -> latest text, seeded with slots that already exist.
    const known = new Map<string, string>();
    for (const e of register.entries) {
        if (isFactActive(e) && isValidStateKey(e.stateKey)) known.set(e.stateKey, e.text);
    }

    const npcList = npcLedger.map(n => `- ${n.name} (id: ${n.id})`).join('\n');
    const updates: StateKeyUpdate[] = [];
    const batches = Math.ceil(candidates.length / BATCH_SIZE);

    for (let b = 0; b < batches; b++) {
        if (cancel.cancelled) throw new Error('Build current state cancelled.');
        const batch = candidates.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        onStatus(`Keying facts — batch ${b + 1}/${batches}…`);

        const knownText = [...known].slice(-120).map(([k, t]) => `${k} = ${t}`).join('\n');
        const prompt = joinPromptSections(
            'You are organizing the established-facts register of a TTRPG campaign into CURRENT STATE slots. A slot is something with exactly ONE value at a time; a newer fact in the same slot replaces the older one.',

            `OUTPUT FORMAT — a single JSON object:
{"keys":[{"id":"<fact id>","stateKey":"<kind>:<slug>:<attribute>"}]}`,

            `RULES:
- Give a stateKey ONLY to facts that state the current value of a single-value slot
  (where someone is, who holds something, who leads or controls something, whether
  something is alive/destroyed/settled, whose side someone is on).
- kind: ${STATE_KEY_KINDS.join(' | ')}   (npc slug = the NPC ledger id; others = a short-name slug)
- attribute: ${STATE_KEY_ATTRIBUTES.join(' | ')}
- Facts about the SAME slot MUST get the SAME key — reuse keys from EXISTING SLOTS exactly.
- Different things get different slugs (two different swords = two keys).
- Leave out events, history, discoveries, oaths, secrets, lore and anything that adds to
  what is known rather than replacing a value. Most facts should be left out.
- If unsure, leave the fact out.`,

            `EXAMPLE (synthetic — do not echo):
f1|003|Mira was wounded by the assassin
f2|004|Mira swore to find the Red Hand's leader
f3|009|Mira has recovered from her wounds
f4|010|Mira travelled to the capital
→ {"keys":[{"id":"f1","stateKey":"npc:npc_7:condition"},{"id":"f3","stateKey":"npc:npc_7:condition"},{"id":"f4","stateKey":"npc:npc_7:location"}]}
(f2 is an oath — it adds to what is known, so it gets no key.)`,

            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `NPC LEDGER:\n${npcList || '(no NPCs in ledger)'}`,
            knownText ? `EXISTING SLOTS (key = current value):\n${knownText}` : '',
            `FACTS (id|scene|text):\n${batch.map(e => `${e.id}|${e.sceneRef}|${e.text.slice(0, 160)}`).join('\n')}`,
        );

        const raw = await llmCall(utilityProvider, prompt, {
            temperature: 0.1,
            maxTokens: 6000,
            timeoutMs: 10 * 60 * 1000,
            trackingLabel: 'state-key-assigner',
        });
        if (cancel.cancelled) throw new Error('Build current state cancelled.');

        const { value } = extractJsonRobust<{ keys?: Array<{ id?: unknown; stateKey?: unknown }> }>(raw, { keys: [] });
        const byId = new Map(batch.map(e => [e.id, e]));
        for (const item of Array.isArray(value.keys) ? value.keys : []) {
            const entry = typeof item?.id === 'string' ? byId.get(item.id) : undefined;
            const key = normalizeStateKey(item?.stateKey);
            if (!entry || !key) continue;
            byId.delete(entry.id); // one key per fact
            updates.push({ id: entry.id, stateKey: key });
            known.delete(key);
            known.set(key, entry.text); // batch is in scene order → last one is newest
        }
    }

    return updates;
}
