// ─────────────────────────────────────────────────────────────────────────────
// Chapter recaps — LOD (level-of-detail) renderer for sealed chapters.
// Port of mainApp's services/payload/lodRenderer.ts (WO-08).
//
// The condenser drops everything up to `condensedUpToIndex` from the prompt, so
// once a campaign is long the GM had no "story so far" at all: sealed chapter
// summaries reached the prompt only through recall. This renders the sealed
// chapters behind the condensed boundary as a recap, newest chapters as their
// full summary and older ones as a one-line synopsis, inside a token budget.
//
// Output is byte-identical for identical inputs so it can live in the cached
// prompt prefix: no Date, no random, no Map-iteration-order dependence. No
// witness filter: chapter summaries are the narrator's recap, so they never
// depend on who is on stage.
//
// Mobile difference: messages carry no `sceneId`. The `Scene NNN` scene-marker
// system message written after each archived turn maps messages to scenes.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage } from '../../types';
import { countTokens } from '../infrastructure';

export type LodTier = 'summary' | 'synopsis' | 'dropped';

export interface LodConfig {
    /** How many of the most-recent eligible chapters (by effective age) render as `summary`. */
    summaryChapters: number;
    /** Subtracted from position-from-end when any scene in the chapter has importance ≥ 8. */
    importanceBonus: number;
}

export interface LodRenderInput {
    chapters: ArchiveChapter[];
    archiveIndex: ArchiveIndexEntry[];
    /** Index into `messages` of the last condensed message; -1 means "nothing condensed yet". */
    condensedUpToIndex: number;
    messages: ChatMessage[];
    /** Soft cap on rendered output tokens. The cascade demotes/drops oldest first. */
    budgetTokens: number;
    config?: LodConfig;
}

export interface LodRenderResult {
    text: string;
    tokens: number;
    tierByChapterId: Record<string, LodTier>;
}

export const DEFAULT_LOD_CONFIG: LodConfig = { summaryChapters: 7, importanceBonus: 2 };

/** Numeric scene id ("001" → 1). -1 on parse failure. */
function sceneNum(id: string): number {
    const n = parseInt(id, 10);
    return Number.isFinite(n) ? n : -1;
}

/** The scene number a scene-marker message names, or -1 for any other message. */
function markerScene(m: ChatMessage): number {
    if (m.role !== 'system' || m.name !== 'scene-marker' || typeof m.content !== 'string') return -1;
    const match = m.content.match(/Scene\s+(\d+)/i);
    return match ? sceneNum(match[1]) : -1;
}

/**
 * A sealed chapter is eligible once any of its scenes is behind the condensed
 * boundary. Requiring the whole chapter to be behind it would leave up to a
 * chapter's worth of the most recent past in neither place; the cost is that the
 * chapter's last few scenes also appear verbatim.
 *
 * The highest scene marker at or below the boundary is the last condensed scene.
 * With no marker there, the lowest marker after the boundary bounds it instead;
 * with no markers at all, refuse (safer to omit than to guess).
 */
function hasCondensedScenes(
    chapter: ArchiveChapter,
    messages: ChatMessage[],
    condensedUpToIndex: number,
): boolean {
    if (condensedUpToIndex < 0) return false;

    const chapterEnd = sceneNum(chapter.sceneRange[1]);
    const chapterStart = sceneNum(chapter.sceneRange[0]);
    if (chapterEnd < 0 || chapterStart < 0) return false;

    let maxCondensedScene = -1;
    for (let i = 0; i <= condensedUpToIndex && i < messages.length; i++) {
        const n = markerScene(messages[i]);
        if (n > maxCondensedScene) maxCondensedScene = n;
    }
    if (maxCondensedScene >= 0) return chapterStart <= maxCondensedScene;

    let minPostBoundaryScene = Number.POSITIVE_INFINITY;
    for (let i = condensedUpToIndex + 1; i < messages.length; i++) {
        const n = markerScene(messages[i]);
        if (n >= 0 && n < minPostBoundaryScene) minPostBoundaryScene = n;
    }
    if (Number.isFinite(minPostBoundaryScene)) return chapterStart < minPostBoundaryScene;
    return false;
}

/**
 * Effective age = position-from-end − importanceBonus (if any scene in the
 * chapter has importance ≥ 8). Lower = "newer" for the summary-tier selection.
 */
function effectiveAge(
    chapter: ArchiveChapter,
    archiveIndex: ArchiveIndexEntry[],
    eligibleOrdered: ArchiveChapter[],
    importanceBonus: number,
): number {
    const positionFromEnd = eligibleOrdered.length - 1 - eligibleOrdered.indexOf(chapter);
    const hasHighImportanceScene = chapter.sceneIds.some(sid => {
        const entry = archiveIndex.find(e => e.sceneId === sid);
        if (!entry) return false;
        if (typeof entry.importance === 'number' && entry.importance >= 8) return true;
        return (entry.events ?? []).some(ev => ev.importance >= 8);
    });
    return positionFromEnd - (hasHighImportanceScene ? importanceBonus : 0);
}

function renderSummary(chapter: ArchiveChapter): string {
    return `Chapter ${chapter.chapterId} — ${chapter.title}\n${chapter.summary}`;
}

function renderSynopsis(chapter: ArchiveChapter): string {
    return `Chapter ${chapter.chapterId} — ${chapter.title}\n${firstSentence(chapter.summary) ?? chapter.title}`;
}

