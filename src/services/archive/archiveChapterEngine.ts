import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, SemanticFact, LLMProvider } from '../../types';
import type { SearchHit } from '../embedding/vectorSearch';
import { extractContextActivations, expandActivationsWithFacts, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';
import { llmCall } from '../../utils/llmCall';

const AUTO_SEAL_SCENE_THRESHOLD = 25;

const MAX_LLM_ITERATIONS = 5;
const MAX_CONFIRMED_CHAPTERS = 3;

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
    };

    const nextChapterNum = chapters.length + 1;
    const newOpen: ArchiveChapter = {
        chapterId: `CH${String(nextChapterNum).padStart(2, '0')}`,
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

// ─── 3B. Iterative LLM Validation ───

/**
 * Ask LLM if a chapter is relevant to current context.
 * Uses tiny prompt (~200 tokens), expects YES/NO response (~5 tokens).
 * Fail-open: returns true on any error (never lose data).
 */
async function validateChapterRelevance(
    chapter: ArchiveChapter,
    userMessage: string,
    recentContext: string,
    provider: LLMProvider,
    signal?: AbortSignal
): Promise<boolean> {
    const prompt = [
        'You are a TTRPG story continuity checker. Given the current situation and a chapter summary, is this chapter relevant?',
        '',
        'Respond with ONLY: YES or NO',
        '',
        'CURRENT SITUATION:',
        userMessage.slice(0, 200), // Truncate to keep prompt small
        '',
        'RECENT CONTEXT:',
        recentContext.slice(-500), // keep it small
        '',
        'CHAPTER SUMMARY:',
        `Title: ${chapter.title}`,
        `Scenes: ${chapter.sceneRange[0]}-${chapter.sceneRange[1]}`,
        chapter.summary.slice(0, 300), // truncate to keep prompt small
        `NPCs: ${chapter.npcs.join(', ')}`,
        `Key events: ${chapter.majorEvents.slice(0, 3).join('; ')}`,
    ].join('\n');

    // 3s timeout per validation call. Also abort if the caller's signal fires
    // (the funnel lost gatherContext's race and is being cancelled — AUDIT F1).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const onExternalAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
        const answer = await llmCall(provider, prompt, {
            signal: controller.signal,
            maxTokens: 10,
        });
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
        return answer.trim().toUpperCase().startsWith('YES');
    } catch {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onExternalAbort);
        return true; // on timeout/error, assume relevant (fail-open)
    }
}

/**
 * Iteratively validate chapters with LLM until we have MAX_CONFIRMED_CHAPTERS
 * or reach MAX_LLM_ITERATIONS.
 * If no utilityProvider, gracefully degrades to top 3 by 3D score.
 */
export async function iterativeChapterFilter(
    rankedChapters: ArchiveChapter[],
    userMessage: string,
    recentMessages: ChatMessage[],
    utilityProvider?: LLMProvider,
    signal?: AbortSignal
): Promise<ArchiveChapter[]> {
    // If no utility AI configured, accept top 3 by 3D score (graceful degradation)
    if (!utilityProvider) {
        return rankedChapters.slice(0, MAX_CONFIRMED_CHAPTERS);
    }

    const recentContext = recentMessages.slice(-5).map(m => m.content || '').join('\n');
    const confirmed: ArchiveChapter[] = [];
    let iterations = 0;

    for (const chapter of rankedChapters) {
        if (signal?.aborted) break; // race lost — stop spending (AUDIT F1)
        if (confirmed.length >= MAX_CONFIRMED_CHAPTERS) break;
        if (iterations >= MAX_LLM_ITERATIONS) break;

        const isRelevant = await validateChapterRelevance(
            chapter, userMessage, recentContext, utilityProvider, signal
        );
        iterations++;

        if (isRelevant) {
            confirmed.push(chapter);
        }
        // If NO → continue to next ranked chapter
    }

    return confirmed;
}

// ─── 3D. Main Funnel Orchestrator ───

/**
 * Main chapter-aware retrieval funnel.
 *
 * Phase 1: Chapter-level 3D scoring
 * Phase 2: Iterative LLM validation
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
    filters?: { characters?: string[]; locations?: string[]; items?: string[]; concepts?: string[]; eventTypes?: string[] }
): Promise<{ scenes: string; usedTokens: number }> {
    // ─── Phase 1: Chapter-level 3D scoring ───
    const ranked = rankChapters(chapters, userMessage, recentMessages, npcLedger, semanticFacts);

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

    // ─── Phase 2: Iterative LLM validation ───
    const confirmed = await iterativeChapterFilter(
        ranked, userMessage, recentMessages, utilityProvider, signal
    );

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
export { MAX_LLM_ITERATIONS, MAX_CONFIRMED_CHAPTERS };
