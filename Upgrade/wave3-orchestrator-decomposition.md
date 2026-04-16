# Wave 3 — Decompose `turnOrchestrator.ts`

> **Scope:** Split the 771-line god script into 5 focused modules.
> **Risk:** Medium — moving orchestration logic requires careful import wiring.
> **Depends on:** Wave 1 (clean types), Wave 2 (unified LLM path).
> **Verify:** `tsc -b && vite build` + manual smoke test (send a message, verify turn completes)

## Why

`turnOrchestrator.ts` is 771 lines and holds 5 distinct responsibilities: turn lifecycle, AI player actions, context assembly, post-turn housekeeping, and chapter sealing. Each should be its own module.

## Target Structure

```
src/services/
  turnOrchestrator.ts       ← runTurn() entry point + types (~200 lines)
  turnContext.ts            ← gatherContext() (~150 lines)
  turnPostProcess.ts        ← handlePostTurn() + handleSealChapter() (~150 lines)
  aiPlayers.ts              ← handleInterventions() + generateAIPlayerAction() (~200 lines)
  payloadSanitizer.ts       ← sanitizePayloadForApi() (~50 lines)
```

## Tasks

### 3.1 — Extract `payloadSanitizer.ts` (new file)

Create `src/services/payloadSanitizer.ts`:
- Move the `sanitizePayloadForApi` function (currently lines 68-116 of turnOrchestrator.ts)
- No imports needed (pure function operating on arrays of objects)

In `turnOrchestrator.ts`:
- Add: `import { sanitizePayloadForApi } from './payloadSanitizer'`
- Delete the function body

### 3.2 — Extract `aiPlayers.ts` (new file)

Create `src/services/aiPlayers.ts`:
- Move `handleInterventions()` and `generateAIPlayerAction()`
- After Wave 2, `generateAIPlayerAction` should already use `llmCall` — verify it's using the unified path
- Imports needed: `LLMProvider`, `ChatMessage`, `NPCEntry`, `LoreChunk`, `GameContext`, `uid`, `llmCall`, `TurnCallbacks`, `TurnState` types
- Export both functions

In `turnOrchestrator.ts`:
- Add: `import { handleInterventions } from './aiPlayers'`
- Delete both function bodies

### 3.3 — Extract `turnContext.ts` (new file)

Create `src/services/turnContext.ts`:
- Move the `GatheredContext` type and `gatherContext()` function
- **Critical:** This function currently reads `useAppStore.getState()` in several places. For now, move them as-is — Wave 5 will clean them up. Add a comment `// TODO: Wave 5 — replace with parameter` on each violation.
- Imports needed: all the lore/archive/memory/vector imports currently in gatherContext
- Export both the type and function

In `turnOrchestrator.ts`:
- Add: `import { gatherContext, type GatheredContext } from './turnContext'`
- Delete the type and function body

### 3.4 — Extract `turnPostProcess.ts` (new file)

Create `src/services/turnPostProcess.ts`:
- Move `handlePostTurn()` and `handleSealChapter()`
- **Critical:** Both read `useAppStore.getState()`. Same approach — move as-is, add TODO comments for Wave 5.
- Imports needed: `api`, `extractNPCNames`, `classifyNPCNames`, `validateNPCCandidates`, `generateNPCProfile`, `updateExistingNPCs`, `fetchFacts`, `shouldAutoSeal`, `sealChapter`, `generateChapterSummary`, `loadChapters`, `backgroundQueue`, `scanCharacterProfile`, `scanInventory`, `toast`
- Export both functions

In `turnOrchestrator.ts`:
- Add: `import { handlePostTurn } from './turnPostProcess'`
- Delete both function bodies

### 3.5 — Fix dead code in `turnOrchestrator.ts`

While `runTurn()` stays in the orchestrator, clean up:
1. **Line 148** — Delete the duplicate `callbacks.setLoadingStatus?.('[1/5] Extracting Lore & Stats...')`
2. Verify all remaining code in `runTurn()` is essential — remove any commented-out dead code

### 3.6 — Verify the barrel file `chatEngine.ts`

`src/services/chatEngine.ts` re-exports from various modules. Confirm it still works — it doesn't import from `turnOrchestrator`, so it should be unaffected. No changes needed unless you spot issues.

## Verification

```powershell
npx tsc -b && npx vite build
```

Then confirm:
- `turnOrchestrator.ts` is under 250 lines
- Each new file is under 200 lines
- `ChatArea.tsx` still imports `{ runTurn }` from `../services/turnOrchestrator` and compiles
- No circular import errors
