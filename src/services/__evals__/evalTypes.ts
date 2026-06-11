// Shared types for the retrieval eval harness (Plan 3).

export interface EvalScene {
    sceneId: string;
    content: string;
    keywords?: string[];
    npcsWitnessed?: string[];
}

export interface EvalQuery {
    query: string;
    /** Scene IDs that SHOULD be recalled (ground truth). */
    relevantSceneIds: string[];
    relevantLoreIds?: string[];
    /** Scene/lore IDs that recalling is a HARD failure (witness/divergence leak), not a score deduction. */
    mustNotRecall?: string[];
    notes?: string;
}

export interface EvalCampaign {
    id: string;
    description?: string;
    scenes: EvalScene[];
    queries: EvalQuery[];
}

export interface VectorEntry {
    id: string;
    vector: number[];
}

export interface VectorsCache {
    model: string;
    dims: number;
    docs: Record<'scene' | 'lore' | 'npc' | 'rule', VectorEntry[]>;
    /** query text → embedding */
    queries: Record<string, number[]>;
}
