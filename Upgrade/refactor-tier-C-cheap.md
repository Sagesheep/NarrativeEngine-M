# Refactor Tier C — Safe (GLM 5.1 / Haiku)

> **Run on: GLM 5.1 or Haiku.** Pure type / dead-code / mechanical changes. The tests (#25-27) touch no production code — ideal cheap-model work — but assertions MUST be verified and written against CURRENT behavior. Do the tests FIRST; Tier A depends on them.

## Tests (do these first)

### C-T1 — Tests for `parseCombinedSealOutput` / `parseChapterSummaryOutput` (#25) — HIGH
- **New file:** `src/services/__tests__/saveFileEngine.test.ts`
- Cover: valid JSON; markdown-fenced JSON; split-object `}{` recovery; missing required fields; unrecognized NPC names → `reviewFlag`; `stripReasoning` tag variants.

### C-T2 — Tests for `dedupeNPCLedger` (#26) — MEDIUM
- **File:** `src/store/slices/campaignSlice.ts:81-128`
- Cover: exact match (newer survives); first-name subset (shorter removed); same first / different last (both kept); case insensitivity; three-way collision.

### C-T3 — Test for `truncateScenesToBudget` (#27) — LOW
- **File:** `src/services/saveFileEngine.ts:21-38`
- Cover: drop-from-middle slice math on a known 5-scene array (watch off-by-one for small arrays).

## Type-safety items

### C1 — Remove `(settings as any)` cast (#9)
- `src/services/payloadBuilder.ts:127-128` — `AppSettings` already types `presets` and `activePresetId`. Replace with: `const activePreset = settings.presets.find(p => p.id === settings.activePresetId); const modelName = activePreset?.storyAI?.modelName ?? '';`

### C2 — Type `recalledByEmbedding` (#10)
- Add `recalledByEmbedding?: boolean` to `NPCEntry` in `src/types/index.ts`, OR track recalled IDs in a local `Set<string>`. Removes the `(npc as any)` mutation at `src/services/payloadBuilder.ts:309`.

### C3 — Delete re-declared `CombinedSealResult` (#11)
- `src/services/turnPostProcess.ts:21-26` re-declares a type already exported by `src/services/saveFileEngine.ts:269-274`. Delete it; add `import type { CombinedSealResult } from './saveFileEngine';`.

### C4 — Type `divergenceRegister` in slice (#12)
- `src/components/CampaignHub.tsx:214` sets it via raw `setState` but it is untyped. Add `divergenceRegister: DivergenceRegister; setDivergenceRegister: (reg: DivergenceRegister) => void;` to the campaign slice, initialized with `EMPTY_REGISTER`.

### C5 — Type NPC `changes` as `Partial<NPCEntry>` (#13)
- `src/services/npcGeneration.ts:292-301` — declare `changes` as `Partial<NPCEntry>` instead of casting `Record<string, unknown>`.

## Dead code

### C6 — Remove `@deprecated` aliases (#14)
- `src/types/index.ts:46-49` — `EndpointConfig`, `ProviderConfig` are aliases for `LLMProvider`. Grep for remaining imports, migrate to `LLMProvider`, delete the aliases.

### C7 — Vestigial `GameContext` fields (#15)
- `src/types/index.ts:154-158` — `canonState`, `canonStateActive`, `headerIndex`, `headerIndexActive` are unused and absent from `defaultContext`. Document with a `// TODO` or remove if dead.

## Duplication / mechanical

### C8 — Consolidate `buildNPCEmbeddingText` (#3)
- `src/store/slices/campaignSlice.ts:10-22` has a private `npcEmbedText` identical to `buildNPCEmbeddingText` in `src/services/npcGeneration.ts:54-67`. Delete the private copy; import the shared one (or move it to `src/utils/npcUtils.ts`). Confirm field lists are identical first.

### C9 — Extract `ProviderSection` type (#20)
- `src/components/SettingsModal.tsx` (lines 34, 76, 82, 97, 115) inlines `'storyAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI'` 4×. Extract `type ProviderSection = keyof Pick<AIPreset, 'storyAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI'>;` at the top of the file.

### C10 — `NPCEditForm` divergence prop (#21)
- `src/components/npc-ledger/NPCEditForm.tsx:23` has a lone `useAppStore` call in an otherwise prop-controlled form. Add a `divergenceEntries?: DivergenceEntry[]` prop; compute it in the parent `NPCLedgerModal`.

### C11 — `useMemo` for `visibleMessages` (#23)
- `src/components/ChatArea.tsx:261` re-runs `messages.filter(...).slice(...)` every render (every streaming token). Wrap: `const visibleMessages = useMemo(() => messages.filter(msg => msg.role !== 'tool').slice(-visibleCount), [messages, visibleCount]);`

## Verification (all Tier C)
- `npm run lint` and `npx tsc --noEmit` clean.
- `npm test` — all existing 18 test files plus the 3 new test files pass.
