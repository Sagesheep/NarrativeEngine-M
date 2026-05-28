export type AiTier = 'lite' | 'pro' | 'max';
export type TierFeature =
  | 'introEngine' | 'planner' | 'expandQuery' | 'reranker' | 'archiveFunnel'
  | 'deepScan' | 'recommender'
  | 'importanceRating' | 'witnessAux' | 'npcValidate' | 'npcProfileGen'
  | 'npcUpdate' | 'drivesBackfill' | 'profileScan' | 'inventoryScan' | 'sealChapter';

const MATRIX: Record<AiTier, Record<TierFeature, boolean>> = {
    lite: {
        introEngine: false, planner: false, expandQuery: false, reranker: false, archiveFunnel: false,
        deepScan: false, recommender: false,
        importanceRating: false, witnessAux: false, npcValidate: false, npcProfileGen: false,
        npcUpdate: false, drivesBackfill: false, profileScan: false, inventoryScan: false, sealChapter: false,
    },
    pro: {
        introEngine: false, planner: true, expandQuery: false, reranker: false, archiveFunnel: true,
        deepScan: true, recommender: true,
        importanceRating: false, witnessAux: false, npcValidate: true, npcProfileGen: true,
        npcUpdate: true, drivesBackfill: false, profileScan: false, inventoryScan: false, sealChapter: true,
    },
    max: {
        introEngine: true, planner: true, expandQuery: true, reranker: true, archiveFunnel: true,
        deepScan: true, recommender: true,
        importanceRating: true, witnessAux: true, npcValidate: true, npcProfileGen: true,
        npcUpdate: true, drivesBackfill: true, profileScan: true, inventoryScan: true, sealChapter: true,
    },
};

export function tierAllows(tier: AiTier | undefined, f: TierFeature): boolean {
    return MATRIX[tier ?? 'pro']?.[f] ?? false;
}

// 0 = every turn (Max), Infinity = never (Lite)
export const NPC_UPDATE_COOLDOWN: Record<AiTier, number> = { lite: Infinity, pro: 5, max: 0 };
