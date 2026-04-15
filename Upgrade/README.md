# mobileApp Upgrade Plan: Phases 11-14

## Purpose
Feature parity upgrade covering LLM request queue, auto-backup timer, lightweight embeddings, and semantic search.

## Current State (post Phase 1-10)
mobileApp has ~95% feature parity with mainApp. Core gameplay loop is complete. Remaining gaps:

| Area | Status | Gap |
|------|--------|-----|
| LLM Call Management | Missing | No request queue, no 429 handling, no retry logic |
| Auto-Backup | Missing | No periodic backup timer |
| Semantic Search | Missing | No vector embeddings, no semantic candidate retrieval |

## Phase Overview

| Phase | Name | New Files | Modified Files | Est. Lines |
|-------|------|-----------|----------------|------------|
| 11 | LLM Queue + Auto-Backup | 2 | ~6 | ~250 |
| 12 | Embedding Service | 1 | 2 + npm dep | ~120 |
| 13 | Vector Storage + Cosine Search | 1 | 3 | ~200 |
| 14 | Semantic Candidates Integration | 0 | 3 | ~80 |

**Total estimated: ~650 lines of changes across ~12 files**

## For AI Coders
- Execute phases IN ORDER from 11 to 14
- Each phase file is self-contained with exact file paths, code, and insertion points
- After each phase, verify with `npm run build`
- **Graceful degradation is critical** — every new feature falls back cleanly to current behavior on failure

## Key Reference Paths
- mobileApp source: `D:\Games\AI DM Project\Automated_system\mobileApp\src\`
- mainApp source: `D:\Games\AI DM Project\Automated_system\mainApp\src\` (reference for porting)

## Phase Dependencies

```
Phase 11 (LLM Queue + Auto-Backup)  ←── no deps, pure TS
    ↓
Phase 12 (Embedding Service)         ←── new npm dep, lazy model download
    ↓
Phase 13 (Vector Storage + Search)   ←── depends on Phase 12
    ↓
Phase 14 (Semantic Integration)      ←── depends on Phases 12 + 13
```

Phases 11 and 12 can be started in parallel if desired (no code overlap).

## Architecture: Semantic Search on Mobile

mainApp runs embeddings server-side (Node.js native addons, 500MB model, sqlite-vec). mobileApp cannot replicate this — no server runs on the phone, and native C++ addons don't work in a WebView.

**mobileApp approach:**

| Component | mainApp | mobileApp |
|-----------|---------|-----------|
| Embedding model | mxbai-embed-large-v1 (1024-dim, ~500MB) | all-MiniLM-L6-v2 (384-dim, ~25MB) |
| Runtime | Node.js CPU | WebView WebGPU / WASM |
| Vector storage | sqlite-vec (native) | IndexedDB (pure JS) |
| Search algorithm | sqlite-vec KNN | Brute-force cosine similarity |
| Storage size | Unlimited (filesystem) | ~1MB for 500 scenes |

## Critical Rules (carried from Phase 1-10)
1. **DO NOT change mobileApp's persistence layer** — keep idb-keyval + offlineStorage
2. **DO NOT remove mobileApp-only features** — AI Players, MobileNavBar, touch targets, etc.
3. **DO NOT change mobileApp's styling approach** — keep Tailwind
4. **Port mainApp features TO mobileApp patterns** — adapt, don't copy-paste
5. **All new features must degrade gracefully** — if embedding fails, fall back to keyword search
