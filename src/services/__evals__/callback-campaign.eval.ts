import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Inject deterministic substitutes for the two nondeterministic seams in the
// vector-search path: the live embedder and the embeddings store. Everything
// else (cosine, MMR, floors, dedupe) is the REAL retrieval code.
vi.mock('../embedding/embedder', async () => {
    const { buildEmbedderMock } = await import('./evalFixtures');
    return buildEmbedderMock('callback-campaign');
});
vi.mock('../storage', async () => {
    const { buildStorageMock } = await import('./evalFixtures');
    return buildStorageMock('callback-campaign');
});

import { semanticSearchScored } from '../embedding/vectorSearch';
import { loadCampaign } from './evalFixtures';
import { scoreRetrieval, mean, round3, type StageResult } from './metrics';

// Tuning knobs under test — overridable via env so a deliberate break (e.g.
// SEMANTIC_FLOOR=0.95) can demonstrate the regression gate failing.
const K = Number(process.env.EVAL_K ?? 5);
const FLOOR = Number(process.env.SEMANTIC_FLOOR ?? 0.30); // SEMANTIC_FLOOR_SCENE
const TOPK_CANDIDATES = Number(process.env.EVAL_TOPK ?? 40);
const RECALL_REGRESSION_TOLERANCE = 0.05; // a >5pt recall drop fails the suite

const CAMPAIGN = 'callback-campaign';
const BASELINE_PATH = path.resolve(process.cwd(), 'src/services/__evals__/baseline.json');

const campaign = loadCampaign(CAMPAIGN);

describe(`eval: ${CAMPAIGN} — semantic scene recall (tier-low / pure vector)`, () => {
    const results: Record<string, StageResult> = {};

    beforeAll(async () => {
        for (const q of campaign.queries) {
            const hits = await semanticSearchScored(CAMPAIGN, [q.query], 'scene', TOPK_CANDIDATES, FLOOR);
            results[q.query] = scoreRetrieval((hits ?? []).map(h => h.id), q, K);
        }
    });

    // The ONLY absolute pass/fail is a hard violation (mustNotRecall leak — a
    // witness/divergence breach). Low recall is a measurement, not a failure; it
    // is gated relatively against the committed baseline below.
    it.each(campaign.queries.map(q => q.query))('no hard violations (mustNotRecall) for: %s', (query) => {
        expect(results[query].hardViolations).toEqual([]);
    });

    it('aggregate recall@K/precision@K — report, snapshot, and gate against baseline', () => {
        const perQuery = campaign.queries.map(q => ({
            query: q.query,
            [`recall@${K}`]: round3(results[q.query].recallAtK),
            [`precision@${K}`]: round3(results[q.query].precisionAtK),
            found: `${results[q.query].relevantFound}/${results[q.query].relevantTotal}`,
            top: results[q.query].retrieved.join(','),
        }));
        const meanRecallAtK = round3(mean(campaign.queries.map(q => results[q.query].recallAtK)));
        const meanPrecisionAtK = round3(mean(campaign.queries.map(q => results[q.query].precisionAtK)));

        console.table(perQuery);
        console.log(`[eval:${CAMPAIGN}] k=${K} floor=${FLOOR} candidates=${TOPK_CANDIDATES} → mean recall@${K}=${meanRecallAtK} precision@${K}=${meanPrecisionAtK}`);

        const current = {
            k: K,
            floor: FLOOR,
            candidates: TOPK_CANDIDATES,
            meanRecallAtK,
            meanPrecisionAtK,
            perQuery: Object.fromEntries(campaign.queries.map(q => [q.query, {
                recallAtK: round3(results[q.query].recallAtK),
                precisionAtK: round3(results[q.query].precisionAtK),
                relevantFound: results[q.query].relevantFound,
                relevantTotal: results[q.query].relevantTotal,
            }])),
        };

        const allBaselines = fs.existsSync(BASELINE_PATH)
            ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
            : {};
        const baseline = allBaselines[CAMPAIGN];

        if (baseline && !process.env.UPDATE_BASELINE) {
            // Regression gate: recall must not drop more than the tolerance vs. the committed baseline.
            expect(current.meanRecallAtK).toBeGreaterThanOrEqual(baseline.meanRecallAtK - RECALL_REGRESSION_TOLERANCE);
        } else {
            allBaselines[CAMPAIGN] = current;
            fs.writeFileSync(BASELINE_PATH, JSON.stringify(allBaselines, null, 2) + '\n');
            console.log(`[eval:${CAMPAIGN}] baseline ${baseline ? 'updated' : 'written'} → ${BASELINE_PATH}`);
        }
    });
});
