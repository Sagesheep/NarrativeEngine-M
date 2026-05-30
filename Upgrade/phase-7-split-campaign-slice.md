# Phase 7 — Split campaignSlice (HIGH RISK)

**AI Tier: Strong AI** (Opus 4.7 / GPT-5 / GLM-5.1)

> [!IMPORTANT]
> **Reconciled against live code on 2026-05-29 (phases 1–6 complete).** This doc was originally written before phases 1–6 landed and contained several factual errors. Corrections are inline below. The most important: **divergence is NOT "in CampaignDeps instead of state" — it already lives fully in `chatSlice.ts`.** Do NOT create a `divergenceSlice.ts`. The real divergence issue is a *persistence inconsistency* (see below). Verify every claim in this doc against the source before acting; treat the pseudocode as intent, not literal API.

This is the most dangerous phase. `campaignSlice.ts` (468 lines) owns 10+ sub-domains plus the `setActiveCampaign` hydration orchestrator that loads 9 entity types in two parallel batches, with side-effects (background-queue clear, settings save, embedder warmup + lazy re-index, auto-backup interval, NPC dedup). A plausible-looking but subtly wrong refactor can silently break campaign persistence, NPC dedup, or stale-vector re-indexing without failing tsc or existing tests.

**MANDATORY PRECONDITION:** Write characterization tests before touching the slice (Sub-phase 7.0 below).

## Current state

`src/store/slices/campaignSlice.ts` (468 lines):
- NPC ledger (add/update/remove/archive/restore + dedup). **Embedding side-effects are only in `updateNPC` (conditional re-embed) and `removeNPC` (vector delete) — `addNPC`/`addNPCs` do NOT embed.**
- Lore chunks (`updateLoreChunk` saves inline; `setLoreChunks` does not)
- Archive index, chapters, semantic facts
- Timeline + entities
- Game context (`defaultContext`, 40+ sub-fields)
- Pinned chapter IDs
- On-stage NPC tracking
- Bookkeeping turn counter + interval
- Active campaign ID + `setActiveCampaign` mega-hydration (lines 252–346)
- 3 module-level debounced save timers (`stateTimer`, `loreTimer`, `npcTimer`) + 1 `autoBackupTimer` interval
- A `_getStateForSave` registered-getter indirection: `debouncedSaveCampaignState` pulls fresh state from a getter registered via `_registerCampaignStateGetter`. **Any persistence refactor MUST preserve this fresh-state pull, or debounced saves will persist stale snapshots.**

> **CORRECTION — divergence register.** The original doc claimed the divergence register was "BROKEN: in CampaignDeps, not in slice state." **This is false.** `divergenceRegister` and all ~18 of its actions live in `chatSlice.ts` (state-owning). campaignSlice only references it in its `CampaignDeps` cross-slice type so `setActiveCampaign` can write it during hydration — that is deliberate, not a bug.
>
> **The real divergence issue (fix during this phase):** the divergence *mutation* actions in `chatSlice.ts` (`toggleDivergenceFact`, `pinDivergenceFact`, `deleteDivergenceFact`, etc.) call `debouncedSaveCampaignState`, which writes `state_${id} = {context, messages, condenser, pinnedExcerpts}` — a payload that does **not** include `divergenceRegister`. The register is only persisted to `divergence_${id}` by `saveDivergenceRegister`, which is called explicitly from the turn path ([ChatArea.tsx:204](../src/components/ChatArea.tsx)) and Header — NOT from the UI-edit actions. So manual MemoryTab divergence edits likely do not survive reload. Route divergence persistence through `saveDivergenceRegister` consistently.

## Sub-phase 7.0 — Characterization tests (MUST DO FIRST)

Add tests in `src/store/slices/__tests__/`:

1. **Hydration test:** Mock storage with a known campaign (NPCs, lore, archive, divergence). Call `setActiveCampaign(id)`. Assert all 9 entity types end up in store state with correct values.

2. **NPC lifecycle test:** addNPC → updateNPC → archiveNPC → restoreNPC → removeNPC. Assert embedding storage is called on add/update/remove, dedup runs on add, debounced save fires.

3. **Persistence test:** Mutate context, lore, NPC ledger. Wait for debounce. Assert storage was called with correct shape for each.

4. **Divergence register test:** setDivergenceRegister → toggleDivergenceFact → pinDivergenceFact → verify persistence. **Note:** these actions live in `chatSlice.ts`, not campaignSlice. Assert the register is written to `divergence_${id}` via `saveDivergenceRegister` — this currently FAILS for UI-edit actions (they only call `debouncedSaveCampaignState`). Write the test to pin the *correct* behavior; expect to fix the persistence path to make it pass.

5. **Active campaign switch test:** Load campaign A, mutate state, switch to campaign B. Assert campaign A state was saved and campaign B state was loaded.

These tests pin the current behavior. They must pass BEFORE and AFTER the split, with identical assertions.

## Target structure

