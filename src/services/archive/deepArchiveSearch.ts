/**
 * deepArchiveSearch.ts
 * --------------------
 * Two-phase AI-driven archive scan for "narrative archaeology" — surfaces
 * scattered non-contiguous scenes that semantic/keyword scoring would miss.
 *
 * Phase 1: Compact chapter summaries → utility AI selects all relevant chapters.
 * Phase 2: Compact scene entries (within selected chapters only) → utility AI
 *          selects all relevant scene IDs.
 * Round 2: Optional follow-up if phase 2 reveals scenes in un-scanned chapters.
 * Final:   Fetch verbatim scene content, then summarize to fit available budget.
 *          Large content uses MapReduce (partition → summarize each → combine).
 *
 * One-shot per turn. Nothing persisted — condenser captures the output.
 */

import type { LLMProvider, ArchiveIndexEntry, ArchiveChapter, ChatMessage } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { getList, k, type SceneRecord } from '../storage/_helpers';
import { isEmbedderReady, semanticSearchScored, type SearchHit } from '../embedding';

import {
    extractJson,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    JSON_ARRAY_ONLY_FOOTER,
    joinPromptSections,
    countTokens,
} from '../infrastructure';

const EST_TOKENS = (text: string) => countTokens(text);

// ── Compact formatters ──

function buildChapterOverview(chapters: ArchiveChapter[]): string {
    return chapters.map(ch => {
        const parts = [`[${ch.chapterId}] "${ch.title}" (Scenes ${ch.sceneRange[0]}–${ch.sceneRange[1]})`];
        if (ch.summary) parts.push(`  Summary: ${ch.summary.slice(0, 200)}`);
        if (ch.npcs.length > 0) parts.push(`  NPCs: ${ch.npcs.join(', ')}`);
        if (ch.majorEvents.length > 0) parts.push(`  Events: ${ch.majorEvents.slice(0, 3).join('; ')}`);
        if (ch.keywords.length > 0) parts.push(`  Keywords: ${ch.keywords.slice(0, 8).join(', ')}`);
        return parts.join('\n');
    }).join('\n\n');
}

function buildSceneOverview(
    entries: ArchiveIndexEntry[],
    sceneRecords: SceneRecord[],
    softTokenCap: number
): string {
    const recordMap = new Map(sceneRecords.map(s => [s.sceneId, s]));
    const useCompact = entries.length > 150;

    const parts: string[] = [];
    let tokensUsed = 0;

    // entries are sorted highest-importance first; soft cap drops low-importance tail
    for (const entry of entries) {
        const importance = entry.importance?.toFixed(1) ?? '?';
        const npcs = entry.npcsMentioned.slice(0, 5).join(', ') || 'none';
        const kws = entry.keywords.slice(0, 6).join(', ');
        const userSnippet = (entry.userSnippet || '').slice(0, 120);

        let entryText: string;
        if (useCompact) {
            entryText = `[Scene ${entry.sceneId}] imp:${importance} | NPCs: ${npcs} | KWs: ${kws}\nPlayer: "${userSnippet}"`;
        } else {
            const record = recordMap.get(entry.sceneId);
            const gmExcerpt = record ? record.assistantContent.slice(0, 130) : '';
            entryText = `[Scene ${entry.sceneId}] imp:${importance} | NPCs: ${npcs} | KWs: ${kws}\nPlayer: "${userSnippet}"\nGM: "${gmExcerpt}..."`;
        }

        const entryTokens = EST_TOKENS(entryText);
        if (tokensUsed + entryTokens > softTokenCap) break;
        parts.push(entryText);
        tokensUsed += entryTokens;
    }

    return parts.join('\n\n');
}

function buildConversationExcerpt(messages: ChatMessage[], userMessage: string): string {
    const recent = messages.slice(-3);
    const lines = recent.map(m => {
        const role = m.role === 'user' ? 'PLAYER' : 'GM';
        return `[${role}]: ${(m.content || '').slice(0, 200)}`;
    });
    lines.push(`[PLAYER]: ${userMessage.slice(0, 200)}`);
    return lines.join('\n\n');
}

