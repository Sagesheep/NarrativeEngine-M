import type { LLMProvider, ThinkingEffort, SceneEvent, SceneEventType, DivergenceEntry } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    countTokens,
    extractJson,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    KNOWNBY_RULES,
    NPC_INNER_STATE_RULES,
    SCENE_EVENT_RULES,
    TTRPG_PERSONA_ARCHIVIST,
    joinPromptSections,
    buildSubjectTokenRules,
} from '../infrastructure';
import { DIVERGENCE_CATEGORIES, CATEGORY_DEFINITIONS, coerceCategory, stripReasoning, normalizeSubjectToken, normalizeFaction, parseKnownByToken } from '../campaign-state';
import { uid } from '../../utils/uid';
import { truncateScenesToBudget } from './saveFileEngine';
import { parseChapterSummaryOutput, type ChapterSummaryOutput } from './chapterSummaryWriter';

const COMBINED_SEAL_TOKEN_BUDGET = 12000;
const SEAL_MAX_TOKENS = 32000;

function buildCombinedSealPrompt(
    scenes: { sceneId: string; content: string }[],
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    indexEntries?: { sceneId: string; npcsWitnessed?: string[] }[],
    openThreads?: string[],
    existingSubjectTokens?: string[]
): string {
    const truncated = truncateScenesToBudget(scenes, COMBINED_SEAL_TOKEN_BUDGET);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');

    const npcList = npcLedger.map(n =>
        `- ${n.name} (id: ${n.id}${n.aliases ? ', also known as: ' + n.aliases : ''})`
    ).join('\n');

    const divergenceSlots = DIVERGENCE_CATEGORIES.filter(c => c !== 'misc').map(c =>
        `### ${c.toUpperCase()}\nDefinition: ${CATEGORY_DEFINITIONS[c]}\nOutput: JSON array for this slot, or [] if empty.`
    ).join('\n\n');

    let witnessAuditSection = '';
    if (indexEntries && indexEntries.length > 0) {
        const entriesWithWitness = indexEntries.filter(e => e.npcsWitnessed && e.npcsWitnessed.length > 0);
        if (entriesWithWitness.length > 0) {
            const rows = entriesWithWitness.map(e =>
                `Scene ${e.sceneId}: ${e.npcsWitnessed!.join(', ') || '(none recorded)'}`
            ).join('\n');
            witnessAuditSection = `
AUDIT — PER-SCENE NPC WITNESSES (pre-capture):
The following per-scene witness data was captured during play. Review it for accuracy.
If you find that a scene's witnesses are incorrect (NPCs listed who were NOT present, or NPCs present who are NOT listed),
provide corrections in the "witness_corrections" field.

${rows}`;
        }
    }

    const knownByExample = `     "locations": [
         { "text": "Eastern gate destroyed by siege", "sceneRef": "014", "npcIds": [], "unrecognizedNpcNames": [], "subjectToken": "eastern_gate.state" }
     ]`;

    const summaryShape = `The "summary" value must be this JSON shape:
{
    "title": "Short evocative chapter title",
    "summary": "3-5 sentence narrative summary of what happened",
    "keywords": ["keyword1", "keyword2"],
    "npcs": ["NPC Name 1", "NPC Name 2"],
    "majorEvents": ["Event description 1", "Event description 2"],
    "unresolvedThreads": ["Thread 1", "Thread 2"],
    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",
    "themes": ["theme1", "theme2"],
    "npcInnerState": { "NPC Name": "1-2 sentence inner-state note" }
}`;

    const divergencesShape = `The "divergences" value must be an object with one key per category slot. Each value is an array of fact objects, or [] if empty. Example:
{
${knownByExample},
     "npc_events": [
         { "text": "Grak allied with the player", "sceneRef": "018", "npcIds": ["npc_42"], "knownBy": ["npc:npc_42", "npc:npc_5"], "unrecognizedNpcNames": [], "subjectToken": "grak.allegiance" }
     ],
     "promises_debts": [],
     "world_state": [],
     "party_facts": [],
     "rules_lore": [],
     "misc": []
}`;

    const sceneEventsShape = `The "sceneEvents" value must be an object mapping scene IDs to arrays of structured event objects, or {} if no scenes had meaningful events. Example:
{
    "014": [
        {
            "eventType": "item_acquired",
            "importance": 7,
            "text": "Tav bought a leather chestpiece for 80gp",
            "characters": ["Tav", "Astarion"],
            "locations": ["Baldur's Gate"],
            "items": ["leather chestpiece", "80gp"],
            "concepts": ["trade"],
            "cause": "Tav needed better armor before the next dungeon",
            "result": "Tav now wears the leather chestpiece"
        }
    ],
    "015": []
}`;

    const resolvedThreadsShape = `The "resolvedThreads" value must be an array of the EXACT strings from the OPEN THREADS list below that this chapter's events settled, or [] if none. Example:
["The missing heir to House Brightblade", "The cursed amulet in the swamp"]`;

    const categoryDefinitions = `Category definitions:

${divergenceSlots}

### MISC
Definition: ${CATEGORY_DEFINITIONS.misc}
Output: JSON array for this slot, or [] if empty.`;

    const divergenceRulesStatic = `DIVERGENCE EXTRACTION RULES:
- Each fact is ONE SHORT SENTENCE, max 15 words. No compound sentences, no explanations.
- sceneRef must be one of the scene IDs listed in the INPUT below.
- npcIds: list the NPC ledger IDs mentioned. If a name appears that is NOT in the ledger, put it in unrecognizedNpcNames instead.
- Focus on: permanent changes, new information, relationship shifts, acquisitions, losses, oaths, regime changes.
- Skip transient details, emotional narration, momentary states, and anything the archive would already surface.
- If a slot is empty, output [] for that slot.`;

    const witnessCorrectionsRule = witnessAuditSection
        ? `WITNESS CORRECTIONS:
If you found errors in the per-scene witness data in the INPUT, include a "witness_corrections" key at the top level of the divergences object:
"witness_corrections": { "014": ["npc_5", "npc_7"], "022": ["npc_42"] }
This maps scene IDs to the CORRECT list of NPC IDs who were physically present in that scene. Only include scenes where you disagree with the pre-captured data.`
        : '';

    const summaryRules = `SUMMARY RULES:
1. Keywords should be distinctive nouns/places/factions — not generic words
2. NPCs should include all significant named characters who appeared or were discussed
3. Major events are plot-critical beats only (not every combat round)
4. Unresolved threads are open plot hooks, promises, or mysteries
5. Title should be 2-5 words, evocative
6. Summary should read like a campaign journal entry, not a list`;

    const innerStateFewShot = `EXAMPLES — npcInnerState focus (synthetic NPCs, do not echo):

GOOD — inner-state notes describe BELIEFS / POSTURE after events:
"npcInnerState": {
  "Helena Broadmarsh": "Pale, processing the violation of natural order; trusts Grey absolutely but now fears him.",
  "Cadwyn Vale": "Hardened by the betrayal; treats every promise as suspect until proven."
}

BAD — inner-state notes written as plot recap (this is what majorEvents is for):
"npcInnerState": {
  "Helena Broadmarsh": "Helena watched Grey raise the dead and then helped him escape the guards.",
  "Cadwyn Vale": "Cadwyn was betrayed by his lieutenant and lost his command."
}
Corrected — rewrite as the NPC's current inner world:
"npcInnerState": {
  "Helena Broadmarsh": "Pale, processing the violation of natural order; trusts Grey absolutely but now fears him.",
  "Cadwyn Vale": "Hardened by the betrayal; treats every promise as suspect until proven."
}`;

    const strictFooter = 'Respond with ONE JSON object only. No prose, no markdown fences, no second object, no reasoning before or after.';

    return joinPromptSections(
        `${TTRPG_PERSONA_ARCHIVIST} Perform TWO tasks in a single response:

TASK 1 — Generate a structured chapter summary.
TASK 2 — Extract established facts that would BREAK A FUTURE SCENE if the AI contradicted them.`,

        'OUTPUT FORMAT — a single JSON object with the keys "summary", "divergences", and optionally "sceneEvents" and "resolvedThreads".',

        summaryShape,
        NPC_INNER_STATE_RULES,
        divergencesShape,
        sceneEventsShape,
        resolvedThreadsShape,
        SCENE_EVENT_RULES,
        categoryDefinitions,
        KNOWNBY_RULES,
        buildSubjectTokenRules(existingSubjectTokens),
        divergenceRulesStatic,
        witnessCorrectionsRule,
        summaryRules,
        innerStateFewShot,

        strictFooter,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `CHAPTER: "${chapterTitle || 'Untitled'}"`,
        `SCENE IDs IN THIS CHAPTER: ${sceneIds.join(', ')}`,
        `NPC LEDGER (resolve names to IDs):\n${npcList || '(no NPCs in ledger)'}`,
        witnessAuditSection ? witnessAuditSection.trim() : '',
        ...(openThreads && openThreads.length > 0
            ? [`OPEN THREADS FROM EARLIER CHAPTERS (verbatim — do not rephrase):\n${openThreads.map(t => '- ' + t).join('\n')}`]
            : []),
        `SCENE CONTENT:\n${sceneContent}`,
    );
}

