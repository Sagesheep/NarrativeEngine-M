import type { LLMProvider, DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveChapter, PrunedEntry, ArchiveIndexEntry, ChatMessage } from '../types';
import { llmCall } from '../utils/llmCall';
import { uid } from '../utils/uid';
import { countTokens } from './tokenizer';
import { extractJson } from './payloadBuilder';

export const IMPORTANCE_GATE = 7;

export const EMPTY_REGISTER: DivergenceRegister = {
    entries: [],
    prunedLog: [],
    lastUpdatedSceneId: '',
    lastUpdatedAt: 0,
    version: 1,
};

const VALID_CATEGORIES: ReadonlySet<DivergenceCategory> = new Set([
    'canon_override', 'world_change', 'entity_state', 'player_state', 'obligation',
]);

const BULLET_RE = /^\s*-?\s*\[\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*scene\s*:\s*([^|\]]+?)\s*(?:\|\s*supersedes\s*:\s*([^|\]]+?)\s*)?\]\s*(.+?)\s*$/i;

export function stripReasoning(raw: string): string {
    let clean = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, '');
    const fence = clean.match(/```(?:\w+)?\s*([\s\S]*?)```/);
    if (fence) clean = fence[1];
    return clean.trim();
}

type ParsedBullet = {
    category: DivergenceCategory;
    subject: string;
    divergence: string;
    sceneRef: string;
    supersedes?: string;
    parseError?: boolean;
};

export function parseBulletDivergences(raw: string, validSceneIds: string[]): ParsedBullet[] {
    const cleaned = stripReasoning(raw);
    const fallbackScene = validSceneIds[0] ?? '000';
    const sceneSet = new Set(validSceneIds);
    const out: ParsedBullet[] = [];

    for (const rawLine of cleaned.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^none$/i.test(line)) continue;
        if (/^(here|the|note|output|entries|new|existing)\b/i.test(line) && !line.includes('[')) continue;

        const m = line.match(BULLET_RE);
        if (!m) {
            out.push({
                category: 'entity_state',
                subject: line.slice(0, 40),
                divergence: line,
                sceneRef: fallbackScene,
                parseError: true,
            });
            continue;
        }
        const [, catRaw, subjectRaw, sceneRaw, supersedesRaw, divergenceRaw] = m;
        const catNorm = catRaw.toLowerCase().replace(/\s+/g, '_') as DivergenceCategory;
        const category: DivergenceCategory = VALID_CATEGORIES.has(catNorm) ? catNorm : 'entity_state';
        const sceneRef = sceneSet.has(sceneRaw) ? sceneRaw : fallbackScene;
        out.push({
            category,
            subject: subjectRaw,
            divergence: divergenceRaw,
            sceneRef,
            supersedes: supersedesRaw || undefined,
        });
    }

    return out;
}

