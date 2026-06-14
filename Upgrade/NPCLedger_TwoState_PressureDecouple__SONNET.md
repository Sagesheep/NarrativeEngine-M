# NPC Ledger: Two-State + Pressure Decouple — Implementation Spec (Sonnet)

## Goal (one sentence)
Make the NPC ledger a **pure content layer** (an NPC is either *present* or *deleted* — no third "archived" state) and move the **pressure tracking** off the NPC record into its own store layer that references NPCs by id but never affects how content is stored or viewed.

## Why (context — already decided with the user, do not relitigate)
- `pressure` currently lives **on** each `NPCEntry`. Every turn the tracker patches it, which **rewrites the entire ledger** via the debounced save (`debouncedSaveNPCLedger`). Telemetry churning the content store is the smell we're removing.
- `archived` was a recent band-aid that turned the ledger into a 100+ entry "graveyard." The real garbage source (a signal-less name-detection pass) has **already been fixed** in this codebase, so archive's anti-clutter job is obsolete. Two states is enough, like any DB row.
- Principle: **content layer** (NPCEntry) vs **observer layer** (pressure). The observer reads the roster by id; it must not reorder, hide, or fade anything in the ledger UI.

## Hard constraints / gotchas (READ FIRST)
1. **Run `npm run build` (tsc -b), not just `npx vitest`.** tsc -b is stricter and has caught build-breaks that tests miss. The project has `noUnusedLocals` — deleting a consumer can leave a dead import/const that fails the build.
2. **Do NOT make `validateNPCCandidates` fail-closed.** It intentionally fails open; leave it.
3. **embeddingStorage.store() invariant:** every call must pass `getCurrentModelId()` (see existing `updateNPC` in npcSlice.ts). Don't drop it.
4. Pressure must **persist** in its own per-campaign idb-keyval slot (e.g. key `npc_pressure_${campaignId}`), mirroring `npcs_${campaignId}`. The intro engine + troublemaker read pressure across sessions, so it can't be ephemeral.
5. Migration must be **lossless for content**: existing archived NPCs become plain present NPCs (un-archived), and any `npc.pressure` is lifted into the new store before the field is stripped.

---

## PART A — Decouple pressure into its own slice

### A1. Types (`src/types/index.ts`)
- Keep `NPCPressure` and `NPCPressureHistory` (lines ~388–400).
- **Remove from `NPCEntry`** (lines ~420, ~424–426): `pressure?`, `archived?`, `archivedAtTurn?`, `archivedReason?`.

### A2. New slice `src/store/slices/pressureSlice.ts`
Shape:
```ts
type PressureSlice = {
  npcPressure: Record<string, NPCPressure>;   // keyed by npc id
  setNpcPressure: (map: Record<string, NPCPressure>) => void;
  applyPressurePatch: (id: string, p: NPCPressure) => void;  // upsert one + debounced save
  clearNpcPressure: (id: string) => void;      // called when an NPC is deleted
};
```
- Add a `debouncedSavePressure(campaignId, map)` mirroring `debouncedSaveNPCLedger` in npcSlice.ts (idb key `npc_pressure_${campaignId}`).
- Wire the slice into the root store (find where `createNPCSlice` is composed — `src/store/useAppStore.ts` / `campaignStore.ts` slice creator list — and add `createPressureSlice` the same way). Reset `npcPressure` to `{}` on campaign switch alongside the other per-campaign state.

### A3. Persistence (`src/store/campaignStore.ts`)
Add next to `saveNPCLedger`/`getNPCLedger` (~line 83):
```ts
export async function savePressure(campaignId: string, map: Record<string, NPCPressure>) { await set(`npc_pressure_${campaignId}`, map); }
export async function getPressure(campaignId: string): Promise<Record<string, NPCPressure>> { return (await get(`npc_pressure_${campaignId}`)) || {}; }
```

### A4. Tracker (`src/services/npc/npcPressureTracker.ts`)
- `scanPressure`, `applyDecay`, `buildPressurePatch` stay, but `buildPressurePatch` should take the **prior NPCPressure** (from the map) instead of reading `npc.pressure`. Change its signature to `(prevPressure: NPCPressure | undefined, update, currentTurn): NPCPressure` (return the new pressure object, not a `Partial<NPCEntry>`).
- **Delete** `shouldArchiveNPC` and `findArchivedToRestore` (archive is gone). Keep `lastEngagedTurn` only if still used; otherwise delete it too (watch `noUnusedLocals`).