```
src/store/slices/
  npcSlice.ts                ← npcLedger, onStageNpcIds + actions + dedup
  loreSlice.ts               ← loreChunks + actions
  archiveSlice.ts            ← archiveIndex, chapters, semanticFacts, timeline, entities, pinnedChapterIds
  campaignSlice.ts (trimmed) ← activeCampaignId, context, bookkeeping counter/interval + setActiveCampaign orchestrator
  chatSlice.ts (UNCHANGED)   ← already owns messages, condenser, divergenceRegister, pinnedExcerpts, loreCheck
src/store/
  persistence.ts             ← makeDebouncedSave() helper, consolidates the 3 module-level timers
  campaignHydration.ts       ← parallel load logic extracted from setActiveCampaign
src/components/hooks/
  useNPCSideEffects.ts       ← embedding reconcile on update/remove (out of slice). NOTE: existing hooks live in src/components/hooks/ (useMessageEditor, useCondenser), NOT src/hooks/ — follow that location.
```

> **CORRECTION:** No `divergenceSlice.ts`. Divergence already lives in `chatSlice.ts` and stays there. This phase splits `campaignSlice` only.

## Slice composition

The store stays unified via `useAppStore` composition. The CURRENT composition (post-phase-5/6) is 4 slices; this phase adds 3 (npc/lore/archive). Note the actual call signature passes `(set, get, store)` and spreads named locals:

```ts
// src/store/useAppStore.ts (current shape — extend, don't rewrite from scratch)
export const useAppStore = create<AppState>()((set, get, store) => {
  const settingsSlice = createSettingsSlice(set, get, store);
  const uiSlice       = createUISlice(set, get, store);
  const campaignSlice = createCampaignSlice(set, get, store); // trimmed
  const npcSlice      = createNPCSlice(set, get, store);      // NEW
  const loreSlice     = createLoreSlice(set, get, store);     // NEW
  const archiveSlice  = createArchiveSlice(set, get, store);  // NEW
  const chatSlice     = createChatSlice(set, get, store);     // unchanged (owns divergence)
  return { ...settingsSlice, ...uiSlice, ...campaignSlice, ...npcSlice, ...loreSlice, ...archiveSlice, ...chatSlice };
});
```

Each new slice will need its own cross-slice `Deps` type (mirroring the existing `CampaignDeps` / `ChatDeps` pattern) for any field it reads from a sibling slice (e.g. npcSlice reads `activeCampaignId`).

## Critical: `setActiveCampaign` decomposition

**Map the ACTUAL current behavior (campaignSlice.ts:252–346), in order:**
1. Dynamic-import `backgroundQueue` and call `.clear('Campaign switched')` (fire-and-forget).
2. Clear the existing `autoBackupTimer` interval if set.
3. `debouncedSaveSettings(get().settings, id)` — saves SETTINGS, scoped to the new id.
4. **Null-id early return:** if `!id`, `set({ activeCampaignId: null })` and return. Do not drop this branch.
5. Dynamic-import the loaders from `campaignStore`, then **two** `Promise.all` batches: batch 1 = `loadCampaignState, getLoreChunks, getNPCLedger, loadArchiveIndex, loadDivergenceRegister`; batch 2 = `loadChapters, loadSemanticFacts, loadTimeline, loadEntities`, each with `.catch(() => [])` fallback. Preserve the fallbacks — batch 2 hits the API and can fail offline.
6. One `set()` committing `activeCampaignId, context (defaultContext merged with loaded), messages, condenser, loreChunks, npcLedger, archiveIndex, divergenceRegister, chapters, semanticFacts, timeline, entities` — note this writes **chat-slice fields** (`messages`, `condenser`, `divergenceRegister`) cross-slice.
7. Dynamic-import embedding: `warmupEmbedder()`, then `hasStaleVectors(id, modelId)`; if stale, drive `setEmbeddingsReindexing` (a **uiSlice** action) through a `runFullReindex` progress loop.
8. Assign `autoBackupTimer = setInterval(... backup.create ..., 10*60*1000)`.

Target: extract loading to `campaignHydration.ts`. The interface MUST include the chat-slice fields that hydration commits:

```ts
// src/store/campaignHydration.ts
export interface HydratedCampaign {
  context: GameContext;          // defaultContext merged with loaded state.context
  messages: ChatMessage[];
  condenser: CondenserState;
  loreChunks: LoreChunk[];
  npcLedger: NPCEntry[];
  archiveIndex: ArchiveIndexEntry[];
  divergenceRegister: DivergenceRegister;
  chapters: ArchiveChapter[];
  semanticFacts: SemanticFact[];
  timeline: TimelineEvent[];
  entities: EntityEntry[];
}

export async function hydrateCampaign(campaignId: string): Promise<HydratedCampaign> {
  // preserve the two-batch split and the batch-2 .catch(() => []) fallbacks
}
```