function buildExtractionPrompt(
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister,
    multiScene?: boolean
): string {
    const registerLines = currentRegister.entries.length > 0
        ? currentRegister.entries.map(e =>
            `${e.id} [Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
        ).join('\n')
        : '(empty)';
    const registerTokens = countTokens(registerLines);

    const sceneNote = multiScene
        ? 'The scene text below contains messages from multiple scenes, marked with [Scene #XX] headers. Use the matching scene number for each fact.'
        : `Use scene:${sceneId} for every fact unless the text explicitly attributes it to a different scene number.`;

    return `EXISTING REGISTER (${registerTokens} tokens) — facts already captured. Do NOT re-extract these. Only add NEW facts, or use "supersedes:ID" when a new fact updates an existing one above.
${registerLines}

NEW SCENE TEXT (Scene #${sceneId}):
${sceneText}

TASK:
1. Rate this scene's importance 1-10 on the FIRST line as: importance:N
2. ${sceneNote}
3. Extract every story-relevant fact that affects future continuity (NPC states, items, locations, relationships, abilities, debuffs, quest progress, obligations, world state, canon overrides).

Categories (use exactly one per line): canon_override, world_change, entity_state, player_state, obligation.

Output format — one divergence per line after the importance line, no JSON, no markdown:
- [category | subject | scene:NNN] divergence sentence
- [category | subject | scene:NNN | supersedes:ID] divergence sentence

Preserve proper nouns exactly. If there are NO divergences, output only the importance line.`;
}

export async function extractDivergences(
    provider: LLMProvider,
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister,
    options?: { forceExtract?: boolean; multiScene?: boolean }
): Promise<{ result: { importance: number } | null; entries: DivergenceEntry[] }> {
    const prompt = buildExtractionPrompt(sceneText, sceneId, currentRegister, options?.multiScene);

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 800 });
        const cleaned = stripReasoning(raw);

        const impMatch = cleaned.match(/importance\s*:\s*(\d{1,2})/i);
        const importance = impMatch ? Math.min(10, Math.max(1, parseInt(impMatch[1], 10))) : 5;

        const validIds = options?.multiScene
            ? Array.from(new Set([sceneId, ...Array.from(cleaned.matchAll(/scene\s*:\s*([0-9a-z_-]+)/gi)).map(m => m[1])]))
            : [sceneId];

        const parsed = parseBulletDivergences(cleaned, validIds);

        if (!options?.forceExtract && !options?.multiScene && importance < IMPORTANCE_GATE && parsed.length === 0) {
            return { result: { importance }, entries: [] };
        }

        const entries: DivergenceEntry[] = parsed.map(ne => ({
            id: `div_${uid()}`,
            category: ne.category,
            subject: ne.subject,
            divergence: ne.divergence,
            sceneRef: ne.sceneRef || sceneId,
            linkedSceneIds: [ne.sceneRef || sceneId],
            importance,
            supersedes: ne.supersedes,
            source: options?.forceExtract ? 'manual' : 'auto',
            parseError: ne.parseError,
        }));

        return { result: { importance }, entries };
    } catch (err) {
        console.warn('[DivergenceRegister] Extraction failed:', err);
        return { result: null, entries: [] };
    }
}

export function mergeEntries(
    register: DivergenceRegister,
    newEntries: DivergenceEntry[],
    sceneId: string
): DivergenceRegister {
    if (newEntries.length === 0) return register;

    const supersedeIds = new Set(newEntries.filter(e => e.supersedes).map(e => e.supersedes!));
    const surviving = register.entries.filter(e => !supersedeIds.has(e.id));

    const merged = [...surviving];
    for (const ne of newEntries) {
        const existing = ne.supersedes ? register.entries.find(e => e.id === ne.supersedes) : null;
        if (existing) {
            merged.push({
                ...ne,
                linkedSceneIds: [...new Set([...existing.linkedSceneIds, ...ne.linkedSceneIds])],
                importance: Math.max(existing.importance, ne.importance),
            });
        } else {
            merged.push(ne);
        }
    }

    merged.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));

    return {
        entries: merged,
        prunedLog: register.prunedLog ?? [],
        lastUpdatedSceneId: sceneId,
        lastUpdatedAt: Date.now(),
        version: register.version,
    };
}

export function renderRegisterForPayload(register: DivergenceRegister): string {
    if (register.entries.length === 0) return '';

    const byCategory: Record<string, DivergenceEntry[]> = {};
    for (const e of register.entries) {
        if (e.category === 'obligation' && e.resolved) continue;
        const cat = e.category;
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(e);
    }

    const sections: string[] = [];
    const catLabels: Record<string, string> = {
        canon_override: 'CANON OVERRIDES',
        world_change: 'WORLD CHANGES',
        entity_state: 'NPC & ENTITY FATES',
        player_state: 'PLAYER STATE',
        obligation: 'OBLIGATIONS',
    };

    for (const [cat, entries] of Object.entries(byCategory)) {
        const label = catLabels[cat] || cat.toUpperCase();
        const lines = entries.map(e => {
            const marker = e.source === 'manual' ? ' ⚡' : '';
            const resolved = e.category === 'obligation' && !e.resolved ? ' — UNRESOLVED' : '';
            return `• ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]${marker}${resolved}`;
        });
        sections.push(`${label}:\n${lines.join('\n')}`);
    }

    const latestScene = register.entries.reduce((max, e) =>
        parseInt(e.sceneRef) > parseInt(max) ? e.sceneRef : max, '000'
    );

    return `[CAMPAIGN DIVERGENCE REGISTER — AUTHORITATIVE OVERRIDES]\n[Last updated: Scene #${register.lastUpdatedSceneId || latestScene}]\nThese facts are TRUE in this campaign and override your training data.\n\n${sections.join('\n\n')}\n[END DIVERGENCE REGISTER]`;
}

export function getDivergenceSceneIds(register: DivergenceRegister): Set<string> {
    const ids = new Set<string>();
    for (const e of register.entries) {
        ids.add(e.sceneRef);
        for (const sid of e.linkedSceneIds) ids.add(sid);
    }
    return ids;
}

export function countRegisterTokens(register: DivergenceRegister): number {
    return countTokens(renderRegisterForPayload(register));
}

export async function compressRegister(
    provider: LLMProvider,
    register: DivergenceRegister,
    targetTokens: number
): Promise<DivergenceRegister> {
    const protected_ = register.entries.filter(e => e.importance >= 9);
    const compressible = register.entries.filter(e => e.importance < 9);

    if (compressible.length === 0) return register;

    const currentTokens = countRegisterTokens(register);
    if (currentTokens <= targetTokens) return register;

    const compressibleText = compressible.map(e =>
        `[Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
    ).join('\n');

    const prompt = `You are compressing part of a campaign divergence register to fit a token budget.

ENTRIES TO COMPRESS (${countTokens(compressibleText)} tokens, target: ${targetTokens} tokens):
${compressibleText}

COMPRESSION RULES:
1. Importance 7-8: Compress to one line but keep all proper nouns.
2. Importance 5-6: Aggressively compress. Merge related entries by subject.
3. Importance ≤ 4: Drop if superseded. Merge into parent if related.
4. If an item was ACQUIRED then LOST/TRADED, merge into one line noting final state.
5. Preserve ALL proper nouns exactly as written.
6. Preserve sceneRef on each output entry (use earliest sceneRef when merging).
7. Target: ${targetTokens} tokens.

OUTPUT: JSON array of entries: [{ "category": "...", "subject": "...", "divergence": "...", "sceneRef": "...", "importance": <number>, "linkedSceneIds": ["..."], "source": "auto" }]`;

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 1000 });
        const jsonStr = extractJson(raw);
        const compressed = JSON.parse(jsonStr) as Array<Partial<DivergenceEntry>>;

        const newEntries: DivergenceEntry[] = compressed.map(ce => ({
            id: `div_${uid()}`,
            category: ce.category || 'entity_state',
            subject: ce.subject || '',
            divergence: ce.divergence || '',
            sceneRef: ce.sceneRef || '000',
            linkedSceneIds: ce.linkedSceneIds || [],
            importance: ce.importance ?? 5,
            source: ce.source || 'auto',
        }));

        const merged = [...protected_, ...newEntries];
        merged.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));

        return {
            entries: merged,
            prunedLog: register.prunedLog ?? [],
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergenceRegister] Compression failed:', err);
        return register;
    }
}

export async function structureManualEntry(
    provider: LLMProvider,
    freeText: string
): Promise<{ category: DivergenceCategory; subject: string; divergence: string } | null> {
    const prompt = `A player described a campaign divergence in free text. Structure it into fields.

Player text: "${freeText}"

OUTPUT JSON only: { "category": "<canon_override|world_change|entity_state|player_state|obligation>", "subject": "<entity affected>", "divergence": "<one-line factual statement>" }`;

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 200 });
        const jsonStr = extractJson(raw);
        return JSON.parse(jsonStr);
    } catch (err) {
        console.warn('[DivergenceRegister] Manual structuring failed:', err);
        return null;
    }
}

export function getEntriesForSceneRange(
    register: DivergenceRegister,
    sceneRange: [string, string]
): DivergenceEntry[] {
    const startNum = parseInt(sceneRange[0], 10);
    const endNum = parseInt(sceneRange[1], 10);
    return register.entries.filter(e => {
        const refNum = parseInt(e.sceneRef, 10);
        return refNum >= startNum && refNum <= endNum;
    });
}

function buildPrunePrompt(
    chapter: ArchiveChapter,
    entries: DivergenceEntry[],
    allChapters: ArchiveChapter[]
): string {
    const npcSet = new Set<string>();
    for (const ch of allChapters) {
        for (const npc of (ch.npcs ?? [])) {
            npcSet.add(npc.toLowerCase());
        }
    }
    const recurringNpcs = [...npcSet];

    const entryLines = entries.map(e =>
        `${e.id} | ${e.category} | ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]`
    ).join('\n');

    const threadLines = (chapter.unresolvedThreads ?? []).length > 0
        ? chapter.unresolvedThreads.join('\n- ')
        : '(none)';

    return `You are pruning a campaign divergence register after a chapter was sealed.

CHAPTER: "${chapter.title}" (Scenes ${chapter.sceneRange[0]}-${chapter.sceneRange[1]})
SUMMARY: ${chapter.summary || '(no summary yet)'}
UNRESOLVED THREADS:
- ${threadLines}
RECURRING NPCs ACROSS ALL CHAPTERS: ${recurringNpcs.join(', ') || '(none)'}

ENTRIES FROM THIS CHAPTER:
${entryLines}

CLASSIFY each entry as exactly one of:
- KEEP: Clearly future-relevant (recurring character detail, relationship beat, permanent world change, lore rule, unresolved thread context)
- PRUNE: Clearly disposable (one-time location the party permanently left, transient action state, entry fully superseded by a newer one)
- REVIEW: Uncertain — could be a callback opportunity or could be noise. Human decides.

DECISION RULES:
1. KEEP entries about characters who appear in the recurring NPC list
2. KEEP relationship beats and emotional moments
3. KEEP permanent world changes, lore, and rules that affect future scenes
4. KEEP unresolved thread context
5. PRUNE one-time location descriptions for places the party has permanently left
6. PRUNE transient momentary states unless they involve a recurring character meaningfully
7. PRUNE entries fully superseded by a newer entry capturing the final state
8. When genuinely unsure, classify as REVIEW — a human will decide

OUTPUT: JSON array only, no other text:
[{ "id": "...", "verdict": "keep"|"prune"|"review", "reason": "short explanation" }]`;
}

export async function pruneChapterEntries(
    provider: LLMProvider,
    chapter: ArchiveChapter,
    register: DivergenceRegister,
    allChapters: ArchiveChapter[]
): Promise<DivergenceRegister> {
    const chapterEntries = getEntriesForSceneRange(register, chapter.sceneRange);
    if (chapterEntries.length === 0) return register;

    const prompt = buildPrunePrompt(chapter, chapterEntries, allChapters);

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 1000 });
        const jsonStr = extractJson(raw);
        const classifications = JSON.parse(jsonStr) as Array<{ id: string; verdict: 'keep' | 'prune' | 'review'; reason: string }>;

        const classMap = new Map(classifications.map(c => [c.id, c]));

        const keptEntries: DivergenceEntry[] = [];
        const newPruned: PrunedEntry[] = [];
        const outsideEntries = register.entries.filter(e => {
            const refNum = parseInt(e.sceneRef, 10);
            return refNum < parseInt(chapter.sceneRange[0], 10) || refNum > parseInt(chapter.sceneRange[1], 10);
        });

        for (const entry of chapterEntries) {
            const cls = classMap.get(entry.id);
            if (!cls || cls.verdict === 'keep') {
                keptEntries.push(entry);
            } else if (cls.verdict === 'review') {
                keptEntries.push({ ...entry, reviewFlag: true });
            } else {
                newPruned.push({
                    originalEntry: entry,
                    prunedAt: Date.now(),
                    chapterId: chapter.chapterId,
                    verdict: 'auto_pruned',
                    reason: cls?.reason ?? 'Classified as prune during chapter seal',
                });
            }
        }

        const merged = [...outsideEntries, ...keptEntries];
        merged.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));

        const existingPruned = register.prunedLog ?? [];

        console.log(`[DivergencePrune] Chapter ${chapter.chapterId}: ${outsideEntries.length} outside, ${keptEntries.filter(e => !e.reviewFlag).length} kept, ${keptEntries.filter(e => e.reviewFlag).length} flagged for review, ${newPruned.length} pruned`);

        return {
            entries: merged,
            prunedLog: [...existingPruned, ...newPruned],
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergencePrune] Pruning failed, register unchanged:', err);
        return register;
    }
}

function buildBatchExtractionPrompt(
    scenesText: string,
    sceneIds: string[],
    currentRegister: DivergenceRegister
): string {
    const registerLines = currentRegister.entries.length > 0
        ? currentRegister.entries.map(e =>
            `${e.id} [Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
        ).join('\n')
        : '(empty)';
    const registerTokens = countTokens(registerLines);
    const sceneLabel = sceneIds.length === 1 ? `Scene #${sceneIds[0]}` : `Scenes #${sceneIds.join(', #')}`;

    return `EXISTING REGISTER (${registerTokens} tokens) — facts already captured. Do NOT re-extract these. Only add NEW facts, or use "supersedes:ID" when a new fact updates an existing entry above.
${registerLines}

NEW SCENES TEXT (${sceneLabel}):
${scenesText}

TASK: Extract every story-relevant fact that affects future continuity from these scenes. Examples: NPC states (alive/dead/wounded/fled), items acquired/lost/traded, locations discovered/destroyed/changed, relationships formed/broken, abilities gained/lost, debuffs or curses applied, quest progress, obligations or oaths made, world state changes, canon overrides.

Categories (use exactly one per line):
- canon_override — contradicts source material
- world_change — permanent map / world state
- entity_state — NPCs, items, factions
- player_state — abilities, titles, curses
- obligation — debts, promises, oaths

Output format — one divergence per line, no JSON, no markdown:
- [category | subject | scene:NNN] divergence sentence
- [category | subject | scene:NNN | supersedes:ID] divergence sentence

Rules:
- scene:NNN must be one of: ${sceneIds.join(', ')}.
- Preserve proper nouns exactly.
- One sentence per line.
- If there are NO new divergences, output a single line: NONE`;
}

export async function extractFromMessageBatch(
    provider: LLMProvider,
    messages: ChatMessage[],
    sceneIdsByMessageId: Record<string, string>,
    currentRegister: DivergenceRegister,
    contextLimit: number,
    signal?: AbortSignal,
    divergenceScanBudget?: number,
): Promise<{
    newEntries: DivergenceEntry[];
    supersedes: Array<{ oldId: string; newId: string }>;
    reason?: 'no-scene-mapping';
    parseFailures: number;
    chunkCount: number;
}> {
    if (messages.length === 0) return { newEntries: [], supersedes: [], parseFailures: 0, chunkCount: 0 };

    const scenesBySceneId = new Map<string, { sceneId: string; parts: string[] }>();
    for (const msg of messages) {
        const sceneId = sceneIdsByMessageId[msg.id];
        if (!sceneId) continue;
        if (!scenesBySceneId.has(sceneId)) {
            scenesBySceneId.set(sceneId, { sceneId, parts: [] });
        }
        scenesBySceneId.get(sceneId)!.parts.push(`[${msg.role.toUpperCase()}]: ${msg.content}`);
    }

    if (scenesBySceneId.size === 0) {
        console.error('[DivergenceRegister] No messages mapped to scene IDs — extraction skipped. ' +
            `messages=${messages.length}, mappedIds=${Object.keys(sceneIdsByMessageId).length}. ` +
            'Likely cause: archiveIndex out of sync with chat messages (post-retcon or append failure).');
        return { newEntries: [], supersedes: [], reason: 'no-scene-mapping' as const, parseFailures: 0, chunkCount: 0 };
    }

    const sceneEntries = [...scenesBySceneId.values()].map(s => ({
        sceneId: s.sceneId,
        text: s.parts.join('\n'),
    }));

    const defaultBudget = Math.floor(contextLimit * 0.75);
    const CHUNK_BUDGET = divergenceScanBudget && divergenceScanBudget > 0
        ? divergenceScanBudget
        : defaultBudget;
    const chunks: Array<typeof sceneEntries> = [];
    let currentChunk: typeof sceneEntries = [];
    let currentTokens = 0;

    for (const scene of sceneEntries) {
        const cost = countTokens(scene.text);
        if (currentTokens + cost > CHUNK_BUDGET && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }
        currentChunk.push(scene);
        currentTokens += cost;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const allNewEntries: DivergenceEntry[] = [];
    const allSupersedes: Array<{ oldId: string; newId: string }> = [];
    let parseFailures = 0;

    for (const chunk of chunks) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const combinedText = chunk.map(s => `[Scene #${s.sceneId}]:\n${s.text}`).join('\n\n');
        const sceneIds = chunk.map(s => s.sceneId);
        const prompt = buildBatchExtractionPrompt(combinedText, sceneIds, currentRegister);

        try {
            const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 1200, signal });
            const parsed = parseBulletDivergences(raw, sceneIds);
            for (const ne of parsed) {
                const entry: DivergenceEntry = {
                    id: `div_${uid()}`,
                    category: ne.category,
                    subject: ne.subject,
                    divergence: ne.divergence,
                    sceneRef: ne.sceneRef,
                    linkedSceneIds: [...sceneIds],
                    importance: 5,
                    supersedes: ne.supersedes,
                    source: 'auto',
                    parseError: ne.parseError,
                };
                allNewEntries.push(entry);
                if (ne.supersedes) {
                    allSupersedes.push({ oldId: ne.supersedes, newId: entry.id });
                }
                if (ne.parseError) parseFailures++;
            }
        } catch (err) {
            if ((err as Error).name === 'AbortError') throw err;
            console.warn('[DivergenceRegister] Batch extraction chunk failed:', err);
            parseFailures++;
        }
    }

    return { newEntries: allNewEntries, supersedes: allSupersedes, parseFailures, chunkCount: chunks.length };
}

