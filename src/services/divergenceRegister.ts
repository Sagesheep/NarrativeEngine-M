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

type ExtractionResult = {
    importance: number;
    newEntries: Array<{
        category: DivergenceCategory;
        subject: string;
        divergence: string;
        supersedes?: string;
    }>;
};

function buildExtractionPrompt(
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister
): string {
    const registerLines = currentRegister.entries.length > 0
        ? currentRegister.entries.map(e =>
            `${e.id} [Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
        ).join('\n')
        : '(empty)';

    const registerTokens = countTokens(registerLines);

    return `EXISTING REGISTER (${registerTokens} tokens):
${registerLines}

NEW SCENE TEXT (Scene #${sceneId}):
${sceneText}

TASK:
1. Rate this scene's importance 1-10.
2. If importance >= ${IMPORTANCE_GATE}, extract divergences — campaign-altering facts that override training data or establish new world state.
3. For each new fact: if it updates an existing entry above, return its ID in "supersedes".
4. Preserve proper nouns exactly as written in the scene.
5. Categories: canon_override (contradicts source material), world_change (permanent map/world state), entity_state (NPCs, items, factions status), player_state (abilities, titles, curses), obligation (debts, promises, oaths).

OUTPUT JSON only:
{ "importance": <number>, "newEntries": [{ "category": "<category>", "subject": "<entity>", "divergence": "<one-line fact>", "supersedes": "<id or null>" }] }`;
}

export async function extractDivergences(
    provider: LLMProvider,
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister,
    options?: { forceExtract?: boolean; multiScene?: boolean }
): Promise<{ result: ExtractionResult | null; entries: DivergenceEntry[] }> {
    const prompt = buildExtractionPrompt(sceneText, sceneId, currentRegister);

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 800 });
        const jsonStr = extractJson(raw);
        const parsed = JSON.parse(jsonStr) as ExtractionResult;

        if (!parsed || typeof parsed.importance !== 'number') {
            return { result: null, entries: [] };
        }

        if (!options?.forceExtract && parsed.importance < IMPORTANCE_GATE && parsed.newEntries.length === 0) {
            return { result: parsed, entries: [] };
        }

        const newEntries: DivergenceEntry[] = (parsed.newEntries || []).map(ne => ({
            id: `div_${uid()}`,
            category: ne.category,
            subject: ne.subject,
            divergence: ne.divergence,
            sceneRef: sceneId,
            linkedSceneIds: [sceneId],
            importance: parsed.importance,
            supersedes: ne.supersedes || undefined,
            source: options?.forceExtract ? 'manual' as const : 'auto' as const,
        }));

        return { result: parsed, entries: newEntries };
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

export function buildSceneMap(
    archiveIndex: ArchiveIndexEntry[],
    messages: ChatMessage[]
): { sceneIdsByMessageId: Record<string, string> } {
    const sceneIdsByMessageId: Record<string, string> = {};
    const sorted = [...archiveIndex].sort((a, b) => parseInt(a.sceneId) - parseInt(b.sceneId));

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const turnIndex = Math.floor(i / 2);
        const scene = sorted[turnIndex];
        if (scene) sceneIdsByMessageId[msg.id] = scene.sceneId;
    }

    return { sceneIdsByMessageId };
}
