import { countTokens } from '../infrastructure';

const CHAPTER_SUMMARY_TOKEN_BUDGET = 8000;
const GM_MARKER = '**[GM]**';
const CUT = '\n[…]\n';
/** Share of an over-budget scene's allowance kept for the player's turn (header + [USER]). */
const USER_SHARE = 0.3;
/** Of the GM reply's allowance: the head (setup) gets this, the tail (outcome) the rest. */
const GM_HEAD_SHARE = 0.4;

/**
 * Fit a chapter's scenes into `budget` tokens without dropping any scene. Each
 * scene gets an even share — scenes under their share keep everything and hand
 * the rest to longer ones — and a scene over its share keeps its header, the
 * player's turn, and the head and tail of the GM reply (the setup and the
 * outcome), cutting from the middle.
 */
export function truncateScenesToBudget(
    scenes: { sceneId: string; content: string }[],
    budget: number = CHAPTER_SUMMARY_TOKEN_BUDGET
): { sceneId: string; content: string }[] {
    const sizes = scenes.map(s => countTokens(s.content));
    const total = sizes.reduce((sum, n) => sum + n, 0);
    if (total <= budget || scenes.length === 0) return scenes;

    const cap = evenShare(sizes, budget);
    return scenes.map((s, i) => sizes[i] <= cap ? s : { ...s, content: trimScene(s.content, cap) });
}

/** Largest per-scene allowance such that Σ min(size, allowance) ≤ budget. */
function evenShare(sizes: number[], budget: number): number {
    const sorted = [...sizes].sort((a, b) => a - b);
    let remaining = budget;
    for (let i = 0; i < sorted.length; i++) {
        const share = remaining / (sorted.length - i);
        if (sorted[i] > share) return Math.max(1, Math.floor(share));
        remaining -= sorted[i];
    }
    return sorted[sorted.length - 1];
}

function trimScene(content: string, cap: number): string {
    const at = content.indexOf(GM_MARKER);
    if (at < 0) return headTail(content, cap, GM_HEAD_SHARE);
    // Header + player's turn, then the GM reply. A short player turn leaves its
    // unused share to the GM reply.
    const user = headTail(content.slice(0, at), Math.floor(cap * USER_SHARE), 0.5);
    const gmCap = Math.max(0, cap - countTokens(user) - countTokens(GM_MARKER));
    return `${user}${GM_MARKER}${headTail(content.slice(at + GM_MARKER.length), gmCap, GM_HEAD_SHARE)}`;
}

/** Keep `headShare` of `cap` from the start and the rest from the end. */
function headTail(text: string, cap: number, headShare: number): string {
    if (countTokens(text) <= cap) return text;
    const room = Math.max(0, cap - countTokens(CUT));
    const headCap = Math.floor(room * headShare);
    return `${clipStart(text, headCap)}${CUT}${clipEnd(text, room - headCap)}`;
}

/** Longest prefix of `text` within `tokens`, cut at whitespace. */
function clipStart(text: string, tokens: number): string {
    return clip(text, tokens, len => text.slice(0, len), s => s.replace(/\s+\S*$/, ''));
}

/** Longest suffix of `text` within `tokens`, cut at whitespace. */
function clipEnd(text: string, tokens: number): string {
    return clip(text, tokens, len => text.slice(text.length - len), s => s.replace(/^\S*\s+/, ''));
}

/** Estimate a char length from the text's chars-per-token, then shrink until it fits. */
function clip(text: string, tokens: number, take: (len: number) => string, atWord: (s: string) => string): string {
    if (tokens <= 0) return '';
    const total = countTokens(text);
    if (total <= tokens) return text;
    let len = Math.floor(text.length * (tokens / total));
    for (let i = 0; i < 8 && len > 0; i++) {
        const piece = atWord(take(len)) || take(len);
        if (countTokens(piece) <= tokens) return piece;
        len = Math.floor(len * 0.9);
    }
    return '';
}

export { generateChapterSummary, parseChapterSummaryOutput, type ChapterSummaryOutput } from './chapterSummaryWriter';
export { sealChapterCombined, parseCombinedSealOutput, type CombinedSealResult } from './divergenceExtractor';