// ── JSON parsers ──

async function parseChapterIds(raw: string): Promise<string[]> {
    const cleanStr = extractJson(raw);
    try {
        const parsed = JSON.parse(cleanStr);
        return Array.isArray(parsed.chapters)
            ? parsed.chapters.filter((c: unknown) => typeof c === 'string')
            : [];
    } catch { return []; }
}

async function parseSceneIds(raw: string): Promise<string[]> {
    const cleanStr = extractJson(raw);
    try {
        const parsed = JSON.parse(cleanStr);
        return Array.isArray(parsed.scenes)
            ? parsed.scenes.filter((s: unknown) => typeof s === 'string')
            : [];
    } catch { return []; }
}

// ── Helpers ──

function getScenesInChapters(
    archiveIndex: ArchiveIndexEntry[],
    chapters: ArchiveChapter[]
): ArchiveIndexEntry[] {
    const ranges = chapters.map(ch => ({
        min: parseInt(ch.sceneRange[0], 10),
        max: parseInt(ch.sceneRange[1], 10),
    }));
    return archiveIndex
        .filter(entry => {
            const num = parseInt(entry.sceneId, 10);
            return ranges.some(r => num >= r.min && num <= r.max);
        })
        .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0)); // highest importance first
}

/**
 * Fetches verbatim scene text (Player + GM turns) for the given ids, in the
 * given order, stopping at the raw-token budget. Shared by v1 and v2.
 */
function fetchSceneText(
    sceneIdsSorted: string[],
    recordMap: Map<string, SceneRecord>,
    maxFetchTokens: number
): { combinedText: string; fetchedCount: number; fetchedTokens: number } {
    const parts: string[] = [];
    let fetchedTokens = 0;
    for (const id of sceneIdsSorted) {
        const record = recordMap.get(id);
        if (!record) continue;
        const sceneText = `--- SCENE ${id} ---\n[Player]: ${record.userContent}\n[GM]: ${record.assistantContent}`;
        const t = EST_TOKENS(sceneText);
        if (fetchedTokens + t > maxFetchTokens) break;
        parts.push(sceneText);
        fetchedTokens += t;
    }
    return { combinedText: parts.join('\n\n'), fetchedCount: parts.length, fetchedTokens };
}

function makeScenePrompt(conversation: string, sceneOverview: string): string {
    return joinPromptSections(
        'You are a narrative continuity analyst for a tabletop RPG campaign.',

        `TASK: Given the current narrative moment and the archived scene index below, identify ALL scenes relevant to the current moment.
Output schema: {"scenes": ["042", "011", ...]}`,

        `RULES:
- Include scenes with: mentioned NPCs/locations, decisions with current consequences, events that inform current action, unresolved threads, foreshadowing.
- Return EVERY relevant scene — do not arbitrarily limit.`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `[CURRENT INPUT]\n${conversation}`,
        `[SCENE INDEX]\n${sceneOverview}`,
    );
}

// ── Summarization (single-pass or MapReduce) ──

