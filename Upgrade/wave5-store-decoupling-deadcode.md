# Wave 5 — Store Decoupling + Dead Code Cleanup

> **Scope:** Remove `useAppStore.getState()` from service layer, clean dead code.
> **Risk:** Low — data still comes from the same store, just passed explicitly.
> **Depends on:** Wave 3 (files already extracted).
> **Verify:** `tsc -b && vite build` + grep audit

## Why

The service layer (especially `turnContext.ts` and `turnPostProcess.ts` extracted in Wave 3) still reaches into `useAppStore.getState()` directly. This defeats the dependency injection pattern that `TurnState`/`TurnCallbacks` established and makes the services harder to test in isolation.

## Tasks

### 5.1 — Add `timeline` to `TurnState`

Edit `src/services/turnOrchestrator.ts`:

Add to the `TurnState` type:
```ts
timeline: TimelineEvent[];
```

Import `TimelineEvent` from types.

Edit `src/components/ChatArea.tsx`:

In the `handleSend()` function, add to the TurnState object:
```ts
timeline: useAppStore.getState().timeline,
```

### 5.2 — Remove store coupling from `turnContext.ts`

Edit `src/services/turnContext.ts`:

**Violation 1 — timeline access** (~line 618 in original):
```ts
// BEFORE
const timeline = useAppStore.getState().timeline;
// AFTER
const timeline = state.timeline;
```
Remove `useAppStore` import if no other references remain.

**Violation 2 — context access** (~line 644 in original):
```ts
// BEFORE
useAppStore.getState().context, freshMessages, finalInput, ...
// AFTER
state.context, freshMessages, finalInput, ...
```
(This should already be `state.context` if extracted correctly — verify.)

### 5.3 — Remove store coupling from `turnPostProcess.ts`

Edit `src/services/turnPostProcess.ts`:

**Violation 1 — handleSealChapter reads chapters and context** (~lines 727-728 in original):
```ts
// BEFORE
const currentChapters = useAppStore.getState().chapters;
const headerIndex = useAppStore.getState().context.headerIndex;
```

Change `handleSealChapter` signature to accept these explicitly:
```ts
async function handleSealChapter(
    state: TurnState,
    callbacks: TurnCallbacks,
    activeCampaignId: string,
    chapters: ArchiveChapter[],
    headerIndex: string
)
```

Update the call site in `handlePostTurn()` to pass `state`'s data.

**Violation 2 — handlePostTurn reads context** (~lines 714, 719 in original):
```ts
// BEFORE
useAppStore.getState().context.characterProfile
useAppStore.getState().context.inventory
// AFTER
state.context.characterProfile
state.context.inventory
```

### 5.4 — Verify no store imports remain

After 5.2 and 5.3, grep the extracted service files:
```powershell
# These should return zero results:
rg "useAppStore" src/services/turnContext.ts
rg "useAppStore" src/services/turnPostProcess.ts
rg "useAppStore" src/services/aiPlayers.ts
rg "useAppStore" src/services/payloadSanitizer.ts
```

If `useAppStore` is only imported in `turnOrchestrator.ts` (the entry point that receives state from the UI), that's acceptable. But check if `turnOrchestrator.ts` still needs it after delegation — it shouldn't.

### 5.5 — Clean dead code in `ChatArea.tsx`

Edit `src/components/ChatArea.tsx`:

Delete lines 187-189 (the empty `if` block with just a comment):
```ts
// DELETE THIS:
if (activeCampaignId) {
    // Chapter auto-sealing is now handled internally by turnOrchestrator
}
```

### 5.6 — Clean dead code in `npcGeneration.ts`

Edit `src/services/npcGeneration.ts`:

Delete the no-op guard block (lines 196-199 in original):
```ts
// DELETE THIS:
if (hasAxisChange) {
    // no-op guard
}
```

### 5.7 — Clean `toolHandlers.ts`

Edit `src/services/toolHandlers.ts`:

1. Remove the `update_scene_notebook` tool definition from `TOOL_DEFINITIONS` (keep only `query_campaign_lore`)
2. Remove `handleNotebookTool` function and `NotebookHandlerResult` type
3. Remove `MAX_NOTEBOOK_OPS`, `MAX_NOTEBOOK_NOTES` constants
4. Keep `TOOL_DEFINITIONS` as a single-element array
5. Update `ToolContext` type — remove `notebook` field (no longer needed)

Then in `turnOrchestrator.ts`, replace the inline tool definition (hardcoded at lines 221-232) with an import from `toolHandlers`:
```ts
import { TOOL_DEFINITIONS } from './toolHandlers';
```
And use `TOOL_DEFINITIONS` in the `executeTurn` function instead of the inline object.

### 5.8 — Remove `ArchiveChunk` type (if safe)

Edit `src/types/index.ts`:

Grep for any usage of `ArchiveChunk` in the codebase. If zero consumers found (expected — it was marked deprecated), delete the type definition (lines 153-161).

## Verification

```powershell
npx tsc -b && npx vite build
```

Final audit:
```powershell
# Service layer should be store-free:
rg "useAppStore" src/services/turnContext.ts src/services/turnPostProcess.ts src/services/aiPlayers.ts src/services/payloadSanitizer.ts
# → zero results

# Deprecated type unions should be gone:
rg "EndpointConfig \| ProviderConfig" src/
# → zero results

# No god scripts over 300 lines:
# Check line counts of key service files
```
