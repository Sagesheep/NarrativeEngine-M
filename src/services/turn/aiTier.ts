export type AiTier = 'lite' | 'pro' | 'max';
export type TierFeature =
  | 'introEngine' | 'planner' | 'expandQuery' | 'reranker' | 'archiveFunnel'
  | 'deepScan' | 'recommender'
  | 'importanceRating' | 'witnessAux' | 'npcValidate' | 'npcProfileGen'
  | 'npcUpdate' | 'drivesBackfill' | 'profileScan' | 'inventoryScan' | 'sealChapter'
  | 'sceneStakesClassify'
  | 'heartbeatTick' | 'timeskipRun'
  | 'arcTick' | 'arcSpawn'
  | 'directorBrief';

// archiveFunnel, expandQuery and planner are off in every tier (ported from
// desktop, 2026-10). The funnel let a yes/no model call pick up to three chapters
// from their summaries and searched scenes only inside them, discarding
// meaning-search hits elsewhere; recall uses archive-wide hybrid search instead.
// Expansion on its own found fewer of the right scenes than plain search on
// desktop's probes. The planner's picks never changed which scenes reached the
// writer, and it is a model call the turn waits on.
// The code paths stay; flip a tier here to bring one back.
const MATRIX: Record<AiTier, Record<TierFeature, boolean>> = {
    lite: {
        introEngine: false, planner: false, expandQuery: false, reranker: false, archiveFunnel: false,
        deepScan: false, recommender: false,
        importanceRating: false, witnessAux: false, npcValidate: false, npcProfileGen: false,
        npcUpdate: false, drivesBackfill: false, profileScan: false, inventoryScan: false, sealChapter: false,
        sceneStakesClassify: false,
        heartbeatTick: false, timeskipRun: false,
        arcTick: false, arcSpawn: false,
        directorBrief: false,
    },
    pro: {
        introEngine: false, planner: false, expandQuery: false, reranker: false, archiveFunnel: false,
        deepScan: true, recommender: true,
        importanceRating: false, witnessAux: false, npcValidate: true, npcProfileGen: true,
        npcUpdate: true, drivesBackfill: false, profileScan: false, inventoryScan: false, sealChapter: true,
        sceneStakesClassify: true,
        heartbeatTick: true, timeskipRun: true,
        arcTick: true, arcSpawn: true,
        directorBrief: true,
    },
    max: {
        introEngine: true, planner: false, expandQuery: false, reranker: true, archiveFunnel: false,
        deepScan: true, recommender: true,
        importanceRating: true, witnessAux: true, npcValidate: true, npcProfileGen: true,
        npcUpdate: true, drivesBackfill: true, profileScan: true, inventoryScan: true, sealChapter: true,
        sceneStakesClassify: true,
        heartbeatTick: true, timeskipRun: true,
        arcTick: true, arcSpawn: true,
        directorBrief: true,
    },
};

export function tierAllows(tier: AiTier | undefined, f: TierFeature): boolean {
    return MATRIX[tier ?? 'pro']?.[f] ?? false;
}

// 0 = every turn (Max), Infinity = never (Lite)
export const NPC_UPDATE_COOLDOWN: Record<AiTier, number> = { lite: Infinity, pro: 5, max: 0 };