async function summarizeSceneContent(
    utilityEndpoint: LLMProvider,
    sceneText: string,
    targetTokens: number,
    onStatus: (msg: string) => void,
    focusQuery?: string
): Promise<string> {
    const PARTITION_SIZE_TOKENS = 8000;
    const totalTokens = EST_TOKENS(sceneText);
    const focusLine = focusQuery ? ` Prioritize facts that answer: "${focusQuery}".` : '';

    if (totalTokens <= targetTokens * 3) {
        onStatus('[3/5] Deep Archive — synthesizing context brief...');
        const prompt = joinPromptSections(
            'You are a narrative memory synthesizer for a tabletop RPG.',

            `TASK: Output terse fact bullets and short verbatim quotes only. No narrative prose, no interpretation. Preserve names, places, numbers, outcomes, and unresolved threads. Target approximately ${targetTokens} tokens.${focusLine}`,

            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `SCENES:\n${sceneText}`,
        );
        return llmCall(utilityEndpoint, prompt, { temperature: 0.2, priority: 'high' });
    }

    // MapReduce path for very large content
    const approxCharsPerPartition = PARTITION_SIZE_TOKENS * 4;
    const partitions: string[] = [];
    for (let i = 0; i < sceneText.length; i += approxCharsPerPartition) {
        partitions.push(sceneText.slice(i, i + approxCharsPerPartition));
    }

    const partitionQuota = Math.floor(targetTokens / partitions.length);

    onStatus(`[3/5] Deep Archive — summarizing ${partitions.length} parts...`);
    const partitionSummaries: string[] = await Promise.all(partitions.map((partition) => {
        const prompt = `Output terse fact bullets and short verbatim quotes only. No narrative prose, no interpretation. Preserve names, places, numbers, outcomes, and unresolved threads. Target approximately ${partitionQuota} tokens.${focusLine}

${partition}

Summary:`;
        return llmCall(utilityEndpoint, prompt, { temperature: 0.2, priority: 'high' });
    }));

    onStatus('[3/5] Deep Archive — combining summaries...');
    const combinedPrompt = `Merge these fact bullets and quotes into one coherent set. Target approximately ${targetTokens} tokens. Preserve all critical lore, NPC states, and unresolved threads. No narrative prose, no interpretation.${focusLine}

${partitionSummaries.map((s, i) => `[Part ${i + 1}]\n${s}`).join('\n\n')}

Combined brief:`;
    return llmCall(utilityEndpoint, combinedPrompt, { temperature: 0.2, priority: 'high' });
}

// ── Main entry point ──

