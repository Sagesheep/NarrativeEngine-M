# Phase 11: LLM Request Queue + Auto-Backup Timer

## Goal
Add a priority-based LLM request queue with adaptive 429 backoff, and an auto-backup timer that fires every 10 minutes during active play.

## Dependencies
None. Pure TypeScript additions.

## Files to Create

### 1. `src/services/llmRequestQueue.ts` (~113 lines)

Port verbatim from `../mainApp/src/services/llmRequestQueue.ts`.

The file exports:
- `LLMCallPriority` type: `'high' | 'normal' | 'low'`
- `LLMRequestQueue` class — priority-ordered adaptive concurrency semaphore
- `llmQueue` singleton instance

Behaviour:
- Starts unbounded (`maxConcurrent = Infinity`) — all callers fire as fast as the stagger allows
- Stagger (default 500ms) enforces minimum gap between consecutive slot grants
- On 429 the caller invokes `onRateLimitHit()`, which lowers `maxConcurrent` to `(inflight - 1)`, clamped to minimum 1
- Priority — highest priority served first (high > normal > low). FIFO within same tier

Usage pattern:
```ts
await llmQueue.acquireSlot('high');
try { /* fetch */ } finally { llmQueue.releaseSlot(); }
```

### 2. `src/services/callLLM.ts` (~97 lines)

Port verbatim from `../mainApp/src/services/callLLM.ts`.

The file exports:
- `callLLM(provider, prompt, options?)` — queue-aware non-streaming LLM call with retry

Behaviour:
- Acquires slot from `llmQueue` at the given priority
- Fires `fetch(url, ...)` with OpenAI-compatible `/chat/completions` body, `stream: false`
- On 429: calls `llmQueue.onRateLimitHit()`, releases slot, sleeps for `Retry-After` header value (or 300ms default), then re-queues
- Up to 3 retries (4 total attempts)
- On network error / abort: releases slot, re-throws

Priority guide:
- `'high'` — context recommender (pre-turn; story AI depends on it)
- `'normal'` — story AI, general calls
- `'low'` — post-turn background tasks (inventory, profile, importance, save)

Options:
```ts
{
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    priority?: LLMCallPriority;
}
```

## Files to Modify

### 3. `src/services/inventoryParser.ts`

**Current:** Local standalone `callLLM` function using raw `fetch()`.

**Change:** Remove local `callLLM`. Import and use `callLLM` from `./callLLM` with `priority: 'low'`.

### 4. `src/services/characterProfileParser.ts`

**Current:** Local standalone `callLLM` function using raw `fetch()`.

**Change:** Same as inventoryParser. Remove local `callLLM`. Import shared `callLLM` with `priority: 'low'`.

### 5. `src/services/importanceRater.ts`

**Current:** Raw `fetch()` for utility LLM call.

**Change:** Replace with `callLLM(provider, prompt, { priority: 'low' })`.

### 6. `src/services/contextRecommender.ts`

**Current:** Raw `fetch()` for context recommendation LLM call.

**Change:** Replace with `callLLM(provider, prompt, { priority: 'high', signal })`.

### 7. `src/services/condenser.ts`

**Current:** Calls `sendMessage()` for condensation.

**Change:** Wrap condense call with queue: `await llmQueue.acquireSlot('normal')` before, `llmQueue.releaseSlot()` in finally block.

### 8. `src/services/turnOrchestrator.ts` (~line 693)

**Current:** AI player `sendMessage()` call is raw streaming fetch.

**Change:** Wrap AI player LLM calls with `llmQueue.acquireSlot('normal')` / `llmQueue.releaseSlot()`. The main story streaming call (`sendMessage` in `llmService.ts`) does NOT go through the queue — it's already a single streaming call.

## Auto-Backup Timer

### 9. `src/store/slices/campaignSlice.ts`

Add at module scope (following existing timer patterns like `debouncedSaveCampaignState`):

```ts
let autoBackupTimer: ReturnType<typeof setInterval> | null = null;
```

Inside `setActiveCampaign`, add timer lifecycle:

**On entry** (before the `if (id)` block):
```ts
if (autoBackupTimer) {
    clearInterval(autoBackupTimer);
    autoBackupTimer = null;
}
```

**Inside `if (id)` block** (after the existing parallel load):
```ts
autoBackupTimer = setInterval(async () => {
    const state = get();
    if (!state.activeCampaignId) return;
    try {
        await offlineStorage.backup.create(state.activeCampaignId, {
            trigger: 'auto',
            isAuto: true
        });
    } catch (e) {
        console.warn('[Auto-Backup] Failed:', e);
    }
}, 10 * 60 * 1000);
```

Uses `offlineStorage.backup.create()` (IndexedDB) instead of mainApp's `fetch()` to server — matches mobileApp's offline-first architecture.

---

## Verification

### Build
```bash
cd mobileApp
npm run build
```

### Runtime checks
- [ ] Multiple AI player interventions don't spam the API simultaneously
- [ ] Utility LLM calls (inventory, profile, importance) queue behind story calls
- [ ] 429 from API gracefully reduces concurrency without crashing
- [ ] Auto-backup fires every 10 minutes (check console for `[Auto-Backup]` logs)
- [ ] Switching campaigns clears the old timer and starts a new one
- [ ] No backup timer when no campaign is active

### No regressions
- [ ] Story streaming still works (NOT queued)
- [ ] AI player interventions still inject messages correctly
- [ ] Context recommender still returns NPC recommendations
- [ ] Condenser still works on manual and auto triggers
