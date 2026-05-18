# Refactor Tier B — Moderate (Sonnet)

> **Run on: Sonnet.** Each item carries a small but real behavior shift — produce a before/after behavior diff for every one. Note: B2 and B4 are actually bug fixes, not pure refactors.

## B1 — Consolidate `extractJson` / `stripReasoning` (#2) — MEDIUM
- **Files:** `src/services/payloadBuilder.ts:14-39`, `src/services/divergenceRegister.ts:49-57`
- **Problem:** `stripReasoning` strips `<reasoning>`/`<reflection>` plus its own fence extraction, then calls `extractJson` anyway — two stripping passes, different tag sets.
- **Caution:** Broadening `extractJson`'s tag set affects EVERY caller, not just the divergence path.
- **Fix:** Fold the broader tag set into `extractJson` (or a shared `stripReasoningTags`). Delete the inline fence extraction from `stripReasoning`.
- **Verify:** Check all `extractJson` callers behave identically on existing inputs.

## B2 — `gatherContext` timeout fix (#8) — MEDIUM
- **File:** `src/services/turnContext.ts:68-346` (race at 165-174)
- **Problem:** The chapter-funnel race creates a `setTimeout`-backed promise; `clearTimeout` in `.finally()` can be skipped if an exception throws before `.finally()` attaches.
- **Note:** This is a real race-condition BUG FIX, not a refactor.
- **Fix:** Use reliable `try/finally` or an `AbortController`. Optionally split into `gatherSemanticCandidates()`, `gatherArchiveContext()`, `gatherNPCContext()`.
- **Verify:** Confirm timer is always cleared even on thrown exceptions.

## B3 — Standardize background-task error handling (#18) — MEDIUM
- **File:** `src/services/turnPostProcess.ts`
- **Problem:** Inconsistent: `auxWitnessFallback` (line 65) silent `catch {}`; index/profile/inventory scans `console.warn` only; `handleSealChapter` (line 429) shows `toast.error`.
- **Fix:** Policy — background tasks that affect persistent state should `toast.warning(...)` on failure. Apply consistently.
- **Verify:** Trigger each failure path, confirm user-visible feedback matches policy.

## B4 — ChatArea polling → store selector (#22) — MEDIUM
- **File:** `src/components/ChatArea.tsx:210-219`
- **Problem:** A 500ms `setInterval` polls `useAppStore.getState().messages` for the whole streaming duration, recomputing stats already dispatched by `runTurn` via `setStreamingStats`.
- **Fix:** Read `streamingStats` directly from the store via a selector; remove the interval.
- **Verify:** Streaming token/speed display matches the previous values during a live generation.

## B5 — Fix stale closures in `handleSend` (#24) — MEDIUM
- **File:** `src/components/ChatArea.tsx:79-157`
- **Problem:** Some fields read from component scope (stale), others from `useAppStore.getState()` (fresh). `npcLedger` is stale if an NPC was auto-generated between renders.
- **Note:** This is a latent bug fix.
- **Fix:** Read all frequently-mutated fields (`npcLedger`, `loreChunks`, `context`) from `useAppStore.getState()` at the top of `handleSend`, consistent with `messages`/`semanticFacts`.
- **Verify:** Auto-generate an NPC mid-session, send a message, confirm the fresh ledger is used.