export async function deepArchiveScan(
    utilityEndpoint: LLMProvider,
    archiveIndex: ArchiveIndexEntry[],
    sealedChapters: ArchiveChapter[],
    campaignId: string,
    messages: ChatMessage[],
    userMessage: string,
    availableBudget: number,
    onStatus: (msg: string) => void
): Promise<string> {
    if (sealedChapters.length === 0 || archiveIndex.length === 0) return '';

    const conversation = buildConversationExcerpt(messages, userMessage);
    const allSceneRecords: SceneRecord[] = await getList(k(campaignId, 'scenes'));

    // ── Phase 1: Chapter scan ──
    onStatus('[3/5] Deep Archive — scanning chapters (round 1)...');
    const chapterOverview = buildChapterOverview(sealedChapters);
    const chapterPrompt = joinPromptSections(
        'You are a narrative continuity analyst for a tabletop RPG campaign.',

        `TASK: Given the current player input and recent conversation, identify ALL chapters that contain scenes relevant to the current narrative moment.
Output schema: {"chapters": ["ch01", "ch03", ...]}`,

        `RULES:
- Include chapters with: direct NPC/location references, related plotlines, earlier decisions with current consequences, foreshadowing, or thematic echoes.
- Do NOT arbitrarily limit — include every relevant chapter.`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `[CURRENT INPUT]\n${conversation}`,
        `[CHAPTER INDEX]\n${chapterOverview}`,
    );

    let selectedChapterIds: string[] = [];
    try {
        const raw = await Promise.race([
            llmCall(utilityEndpoint, chapterPrompt, { temperature: 0.1, priority: 'high' }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (raw) selectedChapterIds = await parseChapterIds(raw);
    } catch (err) {
        console.warn('[DeepArchiveSearch] Phase 1 (chapter scan) failed:', err);
        return '';
    }

    if (selectedChapterIds.length === 0) {
        console.log('[DeepArchiveSearch] Round 1: no chapters selected.');
        return '';
    }

    const selectedChapters = sealedChapters.filter(ch => selectedChapterIds.includes(ch.chapterId));
    console.log(`[DeepArchiveSearch] Round 1: ${sealedChapters.length} chapters → ${selectedChapters.length} selected`);

    // ── Phase 2: Scene scan within selected chapters ──
    onStatus('[3/5] Deep Archive — scanning scenes (round 1)...');
    const filteredEntries = getScenesInChapters(archiveIndex, selectedChapters);
    const sceneOverview1 = buildSceneOverview(filteredEntries, allSceneRecords, 20_000);

    const notebookIds = new Set<string>();
    try {
        const raw = await Promise.race([
            llmCall(utilityEndpoint, makeScenePrompt(conversation, sceneOverview1), { temperature: 0.1, priority: 'high' }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 35_000)),
        ]);
        if (raw) {
            const parsed = await parseSceneIds(raw);
            parsed.forEach(id => notebookIds.add(id));
        }
    } catch (err) {
        console.warn('[DeepArchiveSearch] Phase 2 round 1 failed:', err);
        return '';
    }

    console.log(`[DeepArchiveSearch] Round 1 scenes: ${filteredEntries.length} in scope → ${notebookIds.size} selected`);

    // ── Round 2: follow up on scenes outside scanned chapter ranges ──
    const scannedRanges = selectedChapters.map(ch => ({
        min: parseInt(ch.sceneRange[0], 10),
        max: parseInt(ch.sceneRange[1], 10),
    }));
    const uncoveredIds = [...notebookIds].filter(id => {
        const num = parseInt(id, 10);
        return !scannedRanges.some(r => num >= r.min && num <= r.max);
    });

    if (uncoveredIds.length > 0) {
        const uncoveredNums = uncoveredIds.map(id => parseInt(id, 10));
        const extraChapters = sealedChapters.filter(ch => {
            const min = parseInt(ch.sceneRange[0], 10);
            const max = parseInt(ch.sceneRange[1], 10);
            return uncoveredNums.some(n => n >= min && n <= max) && !selectedChapterIds.includes(ch.chapterId);
        });

        if (extraChapters.length > 0) {
            onStatus('[3/5] Deep Archive — scanning scenes (round 2)...');
            const extraEntries = getScenesInChapters(archiveIndex, extraChapters);
            const sceneOverview2 = buildSceneOverview(extraEntries, allSceneRecords, 20_000);
            try {
                const raw = await Promise.race([
                    llmCall(utilityEndpoint, makeScenePrompt(conversation, sceneOverview2), { temperature: 0.1, priority: 'high' }),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 35_000)),
                ]);
                if (raw) {
                    const parsed = await parseSceneIds(raw);
                    parsed.forEach(id => notebookIds.add(id));
                }
                console.log(`[DeepArchiveSearch] Round 2: ${extraChapters.length} extra chapters → ${notebookIds.size} total selected`);
            } catch (err) {
                console.warn('[DeepArchiveSearch] Phase 2 round 2 failed (non-fatal):', err);
            }
        }
    }

    if (notebookIds.size === 0) return '';

    // ── Fetch scene content (sorted by importance, highest first) ──
    onStatus('[3/5] Deep Archive — fetching scene content...');
    const indexMap = new Map(archiveIndex.map(e => [e.sceneId, e]));
    const notebookIdsSorted = [...notebookIds].sort((a, b) => {
        return (indexMap.get(b)?.importance ?? 0) - (indexMap.get(a)?.importance ?? 0);
    });

    const recordMap = new Map(allSceneRecords.map(s => [s.sceneId, s]));
    const MAX_FETCH_TOKENS = availableBudget * 4; // raw content before summarization
    const fetched = fetchSceneText(notebookIdsSorted, recordMap, MAX_FETCH_TOKENS);

    console.log(`[DeepArchiveSearch] ${notebookIds.size} candidate scenes → ${fetched.fetchedCount} fetched (~${fetched.fetchedTokens} raw tokens)`);

    if (fetched.fetchedCount === 0) return '';

    const brief = await summarizeSceneContent(utilityEndpoint, fetched.combinedText, availableBudget, onStatus);
    console.log(`[DeepArchiveSearch] Brief generated: ~${EST_TOKENS(brief)} tokens`);
    return brief;
}