export type CombinedSealResult = {
    summary: ChapterSummaryOutput | null;
    divergences: DivergenceEntry[];
    divergenceParseError?: boolean;
    witnessCorrections?: Record<string, string[]>;
    sceneEventMap?: Record<string, SceneEvent[]>;
    sceneEventsParseError?: boolean;
    resolvedThreads?: string[];
};

function buildDivergenceEntries(
    divObj: Record<string, unknown[]>,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    chapterId: string,
    indexEntries?: { sceneId: string; npcsWitnessed?: string[] }[]
): DivergenceEntry[] {
    const entries: DivergenceEntry[] = [];
    const sceneSet = new Set(sceneIds);
    const fallbackScene = sceneIds[0] ?? '000';
    const npcNameMap = new Map<string, string>();
    const npcIdSet = new Set<string>();
    for (const npc of npcLedger) {
        npcIdSet.add(npc.id);
        npcNameMap.set(npc.name.toLowerCase(), npc.id);
        if (npc.aliases) {
            for (const alias of npc.aliases.split(',')) {
                npcNameMap.set(alias.trim().toLowerCase(), npc.id);
            }
        }
    }

    // Witnesses per scene, for seeding knownBy on sensitive categories (WO2 default-inversion).
    const witnessesByScene = new Map<string, Set<string>>();
    if (indexEntries) {
        for (const e of indexEntries) {
            if (e.npcsWitnessed && e.npcsWitnessed.length > 0) {
                const ids = e.npcsWitnessed.filter(id => npcIdSet.has(id));
                if (ids.length > 0) {
                    witnessesByScene.set(e.sceneId, new Set(ids));
                }
            }
        }
    }

    const broadcastCategories: Set<string> = new Set(['rules_lore', 'locations']);
    const sensitiveCategories: Set<string> = new Set(['npc_events', 'promises_debts', 'party_facts', 'world_state', 'misc']);

    for (const category of DIVERGENCE_CATEGORIES) {
        const slotArr = divObj[category];
        if (!Array.isArray(slotArr)) continue;

        for (const item of slotArr) {
            if (!item || typeof item !== 'object') continue;
            const rawItem = item as Record<string, unknown>;
            const text = typeof rawItem.text === 'string' ? rawItem.text.trim() : '';
            if (!text) continue;

            const sceneRef = typeof rawItem.sceneRef === 'string' && sceneSet.has(rawItem.sceneRef)
                ? rawItem.sceneRef
                : fallbackScene;

            const rawNpcIds: string[] = Array.isArray(rawItem.npcIds) ? rawItem.npcIds.filter((id): id is string => typeof id === 'string') : [];
            const resolvedNpcIds: string[] = [];
            const unrecognized: string[] = Array.isArray(rawItem.unrecognizedNpcNames)
                ? rawItem.unrecognizedNpcNames.filter((n): n is string => typeof n === 'string')
                : [];

            for (const id of rawNpcIds) {
                const found = npcLedger.some(n => n.id === id);
                if (found) {
                    resolvedNpcIds.push(id);
                } else {
                    unrecognized.push(id);
                }
            }

            const stillUnrecognized: string[] = [];
            for (const name of unrecognized) {
                const matched = npcNameMap.get(name.toLowerCase());
                if (matched && !resolvedNpcIds.includes(matched)) {
                    resolvedNpcIds.push(matched);
                } else {
                    stillUnrecognized.push(name);
                }
            }

            const hasReviewFlag = stillUnrecognized.length > 0;

            // knownBy resolution — token grammar: "player" | "npc:<id>" | "faction:<name>".
            let knownBy: string[] | undefined;
            const rawKnownBy = rawItem.knownBy;
            if (Array.isArray(rawKnownBy)) {
                const resolvedKnownBy: string[] = [];
                for (const kb of rawKnownBy) {
                    if (typeof kb !== 'string') continue;
                    const trimmed = kb.trim();
                    if (!trimmed) continue;
                    // Token form ("npc:npc_42", "faction:x", "player") — parse and validate.
                    const parsed = parseKnownByToken(trimmed);
                    if (parsed) {
                        if (parsed.kind === 'npc') {
                            if (npcIdSet.has(parsed.id) && !resolvedKnownBy.includes(`npc:${parsed.id}`)) {
                                resolvedKnownBy.push(`npc:${parsed.id}`);
                            }
                        } else if (parsed.kind === 'faction') {
                            const tok = `faction:${parsed.name}`;
                            if (!resolvedKnownBy.includes(tok)) resolvedKnownBy.push(tok);
                        } else if (parsed.kind === 'player') {
                            if (!resolvedKnownBy.includes('player')) resolvedKnownBy.push('player');
                        }
                        continue;
                    }
                    // Legacy bare form: a raw NPC id or NPC name. Resolve to "npc:<id>" token.
                    if (npcIdSet.has(trimmed)) {
                        const tok = `npc:${trimmed}`;
                        if (!resolvedKnownBy.includes(tok)) resolvedKnownBy.push(tok);
                        continue;
                    }
                    const matchedByName = npcNameMap.get(trimmed.toLowerCase());
                    if (matchedByName) {
                        const tok = `npc:${matchedByName}`;
                        if (!resolvedKnownBy.includes(tok)) resolvedKnownBy.push(tok);
                    }
                    // Unrecognized strings that look like faction names (no ":" prefix) — keep as faction token if they contain a space or are multi-word; else drop.
                    else if (/\s/.test(trimmed) || /^[a-z]/i.test(trimmed)) {
                        const f = normalizeFaction(trimmed);
                        if (f && !trimmed.includes(':')) {
                            const tok = `faction:${f}`;
                            if (!resolvedKnownBy.includes(tok)) resolvedKnownBy.push(tok);
                        }
                    }
                }
                if (resolvedKnownBy.length > 0) {
                    knownBy = resolvedKnownBy;
                } else if (rawKnownBy.length === 0) {
                    // Explicit "[]"" from the LLM = secret. Preserve.
                    knownBy = [];
                }
            }

            const cat = coerceCategory(category);

            // Force broadcast for lore/locations (unchanged behavior).
            if (broadcastCategories.has(cat)) {
                knownBy = undefined;
            } else if (sensitiveCategories.has(cat) && knownBy === undefined) {
                // WO2 default-inversion: sensitive category + no knownBy from LLM → seed from scene witnesses.
                const witnesses = witnessesByScene.get(sceneRef);
                if (witnesses && witnesses.size > 0) {
                    knownBy = Array.from(witnesses).map(id => `npc:${id}`);
                }
                // If no witnesses recorded, leave undefined (degrades to public — same as today's behavior for that edge).
            }

            // subjectToken — normalize; missing/malformed → undefined (ungrouped singleton).
            let subjectToken: string | undefined;
            const rawSubjectToken = rawItem.subjectToken;
            if (typeof rawSubjectToken === 'string' && rawSubjectToken.trim()) {
                subjectToken = normalizeSubjectToken(rawSubjectToken);
            }

            entries.push({
                id: `div_${uid()}`,
                chapterId,
                category: cat,
                text,
                sceneRef,
                npcIds: resolvedNpcIds,
                knownBy,
                subjectToken,
                pinned: false,
                source: 'auto',
                reviewFlag: hasReviewFlag || undefined,
                unrecognizedNpcNames: stillUnrecognized.length > 0 ? stillUnrecognized : undefined,
            });
        }
    }

    return entries;
}

