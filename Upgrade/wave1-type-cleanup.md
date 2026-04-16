# Wave 1 — Type Alias Elimination

> **Scope:** Replace all deprecated `EndpointConfig` / `ProviderConfig` usage with `LLMProvider`.
> **Risk:** Very low — pure type rename, no runtime change.
> **Verify:** `tsc -b && vite build`

## Why

Phase C made `EndpointConfig` and `ProviderConfig` aliases for `LLMProvider`, but 15 files still import and use the old names. The union `EndpointConfig | ProviderConfig` appears 19 times and is just `LLMProvider | LLMProvider` — meaningless noise.

## Tasks

### 1.1 — Update service imports

In each file below, change the import to use `LLMProvider` and replace every occurrence of `EndpointConfig | ProviderConfig` (or reversed) with `LLMProvider`:

- `src/services/turnOrchestrator.ts`
- `src/services/llmService.ts`
- `src/services/callLLM.ts`
- `src/services/condenser.ts`
- `src/services/saveFileEngine.ts`
- `src/services/archiveChapterEngine.ts`
- `src/services/npcGeneration.ts`
- `src/services/npcDetector.ts`
- `src/services/tagGeneration.ts`
- `src/services/contextRecommender.ts`
- `src/services/characterProfileParser.ts`
- `src/services/inventoryParser.ts`

For each file:
1. Change import line from `import type { ..., EndpointConfig, ProviderConfig }` → `import type { ..., LLMProvider }`
2. Replace all `EndpointConfig | ProviderConfig` and `ProviderConfig | EndpointConfig` with `LLMProvider`
3. Replace standalone `EndpointConfig` or `ProviderConfig` parameter types with `LLMProvider`

### 1.2 — Update UI component imports

- `src/components/ChatArea.tsx` — Change `import type { ChatMessage, EndpointConfig, ProviderConfig }` → `import type { ChatMessage, LLMProvider }` and replace the cast on line 87
- `src/components/context-drawer/BookkeepingTab.tsx` — Same pattern, replace casts on lines 24 and 40

### 1.3 — Update settingsSlice

- `src/store/slices/settingsSlice.ts` — The return types on getters like `getActiveStoryEndpoint(): EndpointConfig` should become `getActiveStoryEndpoint(): LLMProvider`. Update import and all 7 getter return types.

### 1.4 — Keep deprecated aliases in types/index.ts

Do NOT delete the aliases — they may be referenced by persisted settings JSON or external tooling. Just leave them as-is with their `@deprecated` JSDoc.

## Verification

```powershell
npx tsc -b && npx vite build
# Then grep to confirm zero remaining:
# grep -r "EndpointConfig | ProviderConfig" src/  → should return nothing
# grep -r "ProviderConfig | EndpointConfig" src/  → should return nothing
```
