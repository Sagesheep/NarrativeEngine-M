# Phase 2 Refactor — Master Index

> **Status:** Ready for execution
> **Principles:** (1) Zero functionality regression, (2) Maintainability-first, (3) No god scripts

## Execution Order

```
Wave 1 ──→ Wave 2 ──→ Wave 3 ──→ Wave 5
  │                      ↑
  └──────→ Wave 4 ───────┘  (independent, can run parallel)
```

| Wave | File | Scope | Est. Changes |
|------|------|-------|-------------|
| **1** | [wave1-type-cleanup.md](wave1-type-cleanup.md) | Replace `EndpointConfig`/`ProviderConfig` with `LLMProvider` across 15 files | 15 files modified |
| **2** | [wave2-llm-unification.md](wave2-llm-unification.md) | Merge `callLLM` into `llmCall`, convert streaming-abusing consumers to non-streaming | 7 files modified |
| **3** | [wave3-orchestrator-decomposition.md](wave3-orchestrator-decomposition.md) | Split 771-line `turnOrchestrator.ts` into 5 focused modules | 1 split → 5 files |
| **4** | [wave4-storage-decomposition.md](wave4-storage-decomposition.md) | Split 496-line `offlineStorage.ts` into 8 domain modules | 1 split → 9 files |
| **5** | [wave5-store-decoupling-deadcode.md](wave5-store-decoupling-deadcode.md) | Remove `useAppStore.getState()` from service layer, delete dead code | 6 files modified |

## Dependency Rules

- **Wave 1** must run first (clean types simplify everything after)
- **Wave 2** requires Wave 1 (uses `LLMProvider` type)
- **Wave 3** requires Waves 1+2 (decomposed files use unified LLM path)
- **Wave 4** requires Wave 1 only (independent of orchestrator changes)
- **Wave 5** requires Wave 3 (targets the extracted service files)

## Per-Wave Verification

Every wave ends with: `tsc -b && vite build` must pass with zero errors.
