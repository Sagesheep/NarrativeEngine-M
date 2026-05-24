import type { LLMProvider, ThinkingEffort, SceneEvent, SceneEventType } from '../types';
import { countTokens } from './tokenizer';
import { extractJson } from './payloadBuilder';
import { llmCall } from '../utils/llmCall';

// ─── Chapter Summary Generator ───

const CHAPTER_SUMMARY_TOKEN_BUDGET = 8000;

export type ChapterSummaryOutput = {
    title: string;
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
};

export function truncateScenesToBudget(
    scenes: { sceneId: string; content: string }[],
    budget: number = CHAPTER_SUMMARY_TOKEN_BUDGET
): { sceneId: string; content: string }[] {
    const totalTokens = scenes.reduce((sum, s) => sum + countTokens(s.content), 0);
    if (totalTokens <= budget) return scenes;

    // Strategy: keep ~20% oldest + ~60% newest, drop middle oldest scenes
    const keepCount = Math.floor(scenes.length * 0.8);
    const dropCount = scenes.length - keepCount;
    const dropFromStart = Math.floor(dropCount * 0.25); // Keep some oldest context
    const dropFromEnd = dropCount - dropFromStart;

    return [
        ...scenes.slice(0, scenes.length - dropFromEnd - dropFromStart),
        ...scenes.slice(scenes.length - dropFromEnd),
    ];
}

function buildChapterSummaryPrompt(
    scenes: { sceneId: string; content: string }[],
    chapterTitle?: string
): string {
    const truncated = truncateScenesToBudget(scenes);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');

    return [
        'You are a TTRPG campaign archivist. Generate a structured chapter summary.',
        '',
        `CHAPTER: ${chapterTitle || 'Untitled'}`,
        `SCENES: ${scenes.length} scenes`,
        '',
        'OUTPUT FORMAT — respond with a JSON object:',
        '{',
        '    "title": "Short evocative chapter title",',
        '    "summary": "3-5 sentence narrative summary of what happened",',
        '    "keywords": ["keyword1", "keyword2", ...],',
        '    "npcs": ["NPC Name 1", "NPC Name 2", ...],',
        '    "majorEvents": ["Event description 1", "Event description 2"],',
        '    "unresolvedThreads": ["Thread 1", "Thread 2"],',
        '    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",',
        '    "themes": ["theme1", "theme2"]',
        '}',
        '',
        'RULES:',
        '1. Keywords should be distinctive nouns/places/factions — not generic words',
        '2. NPCs should include all significant named characters who appeared or were discussed',
        '3. Major events are plot-critical beats only (not every combat round)',
        '4. Unresolved threads are open plot hooks, promises, or mysteries',
        '5. Title should be 2-5 words, evocative',
        '6. Summary should read like a campaign journal entry, not a list',
        '',
        'SCENE CONTENT:',
        sceneContent,
    ].join('\n');
}

/**
 * Extract JSON from LLM output, handling markdown fences and common errors.
 */
export function parseChapterSummaryOutput(raw: string): ChapterSummaryOutput | null {
    const cleaned = extractJson(raw.trim());

    try {
        const parsed = JSON.parse(cleaned);

        // Validate required fields
        const required: (keyof ChapterSummaryOutput)[] = [
            'title', 'summary', 'keywords', 'npcs',
            'majorEvents', 'unresolvedThreads', 'tone', 'themes'
        ];

        for (const field of required) {
            if (!(field in parsed)) {
                console.warn(`[ChapterSummary] Missing field: ${field}`);
                parsed[field] = field === 'summary' || field === 'tone' ? '' : [];
            }
        }

        return parsed as ChapterSummaryOutput;
    } catch (e) {
        console.error('[ChapterSummary] Failed to parse JSON:', e);
        return null;
    }
}

export async function generateChapterSummary(
    provider: LLMProvider,
    scenes: { sceneId: string; content: string }[],
    chapterTitle?: string,
    maxRetries = 1
): Promise<ChapterSummaryOutput | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildChapterSummaryPrompt(scenes, chapterTitle)
            : buildChapterSummaryPrompt(scenes, chapterTitle) +
            '\n\nPREVIOUS ATTEMPT FAILED. Output ONLY valid JSON with all required fields.';

        console.log(`[SaveFileEngine] Generating Chapter Summary... (Attempt ${attempt + 1})`, {
            sceneCount: scenes.length,
            promptTokens: countTokens(prompt)
        });

        const output = await llmCall(provider, prompt);
        const result = parseChapterSummaryOutput(output);

        if (result) {
            return result;
        }
        console.warn(`[SaveFileEngine] Chapter Summary attempt ${attempt + 1} failed parsing`);
    }

    return null;
}

// ─── Combined Seal Call (summary + divergences in ONE LLM call) ───

import type { DivergenceEntry } from '../types';
import { DIVERGENCE_CATEGORIES, CATEGORY_DEFINITIONS, coerceCategory, stripReasoning } from './divergenceRegister';
import { uid } from '../utils/uid';

const COMBINED_SEAL_TOKEN_BUDGET = 12000;

