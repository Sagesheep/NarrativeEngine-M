import { describe, it, expect } from 'vitest';
import { tierAllows, NPC_UPDATE_COOLDOWN } from '../aiTier';
import type { TierFeature } from '../aiTier';

const ALL_FEATURES: TierFeature[] = [
    'introEngine', 'planner', 'expandQuery', 'reranker', 'archiveFunnel',
    'deepScan', 'recommender',
    'importanceRating', 'witnessAux', 'npcValidate', 'npcProfileGen',
    'npcUpdate', 'drivesBackfill', 'profileScan', 'pcFactScan', 'inventoryScan', 'sealChapter',
    'sceneStakesClassify',
    'heartbeatTick', 'timeskipRun',
    'arcTick', 'arcSpawn',
];

describe('tierAllows — lite', () => {
    it('returns false for all features', () => {
        for (const f of ALL_FEATURES) {
            expect(tierAllows('lite', f)).toBe(false);
        }
    });
});

// Off in every tier since the desktop port (see aiTier.ts).
const OFF_EVERYWHERE: TierFeature[] = ['archiveFunnel', 'expandQuery', 'planner'];

describe('tierAllows — max', () => {
    it('returns true for all features except the ones off everywhere', () => {
        for (const f of ALL_FEATURES) {
            expect(tierAllows('max', f)).toBe(!OFF_EVERYWHERE.includes(f));
        }
    });
});

describe('tierAllows — off everywhere', () => {
    it('chapter funnel, query expansion and planner are off in every tier', () => {
        for (const tier of ['lite', 'pro', 'max'] as const) {
            for (const f of OFF_EVERYWHERE) {
                expect(tierAllows(tier, f)).toBe(false);
            }
        }
    });
});

describe('tierAllows — pro', () => {
    const PRO_ON: TierFeature[] = [
        'recommender', 'deepScan',
        'npcValidate', 'npcProfileGen', 'npcUpdate', 'pcFactScan', 'sealChapter',
        'sceneStakesClassify', 'heartbeatTick', 'timeskipRun',
        'arcTick', 'arcSpawn',
    ];
    const PRO_OFF: TierFeature[] = [
        'introEngine', 'planner', 'expandQuery', 'reranker', 'archiveFunnel',
        'importanceRating', 'witnessAux', 'drivesBackfill', 'profileScan', 'inventoryScan',
    ];

    it('returns true for high-impact features', () => {
        for (const f of PRO_ON) {
            expect(tierAllows('pro', f)).toBe(true);
        }
    });

    it('returns false for polish-only features', () => {
        for (const f of PRO_OFF) {
            expect(tierAllows('pro', f)).toBe(false);
        }
    });
});

describe('tierAllows — undefined falls back to pro', () => {
    it('recommender is true (pro default)', () => {
        expect(tierAllows(undefined, 'recommender')).toBe(true);
    });

    it('reranker is false (pro default)', () => {
        expect(tierAllows(undefined, 'reranker')).toBe(false);
    });
});

describe('NPC_UPDATE_COOLDOWN', () => {
    it('lite is Infinity', () => {
        expect(NPC_UPDATE_COOLDOWN.lite).toBe(Infinity);
    });
    it('pro is 5', () => {
        expect(NPC_UPDATE_COOLDOWN.pro).toBe(5);
    });
    it('max is 0', () => {
        expect(NPC_UPDATE_COOLDOWN.max).toBe(0);
    });
});