/** First sentence of `summary`, or null if the summary is empty/whitespace. */
function firstSentence(summary: string): string | null {
    if (!summary || !summary.trim()) return null;
    const match = summary.match(/^[^.!?]*[.!?]?/);
    const s = match ? match[0].trim() : summary.trim();
    return s.length > 0 ? s : null;
}

/** Pure, synchronous, deterministic. See the file header. */
export function renderLodChapters(input: LodRenderInput): LodRenderResult {
    const config = input.config ?? DEFAULT_LOD_CONFIG;
    const { chapters, archiveIndex, condensedUpToIndex, messages, budgetTokens } = input;

    // 1. Eligibility: sealed, valid chapters with at least one condensed scene.
    const eligible = chapters
        .filter(c => c.sealedAt !== undefined && !c.invalidated)
        .filter(c => hasCondensedScenes(c, messages, condensedUpToIndex));

    // 2. Order oldest → newest by end-scene number (stable on ties by chapterId).
    const ordered = eligible.slice().sort((a, b) => {
        const diff = sceneNum(a.sceneRange[1]) - sceneNum(b.sceneRange[1]);
        return diff !== 0 ? diff : a.chapterId.localeCompare(b.chapterId);
    });

    // 3. Tier assignment: newest `summaryChapters` by effective age → summary; rest → synopsis.
    const effectiveAges = new Map<string, number>();
    for (const ch of ordered) {
        effectiveAges.set(ch.chapterId, effectiveAge(ch, archiveIndex, ordered, config.importanceBonus));
    }
    const byEffectiveAge = ordered.slice().sort((a, b) => {
        const diff = effectiveAges.get(a.chapterId)! - effectiveAges.get(b.chapterId)!;
        return diff !== 0 ? diff : a.chapterId.localeCompare(b.chapterId);
    });
    const summarySet = new Set(byEffectiveAge.slice(0, config.summaryChapters).map(c => c.chapterId));

    const tierByChapterId: Record<string, LodTier> = {};
    for (const ch of ordered) {
        tierByChapterId[ch.chapterId] = summarySet.has(ch.chapterId) ? 'summary' : 'synopsis';
    }

    // 4. Render oldest → newest.
    const renderChapterText = (ch: ArchiveChapter): string =>
        tierByChapterId[ch.chapterId] === 'summary' ? renderSummary(ch) : renderSynopsis(ch);

    let text = ordered.map(renderChapterText).join('\n\n');
    let tokens = countTokens(text);

    // 5. Over budget: demote the oldest summary → synopsis, one at a time.
    if (tokens > budgetTokens) {
        for (let i = 0; i < ordered.length && tokens > budgetTokens; i++) {
            const ch = ordered[i];
            if (tierByChapterId[ch.chapterId] === 'summary') {
                tierByChapterId[ch.chapterId] = 'synopsis';
                text = ordered.map(renderChapterText).join('\n\n');
                tokens = countTokens(text);
            }
        }
    }

    // 6. Still over: drop the oldest synopsis, one at a time.
    if (tokens > budgetTokens) {
        for (let i = 0; i < ordered.length && tokens > budgetTokens; i++) {
            const ch = ordered[i];
            if (tierByChapterId[ch.chapterId] === 'synopsis') {
                tierByChapterId[ch.chapterId] = 'dropped';
                const surviving = ordered.filter(c => tierByChapterId[c.chapterId] !== 'dropped');
                text = surviving.map(renderChapterText).join('\n\n');
                tokens = countTokens(text);
            }
        }
    }

    return { text, tokens, tierByChapterId };
}

const LOD_ENVELOPE_PREFIX = '[LOD HISTORY — CONDENSED CHAPTERS]\n';
const LOD_ENVELOPE_SUFFIX = '\n[END LOD HISTORY]';

/**
 * The recap block for the prompt: the rendered chapters inside a fixed envelope,
 * capped at half the history budget so the verbatim window always keeps the rest.
 * Empty when nothing is condensed or no sealed chapter is behind the boundary.
 */
export function buildChapterRecapBlock(params: {
    chapters: ArchiveChapter[] | undefined;
    archiveIndex: ArchiveIndexEntry[] | undefined;
    messages: ChatMessage[];
    condensedUpToIndex: number | undefined;
    historyBudget: number;
}): { content: string; tokens: number; tierByChapterId: Record<string, LodTier> } {
    const { chapters, archiveIndex, messages, condensedUpToIndex, historyBudget } = params;
    const empty = { content: '', tokens: 0, tierByChapterId: {} };
    if (!chapters || chapters.length === 0 || condensedUpToIndex === undefined || condensedUpToIndex < 0) return empty;

    const allocation = Math.min(historyBudget, Math.max(200, Math.floor(historyBudget * 0.5)));
    // Reserve the envelope's cost (each half counted separately, so BPE merges across
    // the join can't under-count) so envelope + body fit the allocation.
    const envelopeCost = countTokens(LOD_ENVELOPE_PREFIX) + countTokens(LOD_ENVELOPE_SUFFIX);
    const result = renderLodChapters({
        chapters,
        archiveIndex: archiveIndex ?? [],
        condensedUpToIndex,
        messages,
        budgetTokens: Math.max(0, allocation - envelopeCost),
    });
    if (!result.text) return empty;
    const content = `${LOD_ENVELOPE_PREFIX}${result.text}${LOD_ENVELOPE_SUFFIX}`;
    return { content, tokens: countTokens(content), tierByChapterId: result.tierByChapterId };
}
