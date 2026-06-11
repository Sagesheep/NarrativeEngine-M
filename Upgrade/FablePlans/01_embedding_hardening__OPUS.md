# Plan 1 — Progressive Embedding Hardening

**Executor:** OPUS. This is concurrency code; do not hand to a weaker model.
**Scope:** `src/services/embedding/embeddingScheduler.ts`, `src/services/embedding/embedderPool.ts`,
tests in `src/services/__tests__/embeddingScheduler.test.ts`.
**Status:** the feature is built and wired. This plan fixes defects Fable found by inspection (2026-06-10).

---

## Confirmed bugs (verify, then fix)

### BUG-1: Resume-after-pause never fires (HIGH)

`drainQueue()` pauses when `isStreaming` or `document.hidden` by setting `draining = false` and returning
(embeddingScheduler.ts:108-115). The resume listeners are supposed to restart it:

```ts
// store subscriber (line ~74)
if (state && state.isStreaming === false && draining && queue.length > 0) { drainQueue(); }
// visibility handler (line ~82)
if (!document.hidden && draining && queue.length > 0) { drainQueue(); }
```

The `draining` condition is **inverted**. After a pause, `draining` is `false`, so the condition is never true.
And if `draining` were `true`, `drainQueue()` would return immediately at its own guard (`if (draining) return`).
So the listeners can never restart a paused drain — pausing is permanent until the next `enqueueProgressive` call.

Consequence: user gets an AI reply mid-indexing (or backgrounds the app) → indexing stalls forever,
progress chip stuck, and per BUG-companion below the worker pool (~25–90 MB **per worker**, up to 6) stays resident.

**Fix:** change both conditions to `!draining && queue.length > 0`.

### BUG-2: `require()` in a Vite browser build (HIGH, verify first)

`getStore()` (embeddingScheduler.ts:43) uses CommonJS `require('../../store/useAppStore')`.
Vite browser bundles have no runtime `require`; the call throws, is swallowed by the `catch`,
and `getStore()` returns `null` — silently. Vitest runs in Node so **tests pass anyway**.

If confirmed at runtime, three behaviors are silently dead in the real app:
progress chip updates, pause-while-AI-streaming, and the stream-end resume listener.

**Verify:** `npm run dev`, upload lore, check the chip appears and `isStreaming` pause works.
Also check whether Vite statically transforms this `require` (look at the built chunk in `dist/`).

**Fix:** the `require` exists to dodge a circular import (store → campaignSlice → embedding index → scheduler).
Replace with one of:
- a `registerStore(store)` setter called once from `useAppStore.ts` after store creation (simplest, explicit), or
- a cached dynamic `import()` — but then `getStore()` becomes async; the setter is cleaner.
Keep `_setStoreRefForTesting` working.

---

## Lesser issues (fix while in there)

### ISSUE-3: Progress counters never reset after a successful drain

`doneCount` / `totalQueued` are only zeroed in `abortForCampaignSwitch`. After a drain completes,
the next upload shows inflated totals (e.g. "Indexing 1850/1900" for a 50-chunk upload).
Reset both in the completion branch of `drainQueue()` (the `queue.length === 0` path, line ~159).

### ISSUE-4: Spec deviation — per-chunk `poolEmbed` instead of batching

The agreed spec said use `embedBatch` (~6 per message) to cut worker round-trips. Current code sends
one message per chunk (`batch.map(entry => poolEmbed(entry.content, ...))`). Parallelism across workers
exists; per-worker batching does not. Low priority — only do it if the worker protocol already supports
a batch message; otherwise note-and-skip, the round-trip cost is small relative to inference.

### ISSUE-5: Silent storage failures

`embeddingStorage.store(...)` failures are swallowed (`catch {}`) and the chunk is counted as done.
The chunk will be retried on next app start via `enqueueProgressiveWithExistingCheck`'s storage diff,
so this is survivable — but add a `console.warn` with the chunk id so stalls are diagnosable.

---

## Test additions (the real point of this plan)

Extend `embeddingScheduler.test.ts`:

1. **Resume after streaming pause** — enqueue, set `isStreaming=true` mid-drain, assert drain stops;
   set `isStreaming=false`, fire the subscriber, assert drain completes. (Catches BUG-1; would have failed today.)
2. **Resume after visibility pause** — same with `document.hidden` mocked.
3. **Counter reset** — drain to completion, enqueue again, assert progress shows `0/new-total`.
4. **Store wiring** — once BUG-2's fix lands, a test that the production wiring path (not just
   `_setStoreRefForTesting`) connects the store. If using the setter approach: assert `useAppStore.ts`
   calls `registerStore` (import side-effect test).

## Acceptance

- `npm run build` green (tsc -b), `npx vitest run` green.
- Manual: upload big lore file → chip appears → trigger an AI reply mid-index → chip pauses →
  reply finishes → chip resumes and completes → pool terminates (check no lingering workers in devtools).
- `graphify . --update` after the change (per CLAUDE.md).
