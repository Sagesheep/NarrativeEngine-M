# Wave 2 — Unify Non-Streaming LLM Call Path

> **Scope:** Merge `callLLM` retry/queue logic into `llmCall`, convert streaming-abusing consumers.
> **Risk:** Low — same runtime behavior, better queue discipline.
> **Depends on:** Wave 1 (clean types).
> **Verify:** `tsc -b && vite build`

## Why

Three separate ways to call the LLM exist today:
- `llmCall()` — no queue, no retry, simple fetch
- `callLLM()` — queue-aware, 429 retry, duplicated fetch logic
- `sendMessage()` — streaming, no queue

`llmCall` and `callLLM` duplicate the entire fetch+parse pipeline. Meanwhile `npcGeneration`, `npcDetector`, and `tagGeneration` use the full streaming `sendMessage()` for simple JSON tasks, bypassing the rate-limit queue entirely.

## Tasks

### 2.1 — Merge retry + queue logic into `llmCall.ts`

Edit `src/utils/llmCall.ts`:

1. Add imports: `import { llmQueue, type LLMCallPriority } from '../services/llmRequestQueue'`
2. Add optional params to the `opts` bag: `temperature?: number`, `priority?: LLMCallPriority`
3. Wrap the fetch call with `llmQueue.acquireSlot()` / `llmQueue.releaseSlot()` (release in both success and error paths)
4. Add 429 retry loop (3 retries, respect `Retry-After` header, fallback 300ms delay)
5. If `temperature` is provided, add `body.temperature = temperature`

The function signature becomes:
```ts
export async function llmCall(
    provider: LLMProvider,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
    }
): Promise<string>
```

Reference the retry logic from `src/services/callLLM.ts` lines 32-78 — but integrate it into `llmCall`'s structure.

### 2.2 — Convert `callLLM.ts` to a re-export

Replace the entire body of `src/services/callLLM.ts` with:

```ts
export { llmCall as callLLM } from '../utils/llmCall';
export type { LLMCallPriority } from './llmRequestQueue';
```

This preserves all `import { callLLM } from './callLLM'` consumers with zero changes.

### 2.3 — Convert `npcGeneration.ts` to use `llmCall`

Edit `src/services/npcGeneration.ts`:

1. Remove imports: `sendMessage`, `OpenAIMessage` (from `./llmService` / `./chatEngine`)
2. Add import: `import { llmCall } from '../utils/llmCall'`
3. In `generateNPCProfile()`: Build the prompt as a single string (combine system + user into one prompt). Replace the `sendMessage()` call with `const fullJsonStr = await llmCall(provider, fullPrompt, { priority: 'low' })`
4. In `updateExistingNPCs()`: Same pattern — build prompt string, call `llmCall()`

### 2.4 — Convert `npcDetector.ts` to use `llmCall`

Edit `src/services/npcDetector.ts`:

1. Remove imports: `sendMessage`, `extractJson` (from `./chatEngine` / `./payloadBuilder`)
2. Add imports: `import { llmCall } from '../utils/llmCall'`, `import { extractJson } from './payloadBuilder'`
3. In `validateNPCCandidates()`: Replace the `sendMessage()` + Promise wrapper (lines 107-116) with:
   ```ts
   const raw = await llmCall(provider, prompt, { priority: 'normal', maxTokens: 500 });
   ```
   Then parse `raw` the same way.

### 2.5 — Convert `tagGeneration.ts` to use `llmCall`

Edit `src/services/tagGeneration.ts`:

1. Remove imports: `sendMessage`, `OpenAIMessage` (from `./llmService`)
2. Add import: `import { llmCall } from '../utils/llmCall'`
3. In `populateEngineTags()`: Replace the `sendMessage()` call with `const fullJsonStr = await llmCall(provider, prompt, { priority: 'low' })`

### 2.6 — Convert AI Player action in `turnOrchestrator.ts` to use `llmCall`

In `generateAIPlayerAction()` (around line 496-510):

1. Remove the manual `llmQueue.acquireSlot` / `llmQueue.releaseSlot` wrapping
2. Replace the `sendMessage()` call with:
   ```ts
   const resultText = await llmCall(endpoint, finalPayload.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n'), {
       signal: abortController.signal,
       priority: 'normal',
   });
   ```
   Actually — since this uses a structured message array, build a combined prompt from the message array and call `llmCall`.

## Verification

```powershell
npx tsc -b && npx vite build
```

Confirm:
- `callLLM.ts` is only 2 lines (re-export)
- `npcGeneration.ts`, `npcDetector.ts`, `tagGeneration.ts` no longer import `sendMessage`
- `llmCall.ts` contains the retry logic and queue wrapping
- No other file in `src/services/` does raw `fetch` for non-streaming LLM calls
