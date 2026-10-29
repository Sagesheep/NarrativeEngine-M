import type { ArchiveBook, ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, SemanticFact, LLMProvider } from '../../types';
import { bookOf, rankBooks, rankRangesByHits, isBookPickConfident, type BookSignals } from './bookEngine';
import { nextChapterNumber, chapterIdFor } from '../../utils/chapterIds';
import type { SearchHit } from '../embedding/vectorSearch';
import { extractContextActivations, expandActivationsWithFacts, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';
import { llmCall } from '../../utils/llmCall';

const AUTO_SEAL_SCENE_THRESHOLD = 25;

const MAX_CONFIRMED_CHAPTERS = 3;
/** Chapters shown to the one batched check — the top of the ranking. */
const CHAPTER_CHECK_CANDIDATES = 6;
/** The check must answer inside the funnel's 5s race (archiveRecallStage), with time left to fetch scenes. */
const CHAPTER_CHECK_TIMEOUT_MS = 3500;
/** RRF constant, as in the scene-level fusion (archiveMemory fuseRecall). */
const CHAPTER_RRF_K = 60;

export type AutoSealResult = {
    shouldSeal: boolean;
    reason: string;
};

export function shouldAutoSeal(
    chapters: ArchiveChapter[],
): AutoSealResult {
    const openChapter = chapters.find(c => !c.sealedAt);
    if (!openChapter) {
        return { shouldSeal: false, reason: 'no_open_chapter' };
    }

    const sceneCount = openChapter.sceneIds?.length ?? 0;

    if (sceneCount >= AUTO_SEAL_SCENE_THRESHOLD) {
        return { shouldSeal: true, reason: 'scene_threshold' };
    }

    return { shouldSeal: false, reason: '' };
}

export function sealChapter(
    chapters: ArchiveChapter[],
): { sealedChapter: ArchiveChapter; newOpenChapter: ArchiveChapter } {
    const openChapter = chapters.find(c => !c.sealedAt);
    if (!openChapter) {
        throw new Error('No open chapter to seal');
    }

    const lastScene = openChapter.sceneIds?.length
        ? openChapter.sceneIds[openChapter.sceneIds.length - 1]
        : openChapter.sceneRange[1];
    const nextSceneNum = parseInt(lastScene, 10) + 1;
    const nextScene = String(nextSceneNum).padStart(3, '0');

    const sealed: ArchiveChapter = {
        ...openChapter,
        sealedAt: Date.now(),
        // B4 — dedupe sceneIds on seal. The boundary scene was recording twice in some
        // saves (25 ids / sceneCount 24). Array.from(new Set(...)) collapses any dups so
        // sceneIds.length agrees with sceneCount.
        sceneIds: Array.from(new Set(openChapter.sceneIds ?? [])),
        sceneCount: Array.from(new Set(openChapter.sceneIds ?? [])).length,
    };

    const nextChapterNum = nextChapterNumber(chapters);
    const newOpen: ArchiveChapter = {
        chapterId: chapterIdFor(nextChapterNum),
        title: 'Open Chapter',
        sceneRange: [nextScene, nextScene],
        sceneIds: [],
        summary: '',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 0,
    };

    return { sealedChapter: sealed, newOpenChapter: newOpen };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Iterative Funnel Retrieval
// Chapter-aware archive retrieval using 3D scoring + iterative LLM validation.
// ─────────────────────────────────────────────────────────────────────────────



// ─── 3A. Chapter-Level 3D Scoring ───

/**
 * Score a single chapter using 3D scoring formula adapted for chapters.
 * score = (0.5 × recency) + (1.0 × importance) + (2.0 × activation)
 */
export function scoreChapter(
    chapter: ArchiveChapter,
    contextActivations: Record<string, number>,
    latestSceneNum: number
): number {
    // D1: Recency — use sceneRange midpoint position relative to current scene
    const midScene = (parseInt(chapter.sceneRange[0]) + parseInt(chapter.sceneRange[1])) / 2;
    const chaptersSince = latestSceneNum - midScene;
    const recencyBonus = 1 / (1 + Math.log(1 + Math.max(0, chaptersSince)));

    // D2: Intrinsic importance — derived from majorEvents count + has unresolved threads
    const importance = Math.min(10, 3 + chapter.majorEvents.length + (chapter.unresolvedThreads.length * 2));

    // D3: Activation strength — keyword + NPC match against current context
    let activation = 0;
    for (const keyword of chapter.keywords) {
        const kw = keyword.toLowerCase();
        if (contextActivations[kw]) {
            activation += contextActivations[kw] * 1.0;
        }
    }
    for (const npc of chapter.npcs) {
        const npcLower = npc.toLowerCase();
        if (contextActivations[npcLower]) {
            activation += contextActivations[npcLower] * 2.0; // NPCs weighted higher
        }
    }

    return (0.5 * recencyBonus) + (1.0 * importance) + (2.0 * activation);
}

/**
 * Rank all sealed chapters with summaries by 3D score.
 * Returns chapters sorted by score descending (best first).
 */
export function rankChapters(
    chapters: ArchiveChapter[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    semanticFacts?: SemanticFact[]
): ArchiveChapter[] {
    // Only score sealed chapters with summaries
    const sealed = chapters.filter(c => c.sealedAt && c.summary);

    if (sealed.length === 0) return [];

    const contextActivations = extractContextActivations(userMessage, recentMessages, npcLedger);
    const expandedActivations = expandActivationsWithFacts(contextActivations, semanticFacts);

    // Find the latest scene number from all chapters
    const allEndScenes = chapters.map(c => parseInt(c.sceneRange[1], 10));
    const latestSceneNum = Math.max(...allEndScenes, 0);

    const scored = sealed.map(ch => ({
        chapter: ch,
        score: scoreChapter(ch, expandedActivations, latestSceneNum),
    }));

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(s => s.chapter);
}

// ─── 3B. Batched LLM Check ───

/** One chapter as the check sees it: id, scenes, title, summary, key events, cast. */
function chapterCard(chapter: ArchiveChapter): string {
    const events = chapter.majorEvents.slice(0, 3).join('; ');
    const npcs = chapter.npcs.slice(0, 6).join(', ');
    return [
        `${chapter.chapterId} [scenes ${chapter.sceneRange[0]}-${chapter.sceneRange[1]}] "${chapter.title}"`,
        chapter.summary.slice(0, 400),
        events ? `Events: ${events}` : '',
        npcs ? `NPCs: ${npcs}` : '',
    ].filter(Boolean).join('\n');
}

/**
 * Read the check's answer: the candidate ids it named, in its order. Null when
 * the answer names none and is not a clear "none" — a failed call, not a NO.
 */
export function parseChapterPicks(answer: string, candidateIds: string[]): string[] | null {
    const known = new Set(candidateIds);
    const named = Array.from(new Set((answer.match(/\bCH\d+[A-Z]?\b/gi) ?? []).map(id => id.toUpperCase())))
        .filter(id => known.has(id));
    if (named.length > 0) return named.slice(0, MAX_CONFIRMED_CHAPTERS);
    return /\[\s*\]|\bnone\b/i.test(answer) ? [] : null;
}

/**
 * Which of the top-ranked chapters does this turn need? One utility call over
 * the top CHAPTER_CHECK_CANDIDATES chapter cards returns up to
 * MAX_CONFIRMED_CHAPTERS ids — it used to be up to five YES/NO calls one after
 * another, which often lost the funnel's 5s race.
 * - No utility AI: the top MAX_CONFIRMED_CHAPTERS by rank.
 * - Error, timeout or an unreadable answer: the same (fail-open, never lose data).
 * - Already aborted (the funnel lost its race): nothing, and no call.
 */
export async function batchChapterFilter(
    rankedChapters: ArchiveChapter[],
    userMessage: string,
    recentMessages: ChatMessage[],
    utilityProvider?: LLMProvider,
    signal?: AbortSignal
): Promise<ArchiveChapter[]> {
    const candidates = rankedChapters.slice(0, CHAPTER_CHECK_CANDIDATES);
    const fallback = candidates.slice(0, MAX_CONFIRMED_CHAPTERS);
    if (!utilityProvider) return fallback;
    if (signal?.aborted || candidates.length === 0) return [];

    const recentContext = recentMessages.slice(-5).map(m => m.content || '').join('\n');
    const prompt = [
        'You are a TTRPG story continuity checker. Pick the past chapters the GM needs to answer the current moment.',
        '',
        `Reply with ONLY a JSON array of up to ${MAX_CONFIRMED_CHAPTERS} chapter ids, most needed first, e.g. ["CH04","CH11"].`,
        'Reply [] if none of them matter right now.',
        '',
        'CURRENT SITUATION:',
        userMessage.slice(0, 300),
        '',
        'RECENT CONTEXT:',
        recentContext.slice(-600),
        '',
        'CHAPTERS:',
        candidates.map(chapterCard).join('\n\n'),
    ].join('\n');

    // Abort on our own timeout or when the caller's signal fires (the funnel
    // lost gatherContext's race and is being cancelled — AUDIT F1).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHAPTER_CHECK_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
        const answer = await llmCall(utilityProvider, prompt, {
            signal: controller.signal,
            maxTokens: 40,
            thinkingEffort: 'off',
            trackingLabel: 'chapter-check',
        });
        const picks = parseChapterPicks(answer, candidates.map(c => c.chapterId));
        if (picks === null) return fallback;
        return picks.map(id => candidates.find(c => c.chapterId === id)!);
    } catch {
        return signal?.aborted ? [] : fallback;
    } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
    }
}

/**
 * Fold this turn's scene vector hits into the chapter ranking (reciprocal-rank
 * fusion of the 3D-score order and the per-chapter hit roll-up). The 3D score
 * leans on importance, so without this a chapter the player's words point at by
 * meaning but not by keyword sat far down the list.
 */
export function fuseChapterHits(ranked: ArchiveChapter[], hits: BookSignals['sceneHits']): ArchiveChapter[] {
    const byHits = rankRangesByHits(ranked.map(c => ({ id: c.chapterId, sceneRange: c.sceneRange })), hits);
    if (byHits.length === 0) return ranked;
    const score = new Map<string, number>();
    ranked.forEach((c, i) => score.set(c.chapterId, 1 / (CHAPTER_RRF_K + i + 1)));
    byHits.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (CHAPTER_RRF_K + i + 1)));
    // Stable: ties keep the 3D-score order.
    return ranked
        .map((c, i) => ({ c, i, s: score.get(c.chapterId)! }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map(x => x.c);
}

/**
 * Move chapters in `bookIds` — and chapters not yet in any book — ahead of the
 * rest, keeping chapter-score order inside each group. A boost, not a filter: a
 * wrong book pick only pushes the right chapter back, it never removes it.
 */
export function boostBookChapters(ranked: ArchiveChapter[], books: ArchiveBook[], bookIds: string[]): ArchiveChapter[] {
    const wanted = new Set(bookIds);
    const front: ArchiveChapter[] = [];
    const back: ArchiveChapter[] = [];
    for (const ch of ranked) {
        const b = bookOf(ch, books);
        (!b || wanted.has(b.bookId) ? front : back).push(ch);
    }
    return [...front, ...back];
}

// ─── 3D. Main Funnel Orchestrator ───

/**
 * Main chapter-aware retrieval funnel.
 *
 * Phase 0: Book shortlist — with books, chapters in the best-matching books (pinned,
 *          planner-picked, vector and keyword matches) plus chapters not yet in a
 *          book move to the front of the chapter ranking; the rest stay behind them
 * Phase 1: Chapter-level 3D scoring, fused with the scene vector hits per chapter
 * Phase 2: One batched LLM check over the top chapters — skipped when the book
 *          pick is clear (a pinned book, or planner and vectors agree)
 * Phase 3: Build scene ranges from confirmed chapters + open chapter
 * Phase 4: Scene-level 3D scoring within ranges
 * Phase 5: Fetch scenes within token budget
 */
export async function recallWithChapterFunnel(
    campaignId: string,
    chapters: ArchiveChapter[],
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger: NPCEntry[],
    semanticFacts: SemanticFact[],
    tokenBudget: number,
    utilityProvider: LLMProvider,
    _countTokens?: (text: string) => number,
    semanticCandidateIds?: string[] | SearchHit[],
    signal?: AbortSignal,
    divergenceSceneIds?: Set<string>,
    filters?: { characters?: string[]; locations?: string[]; items?: string[]; concepts?: string[]; eventTypes?: string[] },
    books?: ArchiveBook[],
    bookSignals?: Pick<BookSignals, 'pinnedBookIds' | 'plannerBookIds'>,
): Promise<{ scenes: string; usedTokens: number }> {
    // ─── Phase 1: Chapter-level 3D scoring ───
    let ranked = fuseChapterHits(
        rankChapters(chapters, userMessage, recentMessages, npcLedger, semanticFacts),
        semanticCandidateIds,
    );

    // ─── Phase 0 (applied to the ranking): zoom into the matching books ───
    const signals: BookSignals = { ...bookSignals, sceneHits: semanticCandidateIds };
    let confident = false;
    if (books && books.length > 0 && ranked.length > 0) {
        const activations = expandActivationsWithFacts(extractContextActivations(userMessage, recentMessages, npcLedger), semanticFacts);
        const picked = rankBooks(books, activations, signals);
        if (picked.length > 0) {
            ranked = boostBookChapters(ranked, books, picked);
            confident = isBookPickConfident(books, signals);
            console.log(`[Funnel] books ${picked.join(', ')} first${confident ? ' (confident — no chapter check)' : ''}`);
        }
    }

    if (ranked.length === 0) {
        // No sealed chapters with summaries — fall back to flat retrieval
        const scenes = await fetchArchiveScenes(campaignId, 
            retrieveArchiveMemory(index, userMessage, recentMessages, npcLedger, undefined, semanticFacts, undefined, semanticCandidateIds, divergenceSceneIds, filters),
            tokenBudget
        );
        const sceneText = scenes.map(s => `\n--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n');
        const usedTokens = scenes.reduce((sum, s) => sum + s.tokens, 0);
        return { scenes: sceneText, usedTokens };
    }

    // ─── Phase 2: One batched LLM check — skipped when the book pick is clear ───
    const confirmed = confident
        ? ranked.slice(0, MAX_CONFIRMED_CHAPTERS)
        : await batchChapterFilter(ranked, userMessage, recentMessages, utilityProvider, signal);

    // ─── Phase 3: Build scene ranges ───
    const sceneRanges: [string, string][] = confirmed.map(ch => ch.sceneRange);

    // Always include the open chapter's scenes
    const openChapter = chapters.find(c => !c.sealedAt);
    if (openChapter) {
        sceneRanges.push(openChapter.sceneRange);
    }

    // ─── Phase 4: Scene-level 3D scoring within ranges ───
    const matchedIds = retrieveArchiveMemory(
        index, userMessage, recentMessages, npcLedger,
        undefined, semanticFacts, sceneRanges, semanticCandidateIds, divergenceSceneIds, filters
    );

    if (matchedIds.length === 0) {
        const flatIds = retrieveArchiveMemory(index, userMessage, recentMessages, npcLedger, undefined, semanticFacts, undefined, semanticCandidateIds, divergenceSceneIds, filters);
        const scenes = await fetchArchiveScenes(campaignId, flatIds, tokenBudget);
        const sceneText = scenes.map(s => `\n--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n');
        const usedTokens = scenes.reduce((sum, s) => sum + s.tokens, 0);
        return { scenes: sceneText, usedTokens };
    }

    // ─── Phase 5: Fetch within budget ───
    const scenes = await fetchArchiveScenes(campaignId, matchedIds, tokenBudget);
    const sceneText = scenes.map(s => `\n--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n');
    const usedTokens = scenes.reduce((sum, s) => sum + s.tokens, 0);

    return { scenes: sceneText, usedTokens };
}

// Re-export constants for testing
export { MAX_CONFIRMED_CHAPTERS, CHAPTER_CHECK_CANDIDATES };
