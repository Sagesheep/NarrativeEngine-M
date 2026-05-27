import { countTokens } from '../infrastructure';

const CHAPTER_SUMMARY_TOKEN_BUDGET = 8000;

export function truncateScenesToBudget(
    scenes: { sceneId: string; content: string }[],
    budget: number = CHAPTER_SUMMARY_TOKEN_BUDGET
): { sceneId: string; content: string }[] {
    const totalTokens = scenes.reduce((sum, s) => sum + countTokens(s.content), 0);
    if (totalTokens <= budget) return scenes;

    const keepCount = Math.floor(scenes.length * 0.8);
    const dropCount = scenes.length - keepCount;
    const dropFromStart = Math.floor(dropCount * 0.25);
    const dropFromEnd = dropCount - dropFromStart;

    return [
        ...scenes.slice(0, scenes.length - dropFromEnd - dropFromStart),
        ...scenes.slice(scenes.length - dropFromEnd),
    ];
}

export { generateChapterSummary, parseChapterSummaryOutput, type ChapterSummaryOutput } from './chapterSummaryWriter';
export { sealChapterCombined, parseCombinedSealOutput, type CombinedSealResult } from './divergenceExtractor';