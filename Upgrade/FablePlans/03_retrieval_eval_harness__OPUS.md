# Plan 3 — Retrieval Quality Eval Harness

**Executor:** OPUS (the design below is the hard part; the build is disciplined plumbing).
**Depends on:** Plan 4's `UtilityLLM` port (at minimum step 4.1). Do not start before that lands,
or you will build the LLM mocking twice.

## Why

The app's value is picking the *right* scenes/lore/facts for the prompt. Today there is no way to
measure whether a change to floors (`SEMANTIC_FLOOR_* = 0.30`), candidate counts (40/25/25),
the reranker, or the chapter funnel makes recall better or worse. Every tuning change is a guess.
The harness turns "feels better" into numbers, and pays off on every future prompt/model/ranking change.

## What it is

A vitest-runnable suite (`npm run eval` → `vitest run --config vitest.eval.config.ts`) that:
1. loads **fixture campaigns** with labeled ground truth,
2. runs the real retrieval stages with **deterministic** substitutes for the nondeterministic parts,
3. reports metrics per stage and end-to-end, and
4. snapshots a baseline so regressions fail CI-style.

## Determinism strategy (the crux)

| Nondeterministic piece | Substitute |
|---|---|
| Embedder (MiniLM worker) | Real model run in Node (transformers.js works in vitest) — embeddings are deterministic for fixed model+text. Cache vectors to a JSON fixture on first run so the suite is fast offline. |
| `llmCall` (planner, expandQuery, reranker, funnel, recommender) | Scripted responses via the `UtilityLLM` port: each fixture query carries optional canned planner/reranker outputs. Two suite modes: **tier-low** (all LLM features gated off — pure lexical+vector path) and **tier-scripted** (canned LLM outputs) — this also measures how much the LLM stages actually help, which is itself a finding. |
| `Date.now`, `uid()` | Fixed seeds in fixtures. |

## Fixtures

`src/services/__evals__/fixtures/` — 3 synthetic campaigns, small enough to hand-label:

1. **`callback-campaign`** (~60 scenes, 3 chapters): tests episodic recall. Queries like
   "what did I promise the smith" with labeled relevant scene IDs. Include distractors:
   scenes that share keywords but not meaning (keyword traps) and scenes that share meaning
   but not keywords (vector traps).
2. **`lore-campaign`** (~80 lore chunks across factions/locations): tests lore RAG + modes
   (`vector`/`keyword`/`always`), including priority ordering and the recommender-injection path.
3. **`witness-campaign`** (small): scenes with disjoint NPC witness sets — doubles as a regression
   bed for Plan 2's Invariant 1 findings.

Label format per query: `{ query, relevantSceneIds[], relevantLoreIds[], mustNotRecall[] }`.
`mustNotRecall` encodes witness/divergence violations as hard failures, not score deductions.

## Metrics

Per stage (semantic search → rerank → funnel/flat recall → final payload) and end-to-end:
- **Recall@k** of labeled-relevant items in what the stage passed forward
- **Precision@k** (context pollution — wrong scenes actively hurt the DM)
- **Token efficiency**: relevant-tokens / total-recall-tokens in the final payload
- **Hard violations**: any `mustNotRecall` item present → test failure, not a score
- **Latency proxy**: count of utility-LLM calls per turn (cost guard)

Output: console table + `__evals__/baseline.json` snapshot. A run that drops recall@k by >5 points
or adds a hard violation fails.

## Build steps

1. **Seam check** (½ day): the stages inside `gatherContext` (turnContext.ts:171) must be callable
   without the full `TurnState`. If Plan 4 step 4.2+ has landed, use the stage functions directly.
   If not, extract *only* a thin `runRetrieval(query, fixtureState, ports)` entry — do not refactor here.
2. **Fixture builder** (1 day): generator script (`scripts/build-eval-fixtures.mts`) that writes the three
   campaigns + embeds them with the Node embedder + caches vectors. Hand-write the labels; generate the filler.
3. **Metric runner** (½ day): `evalRunner.ts` — runs queries, computes the table, compares to baseline.
4. **Baseline + first findings** (½ day): commit the baseline. Document the initial numbers in
   `Upgrade/FablePlans/EVAL_BASELINE.md` — the first run will likely already expose tuning targets
   (the 0.30 floors and the funnel's 5 s race timeout are prime suspects).

## Non-goals

- Not a benchmark of the *narrative* output quality (that needs human/LLM judging — separate, later).
- Not CI-blocking initially; it's a local `npm run eval` until the baseline stabilizes.

## Acceptance

- `npm run eval` runs offline (cached vectors), deterministic across two consecutive runs.
- Baseline committed; intentionally breaking a ranker (e.g. floor 0.30→0.95) makes the suite fail.
- `npm run build` + `npx vitest run` stay green (eval suite isolated from the main test config).