> **CORRECTION:** there is currently **no `flushPendingSaves`** before switching. The current code only calls `debouncedSaveSettings` — it does NOT flush the pending debounced campaign-state / lore / NPC save timers, so a fast campaign switch can drop an in-flight save. Adding `flushPendingSaves(get())` is a genuine improvement (not a like-for-like extraction); call it out explicitly in the PR as a behavior change, and add a characterization test (7.0 #5) that exercises switch-with-pending-save.

Side-effects (embedder warmup/re-index, the auto-backup interval) should live in separate modules, not inline in the slice — but they are dynamic-import + interval driven today, so preserve the dynamic imports and the 10-minute interval semantics exactly.

## Critical: NPC embedding side-effects

> **CORRECTION:** the original claim that "`addNPC`, `updateNPC`, `removeNPC` directly call `embeddingStorage`" is wrong. The ACTUAL coupling is narrower:
> - `addNPC` / `addNPCs`: dedup + `debouncedSaveNPCLedger` only. **No embedding.**
> - `updateNPC`: re-embeds ONLY if the patch touches a field in `NPC_EMBED_FIELDS` — via `embedText(buildNPCEmbeddingText(...))` then `embeddingStorage.store(cId, id, vec, 'npc', getCurrentModelId())`. Note the conditional and the model-id arg.
> - `removeNPC`: `embeddingStorage.deleteByTypeAndId(campaignId, 'npc', id)`.
> - `archiveNPC` / `restoreNPC`: save only, no embedding.
>
> There is **no** `embeddingStorage.upsertNPC` / `deleteNPC` / `diffNPCLedgers` API — the pseudocode below invented those names. A reconcile hook must use the real methods (`store` with `embedText`+`getCurrentModelId`, and `deleteByTypeAndId`) and must replicate the `NPC_EMBED_FIELDS` gate, or it will over-embed on every unrelated field change.

If you extract a reconcile hook, mount it once (e.g. App.tsx), diff prev vs current ledger, and for changed embed-relevant NPCs call `embedText`→`embeddingStorage.store`, and for removed ids call `deleteByTypeAndId`.

**TRADEOFF:** This decouples but introduces eventual consistency. Given the coupling is already small (only `updateNPC`/`removeNPC`, and `updateNPC` is field-gated), the simpler and lower-risk option is to **leave these two calls in the slice** and accept the slice still has side-effects. Recommend the in-slice option unless test ergonomics demand otherwise — the hook adds a diffing layer for little gain here.

## Persistence consolidation

`src/store/persistence.ts`:

```ts
type Getter<T> = () => T;
type Saver<T> = (campaignId: string, value: T) => Promise<void>;

export function makeDebouncedSave<T>(
  saver: Saver<T>,
  getValue: Getter<{ campaignId: string | null; value: T }>,
  delayMs: number
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const { campaignId, value } = getValue();
      if (campaignId) await saver(campaignId, value);
    }, delayMs);
  };
}
```

Then each slice creates its own debounced save using this helper. Adds also: `flushPendingSaves(state)` for the campaign switch path.

## Verification

- [ ] **Phase 7.0 characterization tests pass BEFORE any refactor**
- [ ] **Same tests pass AFTER refactor with no assertion changes**
- [ ] `tsc --noEmit` exits 0
- [ ] `npm test` all green
- [ ] Manual: load campaign A → mutate state (add NPC, edit lore, update context) → switch to campaign B → switch back to A → all mutations preserved
- [ ] Manual: add NPC → verify embedding storage gets it (check embedding storage size)
- [ ] Manual: delete NPC → verify embedding storage loses it
- [ ] Manual: send a turn → divergence register updates → reload app → divergences persist
- [ ] Manual: trigger backup → backup file appears on disk

## Notes for the executing model

- DO NOT skip the characterization tests. They are the only thing standing between you and silent regression.
- The `setActiveCampaign` function (lines 252–346) does real work on every line. Map every line to its new home before deleting anything — see the 8-step inventory above.
- If you find a side-effect in the slice you can't explain (e.g. a Date check, a counter reset, the `AI_PLAYER_CONTEXT_KEYS` stripping in `loadCampaignState`), grep its history. There's usually a bug it was fixing. Don't drop it.
- **The "divergenceRegister-in-CampaignDeps bug" described in the original doc is NOT real** — divergence is correctly in `chatSlice`. The real fix is the *persistence inconsistency* (UI-edit divergence actions don't write `divergence_${id}`). Document that fix in the PR description. Do NOT create a divergenceSlice.
- Ship this as ONE PR, not sub-PRs. The slices reference each other during hydration, so a half-applied split breaks the app.
- Tag the pre-merge commit as `pre-phase-7-baseline` for easy revert.
- Required human reviewers: anyone who has previously edited campaignSlice.

## Rollback plan

If regressions appear post-merge:
1. Revert to `pre-phase-7-baseline`
2. Restore from any backup the user might have made
3. Re-attempt with smaller scope (e.g. extract only `divergenceSlice` first, leave the rest)