export function buildSceneMap(
    archiveIndex: ArchiveIndexEntry[],
    messages: ChatMessage[]
): { sceneIdsByMessageId: Record<string, string>; index: Array<{ sceneId: string; importance?: number }> } {
    const sceneIdsByMessageId: Record<string, string> = {};
    const userMessages = messages.filter(m => m.role === 'user');
    const pairCount = Math.min(userMessages.length, archiveIndex.length);
    const userTail = userMessages.slice(-pairCount);
    const archiveTail = archiveIndex.slice(-pairCount);
    for (let i = 0; i < pairCount; i++) {
        sceneIdsByMessageId[userTail[i].id] = archiveTail[i].sceneId;
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'assistant' && !sceneIdsByMessageId[msg.id]) {
            let found = false;
            for (let j = i - 1; j >= 0; j--) {
                if (messages[j].role === 'user' && sceneIdsByMessageId[messages[j].id]) {
                    sceneIdsByMessageId[msg.id] = sceneIdsByMessageId[messages[j].id];
                    found = true;
                    break;
                }
            }
            if (!found) {
                sceneIdsByMessageId[msg.id] = '000';
            }
        }
    }

    return {
        sceneIdsByMessageId,
        index: archiveIndex.map(e => ({ sceneId: e.sceneId, importance: e.importance })),
    };
}