function extractWitnessCorrections(parsed: object): Record<string, string[]> | undefined {
    const rawCorrections = (parsed as Record<string, unknown>)['witness_corrections'];
    if (rawCorrections && typeof rawCorrections === 'object' && !Array.isArray(rawCorrections)) {
        const corrections: Record<string, string[]> = {};
        for (const [sceneId, value] of Object.entries(rawCorrections as Record<string, unknown>)) {
            if (Array.isArray(value) && value.every((v: unknown) => typeof v === 'string')) {
                corrections[sceneId] = value as string[];
            }
        }
        if (Object.keys(corrections).length > 0) {
            console.log(`[CombinedSeal] Extracted witness corrections for ${Object.keys(corrections).length} scenes`);
            return corrections;
        }
    }
    return undefined;
}

export function parseCombinedSealOutput(
    raw: string,
    chapterId: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    openThreads?: string[],
    indexEntries?: { sceneId: string; npcsWitnessed?: string[] }[]
): CombinedSealResult {
    const cleaned = stripReasoning(raw);
    const jsonStr = extractJson(cleaned);

    let parsed: { summary?: unknown; divergences?: unknown };
    let divergenceParseError = false;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        console.warn('[CombinedSeal] JSON parse failed on extractJson output, attempting split-object recovery', e);
        // Two back-to-back objects arrive either raw ("} {") or already fused
        // by the engine's repair pass ("},{") — split on both.
        const splitMatch = jsonStr.match(/\}\s*,?\s*\{/);
        if (splitMatch && splitMatch.index !== undefined) {
            const first = jsonStr.slice(0, splitMatch.index + 1);
            const second = jsonStr.slice(splitMatch.index + splitMatch[0].length - 1);
            try {
                const firstObj = JSON.parse(first);
                const secondObj = JSON.parse(second) as Record<string, unknown>;
                parsed = { ...firstObj, ...secondObj };
                console.log('[CombinedSeal] Split-object recovery succeeded');
            } catch {
                const summaryOnly = parseChapterSummaryOutput(raw);
                return { summary: summaryOnly, divergences: [], divergenceParseError: true };
            }
        } else {
            const summaryOnly = parseChapterSummaryOutput(raw);
            return { summary: summaryOnly, divergences: [], divergenceParseError: true };
        }
    }

    console.log('[CombinedSeal] Parsed keys:', Object.keys(parsed as object).join(', '), ', divergences type:', typeof (parsed as Record<string, unknown>).divergences);

    let summary: ChapterSummaryOutput | null = null;
    if (parsed.summary && typeof parsed.summary === 'object') {
        summary = parseChapterSummaryOutput(JSON.stringify(parsed.summary));
    } else {
        summary = parseChapterSummaryOutput(raw);
    }

    let entries: DivergenceEntry[] = [];
    if (parsed.divergences && typeof parsed.divergences === 'object') {
        const divRaw = parsed.divergences as Record<string, unknown[]>;
        const divObj: Record<string, unknown[]> = {};
        for (const [key, val] of Object.entries(divRaw)) {
            const normalized = key.trim().toLowerCase().replace(/[\s-]+/g, '_');
            divObj[normalized] = val as unknown[];
        }
        entries = buildDivergenceEntries(divObj, sceneIds, npcLedger, chapterId, indexEntries);
    } else {
        divergenceParseError = true;
    }

    const witnessCorrections = extractWitnessCorrections(parsed);

    let sceneEventMap: Record<string, SceneEvent[]> | undefined;
    let sceneEventsParseError: boolean | undefined;
    try {
        const rawSceneEvents = (parsed as Record<string, unknown>).sceneEvents;
        if (rawSceneEvents !== undefined) {
            if (typeof rawSceneEvents !== 'object' || rawSceneEvents === null || Array.isArray(rawSceneEvents)) {
                throw new Error('sceneEvents is not an object');
            }
            const VALID_EVENT_TYPES = new Set<string>([
                'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
                'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
            ]);
            const map: Record<string, SceneEvent[]> = {};
            for (const [sceneId, eventsRaw] of Object.entries(rawSceneEvents as Record<string, unknown>)) {
                if (!Array.isArray(eventsRaw)) continue;
                const validEvents: SceneEvent[] = [];
                for (const ev of eventsRaw) {
                    if (!ev || typeof ev !== 'object') continue;
                    const raw = ev as Record<string, unknown>;
                    if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
                    if (typeof raw.importance !== 'number') continue;
                    const eventType: SceneEventType = VALID_EVENT_TYPES.has(raw.eventType as string)
                        ? (raw.eventType as SceneEventType)
                        : 'other';
                    const importance = Math.min(10, Math.max(1, Math.round(raw.importance as number)));
                    const event: SceneEvent = { eventType, importance, text: (raw.text as string).trim() };
                    if (Array.isArray(raw.characters) && raw.characters.length > 0) event.characters = raw.characters.filter((v: unknown): v is string => typeof v === 'string');
                    if (Array.isArray(raw.locations) && raw.locations.length > 0) event.locations = raw.locations.filter((v: unknown): v is string => typeof v === 'string');
                    if (Array.isArray(raw.items) && raw.items.length > 0) event.items = raw.items.filter((v: unknown): v is string => typeof v === 'string');
                    if (Array.isArray(raw.concepts) && raw.concepts.length > 0) event.concepts = raw.concepts.filter((v: unknown): v is string => typeof v === 'string');
                    if (typeof raw.cause === 'string' && raw.cause.trim()) event.cause = raw.cause.trim();
                    if (typeof raw.result === 'string' && raw.result.trim()) event.result = raw.result.trim();
                    validEvents.push(event);
                }
                map[sceneId] = validEvents;
            }
            sceneEventMap = map;
        }
    } catch (e) {
        console.warn('[CombinedSeal] sceneEvents block present but unparseable — ignoring', e);
        sceneEventsParseError = true;
    }

    let resolvedThreads: string[] | undefined;
    try {
        const rawResolved = (parsed as Record<string, unknown>).resolvedThreads;
        if (rawResolved !== undefined) {
            if (Array.isArray(rawResolved)) {
                const openSet = openThreads ? new Set(openThreads) : undefined;
                const filtered = rawResolved
                    .filter((v: unknown): v is string => typeof v === 'string')
                    .map((s: string) => s.trim())
                    .filter((s: string) => s.length > 0);
                if (openSet) {
                    resolvedThreads = filtered.filter((s: string) => openSet.has(s));
                } else {
                    resolvedThreads = filtered;
                }
            }
        }
    } catch {
        // never fail the seal over malformed resolvedThreads
    }

    return { summary, divergences: entries, divergenceParseError: divergenceParseError || undefined, witnessCorrections, sceneEventMap, sceneEventsParseError, resolvedThreads };
}

