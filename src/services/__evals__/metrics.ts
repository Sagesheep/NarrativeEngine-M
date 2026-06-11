import type { EvalQuery } from './evalTypes';

export interface StageResult {
    k: number;
    recallAtK: number;
    precisionAtK: number;
    relevantFound: number;
    relevantTotal: number;
    /** mustNotRecall items that appeared in the top-k — any non-empty = hard failure. */
    hardViolations: string[];
    retrieved: string[];
}

/**
 * Scores one stage's retrieved IDs against a query's ground-truth labels.
 * Recall@k = fraction of labeled-relevant items present in the top-k.
 * Precision@k = fraction of top-k that are labeled-relevant (context pollution).
 * Hard violations = mustNotRecall items that leaked into the top-k.
 */
export function scoreRetrieval(retrievedIds: string[], labels: EvalQuery, k: number): StageResult {
    const top = retrievedIds.slice(0, k);
    const relevant = new Set(labels.relevantSceneIds);
    const mustNot = new Set(labels.mustNotRecall ?? []);

    const relevantFound = top.filter(id => relevant.has(id)).length;
    const recallAtK = relevant.size ? relevantFound / relevant.size : 1;
    const precisionAtK = top.length ? relevantFound / top.length : 0;
    const hardViolations = top.filter(id => mustNot.has(id));

    return { k, recallAtK, precisionAtK, relevantFound, relevantTotal: relevant.size, hardViolations, retrieved: top };
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