export function confirmReviewEntry(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, reviewFlag: false } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function deleteReviewedEntry(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entry = register.entries.find(e => e.id === entryId);
    if (!entry) return register;

    const entries = register.entries.filter(e => e.id !== entryId);
    const newPruned: PrunedEntry = {
        originalEntry: entry,
        prunedAt: Date.now(),
        chapterId: '',
        verdict: 'user_deleted_review',
        reason: 'User manually deleted after review',
    };
    const prunedLog = [...(register.prunedLog ?? []), newPruned];

    return { ...register, entries, prunedLog, lastUpdatedAt: Date.now() };
}

export function restorePrunedEntry(register: DivergenceRegister, prunedIndex: number): DivergenceRegister {
    const prunedLog = register.prunedLog ?? [];
    if (prunedIndex < 0 || prunedIndex >= prunedLog.length) return register;

    const restored = prunedLog[prunedIndex];
    const entry: DivergenceEntry = { ...restored.originalEntry, reviewFlag: false };

    const newLog = prunedLog.filter((_, i) => i !== prunedIndex);
    const entries = [...register.entries, entry];
    entries.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));

    return { ...register, entries, prunedLog: newLog, lastUpdatedAt: Date.now() };
}

function repairTruncatedJson(str: string): string {
    let s = str.trim();
    const lastBrace = s.lastIndexOf('}');
    const lastBracket = s.lastIndexOf(']');
    const cut = Math.max(lastBrace, lastBracket);
    if (cut !== -1) {
        s = s.substring(0, cut + 1).trim();
    }
    if (!s.endsWith(']')) s += ']';
    s = s.replace(/,\s*]/g, ']');
    s = s.replace(/,\s*}/g, '}');
    s = s.replace(/}\s*\{/g, '},{');
    return s;
}

