# Refactor Tier A — Dangerous (Opus only)

> **Run on: Opus.** These are NOT pure refactors despite the label — each carries a real chance of silently changing behavior. **Prerequisite: the Tier C tests (#25-27) must be written and passing first**, so behavior is locked before these changes.

## A1 — Extract shared NPC-ID resolver (#1/#16/#17) — HIGH
- **Files:** `src/services/divergenceRegister.ts:149-205`, `src/services/saveFileEngine.ts:329-416`; new `src/services/npcIdResolver.ts`
- **Problem:** A ~60-line block (build `npcNameMap`, validate raw NPC IDs against ledger, resolve unrecognized names) is duplicated and has **already diverged** — `divergenceRegister.ts:183-192` has a dead/tautological guard absent from the other copy.
- **Danger:** There is no single "current behavior" to preserve — you must decide which behavior is correct. Affects campaign data integrity.
- **Fix:** Create `npcIdResolver.ts` exporting `resolveNpcIds(rawIds, unrecognizedNames, npcLedger): { resolvedIds; stillUnrecognized }`. Use the simpler ledger-membership check from `saveFileEngine.ts:354` (drops the tautological guard). Replace both call sites.
- **Verify:** Diff a sealed campaign before/after on identical input — output must be byte-identical.

## A2 — `buildPayload` options interface (#6) — HIGH
- **File:** `src/services/payloadBuilder.ts:74-444`
- **Problem:** 17 positional parameters; body mixes budget math, history fitting, scene-note injection, assembly.
- **Danger:** A single silent arg-reorder during conversion corrupts the LLM prompt with no error. This builds the core model input.
- **Fix:** Replace 17 positional params with a `BuildPayloadOptions` interface. Extract `computeBudgets()`, `fitHistory()`, `spliceSceneNote()` sub-functions.
- **Verify:** Snapshot the assembled payload string before/after for a fixed campaign turn — must match exactly.

## A3 — Split `handlePostTurn` (#5) — HIGH
- **File:** `src/services/turnPostProcess.ts:108-350`
- **Problem:** 242-line function doing 8 things, each an inlined `backgroundQueue.push(...)` closure.
- **Danger:** Closure capture and push-ordering are load-bearing; easy to subtly break execution order.
- **Fix:** Extract named helpers: `queueIndexPatch`, `queueNPCValidation`, `runNPCPressureScan`, `runBookkeepingScans`. Coordinator shrinks to ~30 lines. Preserve push order exactly.
- **Verify:** Confirm background-queue tasks execute in the same order; run a full turn end-to-end.

## A4 — Extract `buildDivergenceEntries` (#7) — MEDIUM
- **File:** `src/services/saveFileEngine.ts:276-438`
- **Problem:** `parseCombinedSealOutput` interleaves JSON recovery, summary parsing, divergence-entry construction, knownBy resolution, witness-correction extraction in 163 lines.
- **Danger:** Parses LLM output that writes permanent campaign history. **Do this only after A-prerequisite tests (#25) exist.**
- **Fix:** Extract `buildDivergenceEntries(divObj, sceneIds, npcLedger, chapterId)` (~76-line inner loop) and `extractWitnessCorrections(parsed)`. Main function becomes ~40-line coordinator.
- **Verify:** Tests from #25 must still pass; diff a sealed chapter before/after.

## A5 — Consolidate campaign-load path (#19) — MEDIUM
- **File:** `src/components/CampaignHub.tsx:204-215`
- **Problem:** `handleSelectCampaign` calls `useAppStore.setState` directly with 9 keys, bypassing `setActiveCampaign`'s background-queue clear, auto-backup timer setup, and embedder warmup.
- **Danger:** This INTENTIONALLY changes behavior — it adds init steps that currently do not run on the normal path. Verify it does not double-init.
- **Fix:** Route through `useAppStore.getState().setActiveCampaign(id)`; consolidate data loading inside that action as the single canonical entry point.
- **Verify:** Enter a campaign, confirm queue is cleared once, backup timer set once, embedder warmed once; no duplicate initialization.