// ═══════════════════════════════════════════════════════════════════════════
// v2 — Union retrieval: vector probes ∥ chapter batch call → tiered union →
// single verify call → shared fetch + summarize.
// Spec: Upgrade/FablePlans/DeepArchiveUpgrade/00_SPEC.md
// ═══════════════════════════════════════════════════════════════════════════

const PROBE_TOP_K = 60;
const PROBE_FLOOR = 0.28;
const MAX_PER_CHAPTER_C = 8;
const VERIFY_OVERVIEW_CAP = 20_000;

export type TieredCandidate = {
    entry: ArchiveIndexEntry;
    /** A = probe hit inside a selected chapter · B = probe hit only · C = selected chapter only */
    tier: 'A' | 'B' | 'C';
    /** Cosine similarity — present on probe-sourced candidates (A/B) only. */
    score?: number;
};

const TIER_MARK: Record<TieredCandidate['tier'], string> = { A: '◆', B: '○', C: '·' };

/**
 * Expands a search request into short scene-level probe phrases for vector
 * search. "My feats across the campaign" never textually resembles the
 * bandit-fight scene that IS a feat — the probes bridge that abstraction gap.
 * Returns `[searchText]` on any failure.
 */
async function expandProbes(utilityEndpoint: LLMProvider, searchText: string): Promise<string[]> {
    const fallback = [searchText];
    try {
        const prompt = joinPromptSections(
            'You are a search-probe generator for a TTRPG campaign archive.',

            `TASK: Rewrite the search request as 4-6 short concrete phrases at the level of scene text — actions, events, objects, dialogue topics. A scene about the thing should textually resemble the phrase.
Example: "my feats across the campaign" → ["won a difficult battle", "rescued someone in danger", "was praised or rewarded for a deed", "revealed a rare ability"]`,

            JSON_ARRAY_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `Search request: "${searchText}"`,
        );

        const raw = await Promise.race([
            llmCall(utilityEndpoint, prompt, { temperature: 0.2, priority: 'high', maxTokens: 250 }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (!raw) return fallback;

        let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const bracketStart = clean.indexOf('[');
        const bracketEnd = clean.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1) return fallback;

        const parsed = JSON.parse(clean.substring(bracketStart, bracketEnd + 1));
        const probes = Array.isArray(parsed)
            ? parsed.filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 6)
            : [];
        return probes.length > 0 ? [searchText, ...probes] : fallback;
    } catch {
        return fallback;
    }
}

/**
 * Tiers the union of both retrievers. Agreement is a ranking signal for the
 * verify prompt, NOT an include/exclude branch: chapter membership is coarse,
 * so a weak probe hit inside a picked chapter is not true two-way agreement.
 * Pure — exported for tests.
 */
export function tierCandidates(params: {
    probeHits: SearchHit[];
    selectedChapters: ArchiveChapter[];
    archiveIndex: ArchiveIndexEntry[];
    maxPerChapterC?: number;
}): TieredCandidate[] {
    const { probeHits, selectedChapters, archiveIndex } = params;
    const maxPerChapterC = params.maxPerChapterC ?? MAX_PER_CHAPTER_C;

    const indexMap = new Map(archiveIndex.map(e => [e.sceneId, e]));
    const ranges = selectedChapters.map(ch => ({
        min: parseInt(ch.sceneRange[0], 10),
        max: parseInt(ch.sceneRange[1], 10),
    }));
    const inSelected = (sceneId: string) => {
        const num = parseInt(sceneId, 10);
        return ranges.some(r => num >= r.min && num <= r.max);
    };

    const byId = new Map<string, TieredCandidate>();

    for (const hit of probeHits) {
        const entry = indexMap.get(hit.id);
        if (!entry || byId.has(hit.id)) continue;
        byId.set(hit.id, { entry, tier: inSelected(hit.id) ? 'A' : 'B', score: hit.score });
    }

    for (const range of ranges) {
        const chapterEntries = archiveIndex
            .filter(e => {
                const num = parseInt(e.sceneId, 10);
                return num >= range.min && num <= range.max && !byId.has(e.sceneId);
            })
            .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
            .slice(0, maxPerChapterC);
        for (const entry of chapterEntries) {
            byId.set(entry.sceneId, { entry, tier: 'C' });
        }
    }

    const tierOrder = { A: 0, B: 1, C: 2 } as const;
    return [...byId.values()].sort((a, b) => {
        if (tierOrder[a.tier] !== tierOrder[b.tier]) return tierOrder[a.tier] - tierOrder[b.tier];
        if (a.tier === 'C') return (b.entry.importance ?? 0) - (a.entry.importance ?? 0);
        return (b.score ?? 0) - (a.score ?? 0);
    });
}

/**
 * Trims the tiered list to a token budget: C dropped first (ascending
 * importance), then B (ascending score). A is never dropped, even if the list
 * still exceeds the cap. Pure — exported for tests.
 */
export function trimTieredToBudget(
    tiered: TieredCandidate[],
    tokenOf: (c: TieredCandidate) => number,
    capTokens: number
): TieredCandidate[] {
    let total = tiered.reduce((sum, c) => sum + tokenOf(c), 0);
    if (total <= capTokens) return tiered;

    const keep = new Set(tiered);
    const dropOrder = [
        ...tiered.filter(c => c.tier === 'C').sort((a, b) => (a.entry.importance ?? 0) - (b.entry.importance ?? 0)),
        ...tiered.filter(c => c.tier === 'B').sort((a, b) => (a.score ?? 0) - (b.score ?? 0)),
    ];
    for (const c of dropOrder) {
        if (total <= capTokens) break;
        keep.delete(c);
        total -= tokenOf(c);
    }
    return tiered.filter(c => keep.has(c));
}

function renderTieredEntry(c: TieredCandidate, recordMap: Map<string, SceneRecord>, compact: boolean): string {
    const { entry, tier } = c;
    const mark = TIER_MARK[tier];
    const importance = entry.importance?.toFixed(1) ?? '?';
    const npcs = entry.npcsMentioned.slice(0, 5).join(', ') || 'none';
    const kws = entry.keywords.slice(0, 6).join(', ');
    const userSnippet = (entry.userSnippet || '').slice(0, 120);

    if (compact) {
        return `${mark} [Scene ${entry.sceneId}] imp:${importance} | NPCs: ${npcs} | KWs: ${kws}\nPlayer: "${userSnippet}"`;
    }
    const record = recordMap.get(entry.sceneId);
    const gmExcerpt = record ? record.assistantContent.slice(0, 130) : '';
    return `${mark} [Scene ${entry.sceneId}] imp:${importance} | NPCs: ${npcs} | KWs: ${kws}\nPlayer: "${userSnippet}"\nGM: "${gmExcerpt}..."`;
}

/**
 * With a user query, relevance is judged against `[SEARCH QUERY]` and the
 * conversation is secondary context; without one, keying matches v1 exactly.
 */
function buildKeyedInput(searchKey: string | null, conversation: string): string {
    return searchKey
        ? `[SEARCH QUERY]\n${searchKey}\n\n[CURRENT SCENE]\n${conversation}`
        : `[CURRENT INPUT]\n${conversation}`;
}

function makeChapterPromptV2(searchKey: string | null, conversation: string, chapterOverview: string): string {
    const target = searchKey ? 'the SEARCH QUERY (the current scene is secondary context)' : 'the current narrative moment';
    return joinPromptSections(
        'You are a narrative continuity analyst for a tabletop RPG campaign.',

        `TASK: Identify ALL chapters that contain scenes relevant to ${target}.
Output schema: {"chapters": ["ch01", "ch03", ...]}`,

        `RULES:
- Include chapters with: direct NPC/location references, related plotlines, earlier decisions with current consequences, foreshadowing, or thematic echoes.
- Do NOT arbitrarily limit — include every relevant chapter.`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        buildKeyedInput(searchKey, conversation),
        `[CHAPTER INDEX]\n${chapterOverview}`,
    );
}

function makeVerifyPrompt(searchKey: string | null, conversation: string, tieredOverview: string): string {
    const target = searchKey ? 'the SEARCH QUERY' : 'the current moment';
    return joinPromptSections(
        'You are a narrative continuity analyst for a tabletop RPG campaign.',

        `TASK: Given the search context and the candidate scene index below, identify ALL scenes relevant to ${target}.
Output schema: {"scenes": ["042", "011", ...]}`,

        `RULES:
- Include scenes with: mentioned NPCs/locations, decisions with current consequences, events that inform current action, unresolved threads, foreshadowing.
- Entries marked ◆ were independently flagged by two retrieval methods — weigh that as supporting evidence, but include/exclude on relevance alone. ○ = semantic match, · = chapter context.
- Return EVERY relevant scene — do not arbitrarily limit.`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        buildKeyedInput(searchKey, conversation),
        `[CANDIDATE SCENES]\n${tieredOverview}`,
    );
}

/**
 * Deep Archive Scan v2 — union retrieval.
 *
 * Degradation ladder: embedder off → chapter path only (≈v1); chapter call
 * fails → probes only; verify fails → tier-A fallback; everything fails →
 * `''` (caller falls back to standard recall).
 */
export async function deepArchiveScanV2(
    utilityEndpoint: LLMProvider,
    archiveIndex: ArchiveIndexEntry[],
    sealedChapters: ArchiveChapter[],
    campaignId: string,
    messages: ChatMessage[],
    userMessage: string,
    availableBudget: number,
    onStatus: (msg: string) => void,
    searchQuery?: string,
): Promise<string> {
    if (sealedChapters.length === 0 || archiveIndex.length === 0) return '';

    const conversation = buildConversationExcerpt(messages, userMessage);
    const searchKey = searchQuery?.trim() || null;
    const searchText = searchKey ?? conversation;
    const allSceneRecords: SceneRecord[] = await getList(k(campaignId, 'scenes'));
    const recordMap = new Map(allSceneRecords.map(s => [s.sceneId, s]));

    const sealedRanges = sealedChapters.map(ch => ({
        min: parseInt(ch.sceneRange[0], 10),
        max: parseInt(ch.sceneRange[1], 10),
    }));

    // ── Phase 0: probe expansion (pointless without the embedder — skip the call) ──
    const embedderReady = isEmbedderReady();
    let probes: string[] = [];
    if (embedderReady) {
        onStatus('[3/5] Deep Archive v2 — expanding search probes...');
        probes = await expandProbes(utilityEndpoint, searchText);
        console.log(`[DeepArchiveV2] ${probes.length} probe(s) for "${searchText.slice(0, 80)}"`);
    } else {
        console.log('[DeepArchiveV2] Embedder not ready — chapter path only.');
    }

    // ── Phase 1a ∥ 1b: vector probes + chapter batch call ──
    onStatus('[3/5] Deep Archive v2 — probing index + scanning chapters...');

    // Probe hits outside sealed chapters are dropped: unsealed scenes are
    // already in recent history and must not be duplicated into the brief.
    const probesPromise: Promise<SearchHit[]> = embedderReady
        ? semanticSearchScored(campaignId, probes, 'scene', PROBE_TOP_K, PROBE_FLOOR)
            .then(hits => (hits ?? []).filter(h => {
                const num = parseInt(h.id, 10);
                return sealedRanges.some(r => num >= r.min && num <= r.max);
            }))
            .catch(err => {
                console.warn('[DeepArchiveV2] Probe search failed (non-fatal):', err);
                return [];
            })
        : Promise.resolve([]);

    const chapterOverview = buildChapterOverview(sealedChapters);
    const chaptersPromise: Promise<ArchiveChapter[]> = Promise.race([
        llmCall(utilityEndpoint, makeChapterPromptV2(searchKey, conversation, chapterOverview), { temperature: 0.1, priority: 'high' }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 20_000)),
    ])
        .then(async raw => {
            if (!raw) return [];
            const ids = await parseChapterIds(raw);
            return sealedChapters.filter(ch => ids.includes(ch.chapterId));
        })
        .catch(err => {
            console.warn('[DeepArchiveV2] Chapter scan failed (non-fatal, probes-only):', err);
            return [];
        });

    const [probeHits, selectedChapters] = await Promise.all([probesPromise, chaptersPromise]);
    console.log(`[DeepArchiveV2] Retrieval: ${probeHits.length} probe hits, ${selectedChapters.length}/${sealedChapters.length} chapters selected`);

    if (probeHits.length === 0 && selectedChapters.length === 0) return '';

    // ── Tier the union, trim to the verify budget ──
    const tiered = tierCandidates({ probeHits, selectedChapters, archiveIndex });
    if (tiered.length === 0) return '';

    const compact = tiered.length > 150;
    const renderCache = new Map<TieredCandidate, string>();
    const renderOf = (c: TieredCandidate) => {
        let rendered = renderCache.get(c);
        if (rendered === undefined) {
            rendered = renderTieredEntry(c, recordMap, compact);
            renderCache.set(c, rendered);
        }
        return rendered;
    };
    const kept = trimTieredToBudget(tiered, c => EST_TOKENS(renderOf(c)), VERIFY_OVERVIEW_CAP);

    const counts = { A: 0, B: 0, C: 0 };
    for (const c of kept) counts[c.tier]++;
    onStatus(`[3/5] Deep Archive v2 — verifying ${kept.length} candidates (${counts.A}◆ ${counts.B}○ ${counts.C}·)...`);

    // ── Phase 2: single verify call over the tiered union ──
    const candidateIds = new Set(kept.map(c => c.entry.sceneId));
    let selectedIds: string[] | null = null;
    try {
        const raw = await Promise.race([
            llmCall(utilityEndpoint, makeVerifyPrompt(searchKey, conversation, kept.map(renderOf).join('\n\n')), { temperature: 0.1, priority: 'high' }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 35_000)),
        ]);
        if (raw) selectedIds = (await parseSceneIds(raw)).filter(id => candidateIds.has(id));
    } catch (err) {
        console.warn('[DeepArchiveV2] Verify call failed:', err);
    }

    if (selectedIds === null) {
        // Verify unavailable → trust the strongest signal (both retrievers agreed).
        selectedIds = kept.filter(c => c.tier === 'A').map(c => c.entry.sceneId);
        console.log(`[DeepArchiveV2] Verify unavailable — falling back to ${selectedIds.length} tier-A scene(s)`);
    }
    if (selectedIds.length === 0) return '';

    // ── Phase 3: fetch + summarize (shared with v1) ──
    onStatus('[3/5] Deep Archive v2 — fetching scene content...');
    const indexMap = new Map(archiveIndex.map(e => [e.sceneId, e]));
    const sorted = [...new Set(selectedIds)].sort((a, b) =>
        (indexMap.get(b)?.importance ?? 0) - (indexMap.get(a)?.importance ?? 0));

    const fetched = fetchSceneText(sorted, recordMap, availableBudget * 4);
    console.log(`[DeepArchiveV2] ${selectedIds.length} verified scenes → ${fetched.fetchedCount} fetched (~${fetched.fetchedTokens} raw tokens)`);
    if (fetched.fetchedCount === 0) return '';

    const brief = await summarizeSceneContent(utilityEndpoint, fetched.combinedText, availableBudget, onStatus, searchKey ?? undefined);
    console.log(`[DeepArchiveV2] Brief generated: ~${EST_TOKENS(brief)} tokens`);
    return brief;
}