export async function mergeSimilarEntries(
    provider: LLMProvider,
    register: DivergenceRegister
): Promise<DivergenceRegister> {
    if (register.entries.length === 0) return register;

    const entryLines = register.entries.map(e =>
        `${e.id} | ${e.category} | ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]`
    ).join('\n');

    const prompt = `Merge adjacent or same-subject divergence entries into fewer, denser entries. This is a CAMPAIGN TRUTH register — not a story log. Clusters of micro-beat entries about the same character/subject should collapse into one entry capturing the final state.

ENTRIES:
${entryLines}

RULES:
- Identify clusters sharing the same subject. Group them.
- For each cluster, keep only the entry(s) that represent the CURRENT final state. If 7 entries trace an emotional arc, output 1 entry summarizing the arc's outcome.
- Merge transient micro-beats into their parent entry. "Bram was nervous" + "Bram's hands dropped" + "Bram asked hopefully" → "Bram is emotionally fragile but drawn to Soren's encouragement"
- Drop entries fully superseded: if entry A says "shallow reserves" and entry B says "true depth concealed," keep B, drop A.
- Preserve ALL proper nouns. Keep the earliest sceneRef in the cluster.
- If only 1 entry exists for a subject, keep it as-is unless it's clearly a transient moment (one-time state no longer true).
- Output EVERY entry from the input. For entries you merge, omit them and add a new merged entry. For entries you keep unchanged, include them verbatim.

OUTPUT: JSON array of entries. List ALL entries that should remain in the register — kept originals + new merged entries. Drop entries that are consumed by a merge.
[{ "category": "...", "subject": "...", "divergence": "...", "sceneRef": "...", "importance": <number>, "linkedSceneIds": ["..."], "source": "auto" }]`;

    try {
        const entryCount = register.entries.length;
        const outputTokens = Math.min(64000, Math.max(8000, entryCount * 120));
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: outputTokens });
        const cleaned = stripReasoning(raw);
        const jsonStr = extractJson(cleaned);

        let merged: Array<Partial<DivergenceEntry>> = [];
        try {
            merged = JSON.parse(jsonStr) as typeof merged;
            if (!Array.isArray(merged)) merged = [];
        } catch {
            const repaired = repairTruncatedJson(jsonStr);
            try {
                merged = JSON.parse(repaired) as typeof merged;
                if (!Array.isArray(merged)) merged = [];
            } catch {
                console.warn('[DivergenceMerge] JSON repair failed, raw output:', cleaned.slice(0, 500));
            }
        }

        if (!Array.isArray(merged) || merged.length === 0) {
            return register;
        }

        const newEntries: DivergenceEntry[] = merged.map(ce => ({
            id: `div_${uid()}`,
            category: ce.category || 'entity_state',
            subject: ce.subject || '',
            divergence: ce.divergence || '',
            sceneRef: ce.sceneRef || '000',
            linkedSceneIds: ce.linkedSceneIds || [ce.sceneRef || '000'],
            importance: ce.importance ?? 5,
            source: ce.source || 'auto',
        }));

        newEntries.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));

        console.log(`[DivergenceMerge] ${register.entries.length} entries → ${newEntries.length} entries`);

        return {
            entries: newEntries,
            prunedLog: register.prunedLog ?? [],
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergenceMerge] Merge failed, register unchanged:', err);
        return register;
    }
}

export function backfillParseErrors(register: DivergenceRegister): DivergenceRegister {
    if (!register.entries.some(e => e.parseError)) return register;

    const allSceneIds = Array.from(getDivergenceSceneIds(register));
    let changed = false;

    const entries = register.entries.map(e => {
        if (!e.parseError) return e;

        const reconstructed = `- ${e.category} | ${e.subject} | scene:${e.sceneRef} | ${e.divergence}`;
        const parsed = parseBulletDivergences(reconstructed, allSceneIds.length > 0 ? allSceneIds : [e.sceneRef]);

        if (parsed.length === 1 && !parsed[0].parseError) {
            changed = true;
            const p = parsed[0];
            return {
                ...e,
                category: p.category,
                subject: p.subject,
                divergence: p.divergence,
                sceneRef: p.sceneRef,
                supersedes: p.supersedes ?? e.supersedes,
                parseError: false,
            };
        }

        if (e.divergence && e.subject === e.divergence.slice(0, 40)) {
            changed = true;
            return { ...e, subject: '(unparsed)' };
        }

        return e;
    });

    return changed ? { ...register, entries, lastUpdatedAt: Date.now() } : register;
}
