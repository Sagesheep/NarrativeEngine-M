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

import type { LLMProvider, ArchiveIndexEntry, ArchiveChapter, ChatMessage } from '../types';
import { llmCall } from '../utils/llmCall';
import { getList, k, type SceneRecord } from './storage/_helpers';

const EST_TOKENS = (text: string) => Math.ceil(text.length / 4);

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

function parseChapterIds(raw: string): string[] {
    let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    try {
        const parsed = JSON.parse(clean.substring(start, end + 1));
        return Array.isArray(parsed.chapters)
            ? parsed.chapters.filter((c: unknown) => typeof c === 'string')
            : [];
    } catch { return []; }
}

function parseSceneIds(raw: string): string[] {
    let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return [];
    try {
        const parsed = JSON.parse(clean.substring(start, end + 1));
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

function makeScenePrompt(conversation: string, sceneOverview: string): string {
    return `You are a narrative continuity analyst for a tabletop RPG campaign.
Below are compact summaries of archived scenes. Identify ALL scenes relevant to the current narrative moment.

Include scenes with: mentioned NPCs/locations, decisions with current consequences, events that inform current action, unresolved threads, foreshadowing.
Return EVERY relevant scene — do not arbitrarily limit.

[CURRENT INPUT]
${conversation}

[SCENE INDEX]
${sceneOverview}

Respond ONLY with JSON: {"scenes": ["042", "011", ...]}`;
}

// ── Summarization (single-pass or MapReduce) ──

async function summarizeSceneContent(
    utilityEndpoint: LLMProvider,
    sceneText: string,
    targetTokens: number,
    onStatus: (msg: string) => void
): Promise<string> {
    const PARTITION_SIZE_TOKENS = 8000;
    const totalTokens = EST_TOKENS(sceneText);

    if (totalTokens <= targetTokens * 3) {
        onStatus('[3/5] Deep Archive — synthesizing context brief...');
        const prompt = `You are a narrative memory synthesizer for a tabletop RPG. Compress these archived scenes into an essential context brief. Preserve NPC states, decisions, outcomes, relationships, and unresolved threads. Target approximately ${targetTokens} tokens. Preserve specificity — names, places, consequences matter.

SCENES:
${sceneText}

Write the narrative context brief now:`;
        return llmCall(utilityEndpoint, prompt, { temperature: 0.2, priority: 'high' });
    }

    // MapReduce path for very large content
    const approxCharsPerPartition = PARTITION_SIZE_TOKENS * 4;
    const partitions: string[] = [];
    for (let i = 0; i < sceneText.length; i += approxCharsPerPartition) {
        partitions.push(sceneText.slice(i, i + approxCharsPerPartition));
    }

    const partitionQuota = Math.floor(targetTokens / partitions.length);
    const partitionSummaries: string[] = [];

    for (let i = 0; i < partitions.length; i++) {
        onStatus(`[3/5] Deep Archive — summarizing part ${i + 1}/${partitions.length}...`);
        const prompt = `Compress these narrative scenes to ~${partitionQuota} tokens. Preserve NPC names, key decisions, outcomes, unresolved threads.

${partitions[i]}

Summary:`;
        partitionSummaries.push(
            await llmCall(utilityEndpoint, prompt, { temperature: 0.2, priority: 'high' })
        );
    }

    onStatus('[3/5] Deep Archive — combining summaries...');
    const combinedPrompt = `Merge these narrative summaries into one coherent context brief. Target approximately ${targetTokens} tokens. Preserve all critical lore, NPC states, and unresolved threads.

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
    const chapterPrompt = `You are a narrative continuity analyst for a tabletop RPG campaign.
Below is an index of all archived story chapters. Given the current player input and recent conversation, identify ALL chapters that contain scenes relevant to the current narrative moment.

Include chapters with: direct NPC/location references, related plotlines, earlier decisions with current consequences, foreshadowing, or thematic echoes.
Do NOT arbitrarily limit — include every relevant chapter.

[CURRENT INPUT]
${conversation}

[CHAPTER INDEX]
${chapterOverview}

Respond ONLY with JSON: {"chapters": ["ch01", "ch03", ...]}`;

    let selectedChapterIds: string[] = [];
    try {
        const raw = await Promise.race([
            llmCall(utilityEndpoint, chapterPrompt, { temperature: 0.1, priority: 'high' }),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (raw) selectedChapterIds = parseChapterIds(raw);
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
        if (raw) parseSceneIds(raw).forEach(id => notebookIds.add(id));
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
                if (raw) parseSceneIds(raw).forEach(id => notebookIds.add(id));
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
    const sceneTextParts: string[] = [];
    let fetchedTokens = 0;
    const MAX_FETCH_TOKENS = availableBudget * 4; // raw content before summarization

    for (const id of notebookIdsSorted) {
        const record = recordMap.get(id);
        if (!record) continue;
        const sceneText = `--- SCENE ${id} ---\n[Player]: ${record.userContent}\n[GM]: ${record.assistantContent}`;
        const t = EST_TOKENS(sceneText);
        if (fetchedTokens + t > MAX_FETCH_TOKENS) break;
        sceneTextParts.push(sceneText);
        fetchedTokens += t;
    }

    console.log(`[DeepArchiveSearch] ${notebookIds.size} candidate scenes → ${sceneTextParts.length} fetched (~${fetchedTokens} raw tokens)`);

    if (sceneTextParts.length === 0) return '';

    const combinedSceneText = sceneTextParts.join('\n\n');
    const brief = await summarizeSceneContent(utilityEndpoint, combinedSceneText, availableBudget, onStatus);
    console.log(`[DeepArchiveSearch] Brief generated: ~${EST_TOKENS(brief)} tokens`);
    return brief;
}
