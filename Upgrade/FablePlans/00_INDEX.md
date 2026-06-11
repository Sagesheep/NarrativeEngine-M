# Fable Plans — Index

Plans authored by Fable 5 (2026-06-10) for execution by cheaper models later.
Convention follows `Upgrade/CombatCompletion/`: each doc names a suggested executor tier.

| # | Doc | What | Suggested executor | Effort |
|---|-----|------|--------------------|--------|
| 1 | [01_embedding_hardening__OPUS.md](01_embedding_hardening__OPUS.md) | Fix 2 confirmed bugs + 3 issues in the already-built progressive embedding scheduler | OPUS (concurrency — do not give to FLASH) | ~½ day |
| 2 | [02_pipeline_audit__FABLE-OPUS.md](02_pipeline_audit__FABLE-OPUS.md) | Cross-file invariant audit of the context pipeline (witness leaks, token overflow, silent failures) | FABLE preferred; OPUS acceptable | 1–2 days |
| 3 | [03_retrieval_eval_harness__OPUS.md](03_retrieval_eval_harness__OPUS.md) | Measurable retrieval quality: fixtures + metrics + vitest target | OPUS (design done here; build is mechanical-ish) | 2–3 days |
| 4 | [04_god_node_decoupling__OPUS.md](04_god_node_decoupling__OPUS.md) | Split `gatherContext` into typed pipeline stages; introduce `UtilityLLM` port | OPUS, one stage at a time | 2–4 days, incremental |

## Recommended order

1 → 2 → 4 → 3.

- **1 first**: smallest, and two bugs are live in production right now.
- **2 second**: audit findings are cheapest to fix before refactoring moves the code.
- **4 before 3**: the eval harness (3) needs the seams that the decoupling (4) creates
  (especially the `UtilityLLM` port). Doing 3 first means building mocks twice.

## Status notes

- **Plan 1: DONE 2026-06-11** (Opus, verified by Fable; 802 tests green).
- **Plan 2: DONE 2026-06-11** (Fable) → [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md) — 14 findings (5×P1), 8 holds, fix-pass task list at the bottom. Fix pass not started.

- The progressive embedding feature from `progressive-embedding-spec` memory is **already implemented and wired**
  (`embeddingScheduler.ts`, `embedderPool.ts`, called from `loreIndexer.ts:52` / `rulesIndexer.ts:195`,
  aborted from `campaignSlice.ts:145` and `embedder.ts:160`). Plan 1 is hardening, not building.
- Combat simulator idea: parked (low priority per PM).

## Verification rule (applies to every plan)

`npm run build` (tsc -b — stricter than tests) **and** `npx vitest run` must both be green.
Lint only the files you touched; project-wide lint has ~93 pre-existing errors.
