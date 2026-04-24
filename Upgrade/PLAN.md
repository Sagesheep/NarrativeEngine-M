# MobileApp Feature Parity Upgrade Plan

## Overview
This plan closes the feature gaps between `mainApp` and `mobileApp`, bringing over functionality that's missing without the server-side or desktop-specific features (Electron, filesystem access, server-side embedding/NLP).

**Already at parity (no action needed):**
- Message editing (exists inline in ChatArea.tsx, just not extracted to a hook)
- Auto-condenser (exists inline in ChatArea.tsx)
- CondensedPanel (exists as inline panel in ChatArea.tsx)
- Archive rollback/clear (ChatArea.tsx already has `rollbackArchiveFrom` and `handleClearArchive`)

---

## Phase 1: Pure Data Utilities (Zero UI changes) ✅ DONE

### 1A: Entity Fuzzy Matching ✅
- Created `src/utils/entityResolution.ts` — Levenshtein + normalizeEntityName
- Added `resolve()` method to `entityStorage.ts`
- Pure TypeScript, zero dependencies

### 1B: Importance Rating (LLM-based) ✅
- Created `src/services/importanceRater.ts` — LLM 1-10 scale + heuristic fallback
- Replaced local `estimateImportance()` in `archiveIndexer.ts` with shared `heuristicImportance()`
- Background-queued LLM re-rating in `turnPostProcess.ts` after each turn
- Added `updateIndex()` method to `archiveStorage.ts`

### 1C: Sampling Profiles ✅
- Added `SamplingConfig` type to `types/index.ts`
- Added `sampling?: SamplingConfig` field to `AIPreset`
- Created `src/utils/samplingProfiles.ts` — 8 presets + 10 field definitions
- Updated `llmApiHelper.ts` buildChatBody to accept and apply sampling params
- Updated `llmService.ts` sendMessage to accept optional `sampling` param
- Updated `turnOrchestrator.ts` to read active preset's sampling and pass through
- No migration needed — `sampling` is optional on AIPreset

---

## Phase 2: Pipeline Phase Tracking & UI ✅ DONE

### 2A: Add PipelinePhase & StreamingStats Types ✅
- Added `PipelinePhase` and `StreamingStats` types to `types/index.ts`

### 2B: Add Phase State to UI Slice ✅
- Added `pipelinePhase`, `streamingStats`, `setPipelinePhase`, `setStreamingStats` to `uiSlice.ts`

### 2C: Emit Phase Transitions in Turn Orchestrator ✅
- Added phase transitions in `turnOrchestrator.ts`:
  - `rolling-dice` → `ai-intervention` → `gathering-context` → `building-prompt` → `generating`
  - `checking-notes` when lore tool call happens
  - `post-processing` after LLM response
  - `idle` on completion or error
- Added `setPipelinePhase` and `setStreamingStats` to `TurnCallbacks`
- Streaming stats computed via interval in ChatArea (same pattern as mainApp)

### 2D: GenerationProgress Component ✅
- Created `src/components/GenerationProgress.tsx` — mobile-adapted pipeline stepper
- Wired into `ChatArea.tsx` above input bar
- Shows dots + labels for current phase, streaming stats (tok/s, elapsed)
- Mobile styling: `text-[8px]`, compact gaps, hidden labels for inactive phases

---

## Phase 3: Settings Modal — Sampling UI ✅ DONE

### 3A: SamplingPanel Component ✅
- Created `src/components/SamplingPanel.tsx` — mobile-adapted sampling editor
- Collapsible section with temperature badge when collapsed
- Quick-select dropdown for 8 preset profiles (Default, DeepSeek, Gemma, GLM, Kimi, Creative, Deterministic)
- Vertical stacked slider rows with label + number input above, range slider below
- Collapsible "Local Inference Params" section (top_k, min_p, repetition_penalty, DRY params)
- Touch-friendly: `min-h-[48px]` buttons/selects, `min-h-[44px]` number inputs
- "Reset to Defaults" button
- Wired into `SettingsModal.tsx` after provider configs, calls `updatePreset(id, { sampling })`
- **Effort:** ~2 hours
- **Impact:** Users can select model-specific sampling profiles and fine-tune parameters per endpoint