const SEAL_MAX_TOKENS = 32000;

function buildCombinedSealPrompt(
    scenes: { sceneId: string; content: string }[],
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    indexEntries?: { sceneId: string; npcsWitnessed?: string[] }[]
): string {
    const truncated = truncateScenesToBudget(scenes, COMBINED_SEAL_TOKEN_BUDGET);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');

    const npcList = npcLedger.map(n =>
        `- ${n.name} (id: ${n.id}${n.aliases ? ', also known as: ' + n.aliases : ''})`
    ).join('\n');

    const divergenceSlots = DIVERGENCE_CATEGORIES.filter(c => c !== 'misc').map(c =>
        `### ${c.toUpperCase()}\nDefinition: ${CATEGORY_DEFINITIONS[c]}\nOutput: JSON array for this slot, or [] if empty.`
    ).join('\n\n');

    // Build per-scene witness audit table if index data is available
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
         { "text": "Eastern gate destroyed by siege", "sceneRef": "014", "npcIds": [], "unrecognizedNpcNames": [] }
     ]`;

    const knownByRules = `
KNOWNBY RULES:
- knownBy: list the canonical NPC IDs of characters who WITNESSED or could reasonably know this fact.
- For rules_lore and locations categories, knownBy should be omitted or null (broadcast knowledge — everyone can know).
- For npc_events, promises_debts, party_facts, world_state, and misc: list only NPCs who were present or directly informed.
- If the fact is public knowledge (announced publicly, observed by all present), list all witnesses.
- If unsure who knows, omit knownBy (treated as broadcast).`;

    return `You are a TTRPG campaign archivist. Perform TWO tasks in a single response:

TASK 1 — Generate a structured chapter summary.
TASK 2 — Extract established facts that would BREAK A FUTURE SCENE if the AI contradicted them.

CHAPTER: "${chapterTitle || 'Untitled'}"
SCENE IDs IN THIS CHAPTER: ${sceneIds.join(', ')}

NPC LEDGER (resolve names to IDs):
${npcList || '(no NPCs in ledger)'}
${witnessAuditSection}
SCENE CONTENT:
${sceneContent}

OUTPUT FORMAT — a single JSON object with the keys "summary", "divergences", and optionally "sceneEvents".

The "summary" value must be this JSON shape:
{
    "title": "Short evocative chapter title",
    "summary": "3-5 sentence narrative summary of what happened",
    "keywords": ["keyword1", "keyword2"],
    "npcs": ["NPC Name 1", "NPC Name 2"],
    "majorEvents": ["Event description 1", "Event description 2"],
    "unresolvedThreads": ["Thread 1", "Thread 2"],
    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",
    "themes": ["theme1", "theme2"]
}

The "divergences" value must be an object with one key per category slot. Each value is an array of fact objects, or [] if empty. Example:
{
${knownByExample},
     "npc_events": [
         { "text": "Grak allied with the player", "sceneRef": "018", "npcIds": ["npc_42"], "knownBy": ["npc_42", "npc_5"], "unrecognizedNpcNames": [] }
     ],
     "promises_debts": [],
     "world_state": [],
     "party_facts": [],
     "rules_lore": [],
     "misc": []
}

The "sceneEvents" value must be an object mapping scene IDs to arrays of structured event objects, or {} if no scenes had meaningful events. Example:
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
}

SCENE EVENT RULES:
- eventType MUST be one of: combat, discovery, item_acquired, item_lost, relationship_shift, travel, promise, betrayal, death, revelation, quest_milestone, other
- importance is 1-10 (same scale as chapter importance)
- text is one short sentence describing what happened
- characters/locations/items/concepts are optional arrays of canonical names (use NPC names from the ledger above when possible)
- cause/result are short plain-text causal beats (one short clause each, optional)
- Cap at MAXIMUM 3 events per scene. Skip scenes with nothing meaningful (use [] or omit the scene key).
- Only include scenes from this chapter's scene IDs.

Category definitions:

${divergenceSlots}

### MISC
Definition: ${CATEGORY_DEFINITIONS.misc}
Output: JSON array for this slot, or [] if empty.

${knownByRules}

DIVERGENCE EXTRACTION RULES:
- Each fact is ONE SHORT SENTENCE, max 15 words. No compound sentences, no explanations.
- sceneRef must be one of: ${sceneIds.join(', ')}
- npcIds: list the NPC ledger IDs mentioned. If a name appears that is NOT in the ledger, put it in unrecognizedNpcNames instead.
- Focus on: permanent changes, new information, relationship shifts, acquisitions, losses, oaths, regime changes.
- Skip transient details, emotional narration, momentary states, and anything the archive would already surface.
- If a slot is empty, output [] for that slot.${witnessAuditSection ? `

WITNESS CORRECTIONS:
If you found errors in the per-scene witness data above, include a "witness_corrections" key at the top level of the divergences object:
"witness_corrections": { "014": ["npc_5", "npc_7"], "022": ["npc_42"] }
This maps scene IDs to the CORRECT list of NPC IDs who were physically present in that scene. Only include scenes where you disagree with the pre-captured data.` : ''}