export async function sealChapterCombined(
    provider: LLMProvider,
    scenes: { sceneId: string; content: string }[],
    chapterId: string,
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    indexEntries?: { sceneId: string; npcsWitnessed?: string[] }[],
    maxRetries = 2,
    openThreads?: string[],
    existingSubjectTokens?: string[]
): Promise<CombinedSealResult> {
    const sealEffort: ThinkingEffort = 'off';
    const maxTokens = SEAL_MAX_TOKENS;

    console.log(`[CombinedSeal] Config: maxTokens=${maxTokens}, thinkingEffort=${sealEffort}, provider.effort=${provider.thinkingEffort ?? 'none'}, apiFormat=${provider.apiFormat ?? 'openai'}`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = buildCombinedSealPrompt(scenes, chapterTitle, sceneIds, npcLedger, indexEntries, openThreads, existingSubjectTokens);
        const label = attempt === 0 ? '' : ' (retry)';

        console.log(`[CombinedSeal] Generating summary + divergences${label}...`, {
            sceneCount: scenes.length,
            sceneIds: sceneIds.length,
            promptTokens: countTokens(prompt),
        });

        let output: string;
        try {
            output = await llmCall(provider, prompt, { priority: 'low', maxTokens, thinkingEffort: sealEffort });
        } catch (err) {
            console.error(`[CombinedSeal] LLM call failed on attempt ${attempt + 1}:`, err);
            if (attempt < maxRetries) continue;
            return { summary: null, divergences: [], divergenceParseError: true };
        }

        const head = output.slice(0, 200);
        const tail = output.length > 200 ? output.slice(-200) : '';
        console.warn(`[CombinedSeal] Output length=${output.length}, head=${JSON.stringify(head)}, tail=${JSON.stringify(tail)}`);

        const result = parseCombinedSealOutput(output, chapterId, sceneIds, npcLedger, openThreads, indexEntries);

        if (result.summary && !result.divergenceParseError) {
            return result;
        }
        if (result.summary && result.divergenceParseError) {
            console.warn(`[CombinedSeal] Attempt ${attempt + 1}: summary OK but divergence parse failed — retrying divergences`);
            continue;
        }
        console.warn(`[CombinedSeal] Attempt ${attempt + 1} produced no usable output`);
    }

    return { summary: null, divergences: [], divergenceParseError: true };
}