---

## Phase 4: Polish & Extraction ✅ DONE

### 4A: Extract useMessageEditor Hook ✅
- Created `src/components/hooks/useMessageEditor.ts`
- Extracted: `editingMessageId`, `startEditing`, `cancelEditing`, `handleEditSubmit`, `handleRegenerate`, `rollbackArchiveFrom`
- Accepts deps object with `messages`, `input`, `setInput`, `inputRef`, `resetTextareaHeight`, `activeCampaignId`, `archiveIndex`, `setArchiveIndex`, `setChapters`, `deleteMessagesFrom`, `onAfterEdit`, `onAfterRegenerate`
- `ChatArea.tsx` reduced by ~80 lines, edit banner uses `cancelEditing` instead of inline lambda

### 4B: Extract useCondenser Hook ✅
- Created `src/components/hooks/useCondenser.ts`
- Extracted: `triggerCondense`, `condenseAbortRef`, `editingSummary`, `setEditingSummary`, `summaryDraft`, `setSummaryDraft`, `handleRetcon`
- Accepts deps object with all condenser-related store actions and state
- `ChatArea.tsx` reduced by ~90 lines, no more inline condenser logic
- Removed unused `condenseHistory` and `runSaveFilePipeline` imports from ChatArea

---

## Execution Order & Dependencies

```
Phase 1A (entity resolution) ─── no deps, can start immediately
Phase 1B (importance rater)  ─── needs callLLM (already exists)
Phase 1C (sampling profiles) ─── needs type additions first

Phase 2A-2B (types + UI slice) ─── prerequisite for 2C-2D
Phase 2C (orchestrator phases) ─── needs 2A-2B
Phase 2D (GenerationProgress) ─── needs 2A-2C

Phase 3A (SamplingPanel)     ─── needs Phase 1C (SamplingConfig type)

Phase 4A-4B (hooks extraction) ─── independent, anytime
```

## Estimated Total Effort

| Phase | Time |
|-------|------|
| Phase 1 (A+B+C) | ~1.5 hours |
| Phase 2 (A+B+C+D) | ~2 hours |
| Phase 3 (A) | ~2 hours |
| Phase 4 (A+B) | ~1 hour |
| **Total** | **~6.5 hours** |

## Files to Create (New)

1. `src/utils/entityResolution.ts` — Levenshtein + entity normalization
2. `src/services/importanceRater.ts` — LLM-based importance scoring
3. `src/utils/samplingProfiles.ts` — Preset sampling configs
4. `src/components/GenerationProgress.tsx` — Pipeline phase progress bar
5. `src/components/SamplingPanel.tsx` — Sampling parameter editor
6. `src/components/hooks/useMessageEditor.ts` — (Phase 4)
7. `src/components/hooks/useCondenser.ts` — (Phase 4)

## Files to Modify (Existing)

1. `src/types/index.ts` — Add `SamplingConfig`, `PipelinePhase`, `StreamingStats`
2. `src/store/slices/uiSlice.ts` — Add `pipelinePhase`, `streamingStats` state
3. `src/services/turnOrchestrator.ts` — Emit phase transitions + streaming stats
4. `src/services/turnPostProcess.ts` — Call `rateImportance()`
5. `src/services/archiveIndexer.ts` — Import from `importanceRater` instead of local heuristic
6. `src/services/storage/entityStorage.ts` — Use `normalizeEntityName` on merge
7. `src/store/slices/settingsSlice.ts` — Handle `sampling` field on presets, migration
8. `src/components/ChatArea.tsx` — Wire `GenerationProgress`, (optional) extract hooks
9. `src/components/SettingsModal.tsx` — Wire `SamplingPanel`
10. `src/types/index.ts` — Add `sampling` to `AIPreset`