SUMMARY RULES:
1. Keywords should be distinctive nouns/places/factions — not generic words
2. NPCs should include all significant named characters who appeared or were discussed
3. Major events are plot-critical beats only (not every combat round)
4. Unresolved threads are open plot hooks, promises, or mysteries
5. Title should be 2-5 words, evocative
6. Summary should read like a campaign journal entry, not a list

Respond with ONE JSON object only. No prose, no markdown fences, no second object, no reasoning before or after.`;
}

export type CombinedSealResult = {
    summary: ChapterSummaryOutput | null;
    divergences: DivergenceEntry[];
    divergenceParseError?: boolean;
    witnessCorrections?: Record<string, string[]>;
    sceneEventMap?: Record<string, SceneEvent[]>; // sceneId -> events (sceneId zero-padded e.g. "014")
    sceneEventsParseError?: boolean;              // true if events block was present but unparseable
};

function buildDivergenceEntries(
    divObj: Record<string, unknown[]>,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    chapterId: string
): DivergenceEntry[] {
    const entries: DivergenceEntry[] = [];
    const sceneSet = new Set(sceneIds);
    const fallbackScene = sceneIds[0] ?? '000';
    const npcNameMap = new Map<string, string>();
    for (const npc of npcLedger) {
        npcNameMap.set(npc.name.toLowerCase(), npc.id);
        if (npc.aliases) {
            for (const alias of npc.aliases.split(',')) {
                npcNameMap.set(alias.trim().toLowerCase(), npc.id);
            }
        }
    }

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

            // ── knownBy extraction ──
            let knownBy: string[] | undefined;
            const rawKnownBy = rawItem.knownBy;
            if (Array.isArray(rawKnownBy)) {
                const resolvedKnownBy: string[] = [];
                for (const kb of rawKnownBy) {
                    if (typeof kb !== 'string') continue;
                    const matched = npcNameMap.get(kb.toLowerCase()) ?? (npcLedger.some(n => n.id === kb) ? kb : null);
                    if (matched && !resolvedKnownBy.includes(matched)) {
                        resolvedKnownBy.push(matched);
                    }
                }
                if (resolvedKnownBy.length > 0) {
                    knownBy = resolvedKnownBy;
                }
            }
            // Broadcast categories: knownBy stays undefined for rules_lore and locations
            const broadcastCategories: Set<string> = new Set(['rules_lore', 'locations']);
            if (broadcastCategories.has(coerceCategory(category))) {
                knownBy = undefined;
            }

            entries.push({
                id: `div_${uid()}`,
                chapterId,
                category: coerceCategory(category),
                text,
                sceneRef,
                npcIds: resolvedNpcIds,
                knownBy,
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
    npcLedger: { id: string; name: string; aliases: string }[]
): CombinedSealResult {
    const cleaned = stripReasoning(raw);
    const jsonStr = extractJson(cleaned);

    let parsed: { summary?: unknown; divergences?: unknown };
    let divergenceParseError = false;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        console.warn('[CombinedSeal] JSON parse failed on extractJson output, attempting split-object recovery', e);
        const splitMatch = jsonStr.match(/\}\s*\{/);
        if (splitMatch && splitMatch.index !== undefined) {
            const first = jsonStr.slice(0, splitMatch.index + 1);
            const second = jsonStr.slice(splitMatch.index + 1);
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
        entries = buildDivergenceEntries(divObj, sceneIds, npcLedger, chapterId);
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

    return { summary, divergences: entries, divergenceParseError: divergenceParseError || undefined, witnessCorrections, sceneEventMap, sceneEventsParseError };
}

export async function sealChapterCombined(
    provider: LLMProvider,
    scenes: { sceneId: string; content: string }[],
    chapterId: string,
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    indexEntries?: { sceneId: string; npcsWitnessed?: string[] }[],
    maxRetries = 2
): Promise<CombinedSealResult> {
    const sealEffort: ThinkingEffort = 'off';
    const maxTokens = SEAL_MAX_TOKENS;

    console.log(`[CombinedSeal] Config: maxTokens=${maxTokens}, thinkingEffort=${sealEffort}, provider.effort=${provider.thinkingEffort ?? 'none'}, apiFormat=${provider.apiFormat ?? 'openai'}`);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = buildCombinedSealPrompt(scenes, chapterTitle, sceneIds, npcLedger, indexEntries);
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

        const result = parseCombinedSealOutput(output, chapterId, sceneIds, npcLedger);

        if (result.summary && !result.divergenceParseError) {
            return result;
        }
        if (result.summary && result.divergenceParseError) {
            console.warn(`[CombinedSeal] Attempt ${attempt + 1}: summary OK but divergence parse failed — retrying divergences`);
            continue;
        }
        // sceneEventsParseError alone is a soft failure — do not retry on its behalf
        console.warn(`[CombinedSeal] Attempt ${attempt + 1} produced no usable output`);
    }

    return { summary: null, divergences: [], divergenceParseError: true };
}