### A5. Turn pipeline (`src/services/turn/turnPostProcess.ts`, ~lines 405–470)
- Read `activeNPCs` = the whole ledger (no `!n.archived` filter; there's no archived flag now).
- Replace pressure read/write to go through the pressure map + `applyPressurePatch` (or a batch setter) instead of `updateNPC(..., { pressure })`.
- Passive decay loop: iterate the pressure map, not `npc.pressure`.
- **Delete** the entire auto-archive block (`if (callbacks.archiveNPC) { ... shouldArchiveNPC ... }`) and the restore-from-archive block (`findArchivedToRestore` for player + GM).
- Remove `archiveNPC` from `TurnCallbacks` (`src/services/turn/turnTypes.ts`) and from the call site that passes callbacks.

### A6. Consumers that read `npc.pressure` — repoint to the map
- `src/services/turn/turnOrchestrator.ts:59` — `(npc.pressure?.engaged ?? 0) > 0` → look up `npcPressure[npc.id]`.
- `src/services/engine/troublemaker.ts:40,46,47` — same, read from the map.
- `src/components/NPCPressureInspector.tsx` — read pressure from the store map by id; remove the `archived` card variant / "archived" badge (no archived NPCs anymore).

---

## PART B — Remove archive (two-state ledger)

### B1. `src/store/slices/npcSlice.ts`
- Delete `archiveNPC`, `restoreNPC` (and their types in `NPCSlice`).
- `removeNPC`: also call `clearNpcPressure(id)` (and it already deletes embeddings + portrait — keep that).
- `mergeOrRenameNpc`: the merge branch currently calls `archiveNPC(fromNpc.id, ...)`. Change it to `removeNPC(fromNpc.id)` (a backup is already taken upstream where merges happen; if not, that's acceptable per user decision — present or deleted).

### B2. `src/components/NPCLedgerModal.tsx`
- `activeNPCList`/`archivedNPCList` (~line 285): there's now no archived split. Keep the alphabetical sort (already added): `npcLedger.filter(n => !n.isPC?).sort(byName)` — actually keep current behavior minus the archived filter; just `npcLedger.slice().sort(byName)`. Verify whether PCs should be excluded (current code does not, leave as-is).
- **Delete** the entire "Archived (N)" section block (~lines 367–385) and the `restoreNPC`/`archiveNPC`/`handleRestore` wiring.
- `handleStartReview` / AI review uses `activeNPCList` — repoint to the single list.
- `handleApplyReview` (~line 253): it maps review actions to `archiveNPC`/`removeNPC`. Archive is gone — make the "archive" action a no-op-removed; review can only **delete** now (or keep). Update `NPCReviewModal`/`NPCReviewAction` accordingly (drop the `'archive'` action; default to `'keep'`).

### B3. Payload (`src/services/payload/payloadWorldContext.ts`)
- Remove every `!npc.archived` / `!n.archived` filter (lines ~74, ~113, ~170, and the loops at ~392+). The payload is already bounded by `capActiveNPCs` + on-stage minification — that protection stays; archive was never what protected the prompt.

### B4. Anywhere else referencing `.archived`
Grep `\.archived` across `src/` and clean each (e.g. `src/services/npc/nameSwap.ts`, `src/services/image/index.ts`, `src/services/campaign-state/divergenceRegister.ts`, `mergeOrRenameNpc` matches). The `matches`/lookup helpers that did `!n.archived` just drop that clause.

---

## PART C — Migration (run once on campaign load)

In `src/store/slices/campaignSlice.ts` where the campaign hydrates (the `Promise.all` around line 184 that calls `getNPCLedger(id)`):
1. Load raw ledger + `getPressure(id)`.
2. Build the pressure map: start from the persisted map; for any NPC that still carries a legacy `npc.pressure` and isn't already in the map, copy it in (`map[npc.id] ??= npc.pressure`).
3. Produce a cleaned ledger: for each NPC, **delete** `pressure`, `archived`, `archivedAtTurn`, `archivedReason` (un-archives everything — archived NPCs become present). Use object destructuring to drop fields.
4. `setNPCLedger(cleaned)` + `setNpcPressure(map)`. The debounced saves will persist both in the new shape, so the migration is self-healing on first load.

> Note: this restores the existing ~100 archived junk NPCs to *present*. The user will bulk-delete those manually afterward (the Select → Delete flow already exists). Do NOT auto-delete them.

---

## Tests
- `src/store/slices/__tests__/campaignSlice.characterization.test.ts` references `archived`/archive behavior — update to the new model; add a test that migration lifts legacy `npc.pressure` into the map and strips the field + un-archives.
- Add `src/store/slices/__tests__/pressureSlice.test.ts`: upsert, clear-on-delete, debounced save key.
- Update any test asserting `archiveNPC`/`restoreNPC` exist.
- `src/services/__tests__/*` that construct NPCs with `pressure`/`archived` inline still compile (fields optional-removed) — fix type errors the build surfaces.

## Verify (all must pass before declaring done)
```
npx vitest run        # full suite, expect green
npm run build         # tsc -b + vite — MUST be green (stricter than tests)
```
Report exact pass counts. If lint is run, note it's project-wide RED with ~93 pre-existing errors — only lint files you changed.

## Out of scope (do NOT do)
- No UI redesign of the selector (search/filters/sort-toggle) — that's a separate task.
- No changes to the name-detector (already fixed).
- No auto-deleting the existing graveyard.
