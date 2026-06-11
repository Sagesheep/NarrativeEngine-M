# Context Pipeline Invariant Audit — Findings

**Executed:** 2026-06-11 by Fable 5 (per `02_pipeline_audit__FABLE-OPUS.md`).
**Method:** end-to-end trace of all six invariants across the turn path
(`turnContext.ts` → archive/campaign-state/payload modules → `payloadBuilder.ts`), no code changed.
**Scope note:** all line numbers refer to the working tree as of this audit (post Plan-1 merge).

> **Fix-pass status (2026-06-11):** 10 of 10 items **DONE**, 819 vitest + `npm run build` green.
> - **OPUS (Opus 4.8):** F1 (funnel timeout fallback + abort), F3 (seal reads real scene content),
>   F5 (recall budget sized to world budget + per-scene trim), F6/F9/F10 (history clamp,
>   verbatim-rules cap, divergence-register cap, proportional tokenizer margin, overflow warn).
> - **SONNET (GLM):** F4 (funnel threads divergenceSceneIds + plannerFilters), F2 (pinnedExcerpts
>   wired TurnState→gatherContext→buildPayload), F8 (try/catch/finally around handlePostTurn +
>   runTurn so a post-turn failure can't wedge the streaming UI). Verified by Fable; added a
>   buildPayload-level guard for F2 (GLM's original test only hit the leaf block fn).
> - **FLASH (GLM):** F7 (scene-1000 parseInt sort), F11/F13/F14 (warn logs, empty-array guard,
>   countTokens estimator), F12/H1 (witness-integrity docs).

## Summary table

| ID | Sev | Invariant | Finding (one line) | Evidence |
|----|-----|-----------|--------------------|----------|
| F1 | **P1** (P0 on slow utility endpoints) | 4, 6 | Funnel loses its 5 s race → turn proceeds with **zero archive recall** (no flat fallback), and the losing funnel keeps spending utility-LLM calls whose results are discarded | turnContext.ts:334-353; archiveChapterEngine.ts:183 |
| F2 | **P1** | 2 | Pinned Memories feature is **dead on the live turn path** — `pinnedExcerpts` never reaches `buildPayload` | turnTypes.ts:51-85; turnContext.ts:505-525; payloadBuilder.ts:152 |
| F3 | **P1** | 1, 3 | Combined chapter seal is fed **120-char user snippets instead of scene content** — summaries, divergence facts, witness corrections, scene events all derived without GM narration | turnPostProcess.ts:101; divergenceExtractor.ts:19,30 |
| F4 | **P1** | 3 | Funnel recall path **omits divergence scene forcing** — `recallWithChapterFunnel` has no divergence parameter; only the flat path forces divergence scenes | archiveChapterEngine.ts:247-308; turnContext.ts:331-332 vs 356, 363 |
| F5 | **P1** | 2 | Archive recall world block is dropped **whole** when it exceeds the world budget — 3000-token recall + pinned-chapter scenes (35 % of limit) vs ~2949-token world budget on the 8k default | payloadWorldContext.ts:377-393; turnContext.ts:332, 388-390 |
| F6 | **P2** | 2 | Payload can exceed `contextLimit`: stable preamble falls back to **full verbatim rules** when rules RAG fails; divergence register and volatile blocks are unbudgeted; `historyBudget` can go negative (history starves first, then overflow) | payloadStableContent.ts:60-69; turnContext.ts:301-303; payloadBuilder.ts:115-121, 158-167; payloadHistoryFitting.ts:37 |
| F7 | **P2** | 5 | Timeline canon resolution sorts scene IDs **lexicographically** — past scene 999, the *older* event wins and resolved world state silently reverts | timelineResolver.ts:18 |
| F8 | **P2** | 4 | `handlePostTurn` awaited unguarded inside stream-complete; `runTurn` awaited unguarded in `ChatArea` — an archive-append failure loses the scene **and wedges the streaming UI** | turnOrchestrator.ts:450-466; turnPostProcess.ts:130; ChatArea.tsx:244 |
| F9 | **P2** | 2 | `computeBudgets` buckets `stable` / `summary` / `volatile` are computed but **never enforced** — only `world` and `rules` do anything | payloadBudgeter.ts:9-19; payloadBuilder.ts:101 |
| F10 | **P3** | 2 | `countTokens` is cl100k_base — accurate for OpenAI/DeepSeek-family, undercounts ~10-20 % for Llama/Mistral local models; combined with the fixed 200-token history margin this can overflow on local endpoints | tokenizer.ts:3; payloadHistoryFitting.ts:37 |
| F11 | **P3** | 4 | Silent-catch catalog (degraded recall/facts/timeline with no log) — see list below | turnContext.ts:313, 432-434, 443-445; turnPostProcess.ts:78, 174; ChatArea-path |
| F12 | **P3** | 1 | Divergence `knownBy` partition renders **both** the on-stage (full) and off-stage (bounded) fact views into the same prompt — partition is advisory, not isolating | divergenceRegister.ts:150-198 |
| F13 | **P3** | 1 | `filterRecallByPerception` would drop any scene whose `npcsWitnessed` is `[]` (all writers currently guard against writing `[]`, but nothing defends the reader) | payloadWorldContext.ts:72-84; turnPostProcess.ts:240, 266, 497 |
| F14 | **P3** | 2 | `deepArchiveSearch` budgets with `length/4` estimator while everything else uses the real tokenizer | deepArchiveSearch.ts:29 |
| H1–H7 | — | all | Checked-and-holds results (negative findings) — see bottom | — |

---

## Detailed findings

### F1 — Funnel timeout silently produces zero archive recall (P1; effectively P0 on slow utility endpoints)

**Trace.** `gatherContext` races the chapter funnel against a 5 s timer
(turnContext.ts:334-342). On timeout the race resolves `null`, and the code is:

```ts
if (result) { ...parse scenes... }
// no else — archiveResult stays { scenes: [], usedTokens: 0 }
```

The `catch` block (line 354) that falls back to `recallArchiveScenes` only fires on a **thrown**
error, never on the timeout. So a slow funnel — not a failed one — yields strictly worse behavior
than a crashed one: the turn is sent with **no archive memory at all**, silently.

**How often this fires.** `iterativeChapterFilter` issues up to 5 *sequential* `validateChapterRelevance`
LLM calls, each with its own 3 s abort (archiveChapterEngine.ts:183, comment claims it "matches the
outer FUNNEL_TIMEOUT_MS" — it doesn't; 5 × 3 s ≫ 5 s). Any utility endpoint that takes >1.5-2 s per
tiny call (typical for local models under load) loses the race **every turn**. The user experiences
"the GM forgot everything," with zero log output.

**Wasted spend.** The losing `funnelPromise` is not cancelled; its remaining validation calls still
run and the result is discarded (Invariant 6 violation: paid-but-discarded).

**Proposed fix (small, reviewable):**
1. On timeout, fall back to flat recall — same call as the `catch` branch. (The funnel's
   abort/cancellation can be a follow-up; the fallback is the critical part.)
2. `console.warn('[Funnel] lost 5s race — flat recall fallback')` so health is observable.
3. Either raise the outer race to ≥ `MAX_LLM_ITERATIONS × 3 s + ε`, or pass an `AbortSignal`
   into the funnel so the loser stops spending.

### F2 — Pinned Memories never reach the prompt (P1)

`payloadBuilder.ts` fully supports a `[PINNED MEMORIES]` system block (lines 150-156, 190), the
UI lets users pin excerpts and shows a token-cost meter (`PinnedMemoriesPanel.tsx`,
`MessageBubble.tsx`), the trace view even has a `PINNED` label (`EngineTraceView.tsx:16`) —
but the only two live `buildPayload` call sites omit `pinnedExcerpts`:

- turn path: turnContext.ts:505-525 — not passed; `TurnState` (turnTypes.ts:51-85) has no
  `pinnedExcerpts` field, so `gatherContext` *couldn't* pass it.
- combat narration: turnOrchestrator.ts:845 — also not passed (arguably fine here).

The whole feature is inert: pinning changes persistence (`chatSlice` saves it) and UI badges,
but never the prompt. Tests exercise `buildPinnedMemoriesBlock` directly, so nothing catches it.

**Proposed fix:** add `pinnedExcerpts: PinnedExcerpt[]` to `TurnState`, populate it in
`ChatArea.tsx` (`useAppStore.getState().pinnedExcerpts`), pass through `gatherContext` into
`buildPayload`. ~6 lines + one wiring test asserting a pinned excerpt lands in the payload.

### F3 — Chapter seal works from user snippets, not scenes (P1)

`runCombinedSeal` (turnPostProcess.ts:90-119) builds its input from the archive **index**:

```ts
const allScenes = await api.archive.getIndex(activeCampaignId);   // index entries!
...
const scenesContent = chapterScenes.map(s => ({ sceneId: s.sceneId, content: s.userSnippet || '' }));
```

`userSnippet` is the first **120 characters of the player's message** (archiveIndexer.ts:131).
GM narration — where deaths, alliances, divergences, and witness facts actually live — never
reaches the seal LLM. Yet `buildCombinedSealPrompt` allocates `COMBINED_SEAL_TOKEN_BUDGET = 12000`
tokens and runs `truncateScenesToBudget` (divergenceExtractor.ts:19, 30), which only makes sense
for full scene content. Downstream casualties: chapter `summary`, `keywords`, `majorEvents`,
`unresolvedThreads`/`resolvedThreads`, `npcInnerState`, **divergence extraction**,
**witness corrections**, and **structured scene events** are all derived from player-input
fragments. Everything appears to work (valid JSON comes back), so it degrades silently.

**Proposed fix:** fetch real content via `offlineStorage.archive.getScenes(campaignId, sceneIds)`
(same API `fetchArchiveScenes` uses) and feed `{ sceneId, content: user+gm }` to the seal.
One function touched; verify seal quality on a long campaign afterward.

### F4 — Funnel path loses divergence forcing (P1)

`retrieveArchiveMemory` force-surfaces divergence scenes (archiveMemory.ts:380-396) — but only
when `divergenceSceneIds` is passed. The flat paths pass it (turnContext.ts:356, 363); the funnel
calls `retrieveArchiveMemory` three times (archiveChapterEngine.ts:266, 289, 295) and
**never passes it** — the funnel signature (line 247-259) has no divergence parameter at all.
Also missing from the funnel: `plannerFilters` (passed on flat paths, line 356/363, dropped in
funnel Phase 4).

Consequence: precisely on the higher tiers (pro/max, where the funnel runs), recall is *less*
divergence-aware than on lite. A diverged scene that doesn't match this turn's keywords will not
be re-surfaced, and the model may re-assert canon — the exact failure the register exists to stop.
(The `[ESTABLISHED FACTS]` system block still mitigates: divergence *facts* are always injected;
what's lost is the verbatim diverged *scene*.)

**Proposed fix:** thread `divergenceSceneIds: Set<string>` (and `plannerFilters`) through
`recallWithChapterFunnel` into all three internal `retrieveArchiveMemory` calls. Mechanical.

### F5 — Archive recall block dropped whole when over world budget (P1)

`trimWorldBlocks` is all-or-nothing per block (payloadWorldContext.ts:384-391): a block that
doesn't fit is dropped entirely (later, smaller blocks still fill in). Block order = priority:
**Archive Recall, Open Threads, Deep Brief, Lore, Facts, Notebook, NPCs**.

Numbers on the 8k default (`rulesBudgetPct` 0.10): world budget = 0.40 × (8192 − 819) ≈ **2949**
tokens (no deep scan). The funnel/flat recall is fetched against a hardcoded **3000** budget
(turnContext.ts:332, 356, 363) *plus* header/event-line overhead added per scene
(payloadWorldContext.ts:240-264), *plus* pinned-chapter scenes fetched against
`0.35 × contextLimit` ≈ 2867 and concatenated into the same block (turnContext.ts:388-390).
A full recall therefore **cannot fit** the world budget on default settings — and the result is
not truncation but total drop: all the recall work (semantic search, rerank, funnel LLM calls,
scene fetch) is spent, then thrown away. The drop is logged only in `debugMode` (trace),
never to console.

Pinning chapters makes it *more* likely the player loses all archive context — inverted UX.

**Proposed fix (two independent parts):**
1. Derive the recall fetch budget from the real world budget (e.g.
   `min(3000, worldBudget × 0.7)`), and give pinned scenes the *remainder* of that, not an
   independent 35 % of the whole context.
2. Make `trimWorldBlocks` truncate the Archive Recall block scene-by-scene (drop lowest-rank
   scenes first) instead of all-or-nothing, and `console.warn` any dropped/truncated block in
   production.

### F6 — Payload can exceed contextLimit; history starves first (P2)

`fitHistory` is the only global re-fitter: `historyBudget = limit − reserved − 200`
(payloadHistoryFitting.ts:37, not clamped at 0). The reserved sections themselves are not all
bounded:

- **Stable**: when `rulesRaw` is large *and* rules-RAG returns nothing (retrieval threw —
  caught at turnContext.ts:301-303 — or matched zero chunks), `buildStablePreamble` pushes the
  **entire verbatim rules file** (payloadStableContent.ts:63-69). A 6k-token rules file on an 8k
  limit leaves a negative history budget and a payload that already exceeds the limit before
  history/user message are added.
- **Divergence register**: unbudgeted (payloadBuilder.ts:115-121); grows monotonically with
  campaign length (entries merge at every seal, mergeSealEntries). A 100-entry register is
  ~1.5-2k tokens, silently.
- **Volatile**: character profile + inventory + scene note + combat block unbudgeted
  (payloadBuilder.ts:158-167) — bounded in practice by the bookkeeping scans, but nothing
  enforces it.

Failure mode is graceful-ish (history shrinks to zero first) until stable+divergence+volatile+world
alone exceed the limit; then the provider truncates or errors. Worst case to hit in the wild:
big rules file + RAG failure + long campaign + 8k local model.

**Proposed fix:** clamp `historyBudget` at ≥ 0; cap the verbatim-rules fallback at
`budgetMap.rules × 1.2` with a `[RULES TRUNCATED]` marker + console.warn; render the divergence
register through a token cap (oldest non-pinned chapters collapse to counts first —
`countRegisterTokens` already exists); emit one console.warn when
`stable+divergence+world+volatile+user > limit`.

### F7 — Lexicographic scene-ID sort breaks canon resolution past scene 999 (P2)

`resolveTimeline` picks the latest event per (subject, predicate) group via
`b.sceneId.localeCompare(a.sceneId)` (timelineResolver.ts:18). Scene IDs are zero-padded to
3 digits (`padStart(3, '0')` — turnContext.ts:312, archiveChapterEngine.ts:45,
turnPostProcess.ts:104), so ordering is correct up to `999` and **wrong from scene 1000**
(`'1000' < '999'` lexicographically): the resolved world state silently reverts to the older
fact — e.g. a character resurrected at scene 1003 stays "dead" because the scene-998 death wins.
Auto-seal at 25 scenes/chapter means scene 1000 ≈ chapter 40 — reachable for long campaigns.

**Proposed fix:** `parseInt`-compare in `resolveTimeline` (one line). While in there, audit the
other two `localeCompare`-free sort sites found — `fetchArchiveScenes` and divergence ordering
already use `parseInt` (correct); no other lexicographic comparison on scene IDs was found.

### F8 — Unguarded awaits wedge the streaming UI on post-turn failure (P2)

- `handlePostTurn` is awaited at turnOrchestrator.ts:450 with no try/catch. Its first statement
  is `await api.archive.append(...)` (turnPostProcess.ts:130). If append throws (storage quota,
  IndexedDB error), the exception escapes the stream-complete callback **before**
  `setStreaming(false)` / `setPipelinePhase('idle')` at lines 464-466 → the scene is lost *and*
  the UI is stuck in streaming state until reload.
- Same pattern one level up: `await runTurn(...)` in `ChatArea.tsx:244` has no try/catch, and
  `gatherContext` itself is awaited unguarded at turnOrchestrator.ts:80.

**Proposed fix:** wrap `handlePostTurn` in try/catch (toast.error + console.error, still reach
the `setStreaming(false)` lines — or move those into a `finally`); wrap the body of `runTurn`'s
awaited prelude (or the ChatArea call) similarly. Behavior on failure: turn text is preserved,
post-processing skipped with a visible toast.

### F9 — Three of five budget buckets are decorative (P2, design debt)

`computeBudgets` returns `{ stable, summary, world, rules, volatile }` (payloadBudgeter.ts) but
only `world` (trimWorldBlocks) and `rules` (RAG threshold) are enforced anywhere. `stable`,
`summary`, `volatile` are dead knobs — which is exactly why F6's overflows exist. Fixing F6
naturally retires this; alternatively delete the unused buckets so the budget map tells the truth.
Flagged separately so the fix pass makes a deliberate choice.

### F10 — Tokenizer family vs local models + thin margin (P3)

`countTokens` uses cl100k_base (tokenizer.ts:3) — good for OpenAI/DeepSeek-family, but
Llama/Mistral/Qwen tokenizers segment differently; cl100k typically **undercounts** their token
usage by ~10-20 % on prose. The pipeline's entire safety margin is the fixed `− 200` in
`fitHistory`. On an 8k local model, a 15 % undercount of a 7k payload is ~1000 tokens of
overflow. Suggest: make the margin proportional (e.g. `max(200, limit × 0.05)`) and/or expose a
per-provider correction factor. Cheap insurance; pairs with F6.

### F11 — Silent-catch catalog (P3, observability)

Turn-path catches with no logging, with the user-visible effect when they fire:

| Site | What fails | User experience | Action |
|------|-----------|-----------------|--------|
| turnContext.ts:313 | `getNextSceneNumber` | scene header missing from payload; witness/index patch for this scene keyed correctly later anyway | add console.warn |
| turnContext.ts:432-434 | `queryFacts` | semantic facts absent this turn | add console.warn |
| turnContext.ts:443-445 | timeline resolve | resolved world state absent | add console.warn |
| turnContext.ts:354 | funnel threw | flat-recall fallback (good) — but invisible | add console.warn (F1 fix adds it) |
| turnPostProcess.ts:78 | aux witness LLM | witness falls back to body-extraction | acceptable; warn optional |
| turnPostProcess.ts:174 | facts refresh | facts go stale until next refresh | add console.warn |
| turnPostProcess.ts:549-551 | whole seal flow | toast "Failed to seal chapter" but the error object is discarded | log `err` in the catch |
| payloadWorldContext trim | block dropped | world content silently missing in non-debug mode | warn on drop (F5 fix) |

(For comparison: embeddingScheduler's silent storage catch was fixed in Plan 1; its outer drain
catch at line ~170 remains silent but the queue completes — left for the embedding follow-up.)

### F12 — Divergence knownBy partition is advisory (P3, document as design limit)

`renderRegisterForPayload` builds an on-stage block (all facts) and an off-stage block (facts
bounded by `knownBy`) — and emits **both** into the same system message
(divergenceRegister.ts:195-198). The LLM sees every fact regardless; the partition only *labels*
what off-stage NPCs should know. Combined with H1 below, the honest statement of the app's core
promise is: **witness integrity is enforced behaviorally (prompt instructions), with structural
support only at the scene-recall filter.** That is a defensible design for an LLM GM — but it
should be stated in `docs/` rather than implied. No code change proposed; documentation task.

### F13 — Perception filter fragile to empty witness arrays (P3, hardening)

`filterRecallByPerception` drops a scene when `npcsWitnessed` is a **non-matching, possibly
empty** array (payloadWorldContext.ts:77-83: both loops over `[]` fall through to
`return false`). Today all three writers guard against writing `[]`
(turnPostProcess.ts:239-241, 266, 493-497 — empty resolves to `undefined`), so PC-solo scenes
pass via the `undefined` check. One future writer that stores `[]` makes PC-solo scenes
permanently unrecallable, and no test pins this. **Fix:** one-line guard
(`if (idxEntry.npcsWitnessed.length === 0) return true;`) + a test asserting `[]` behaves like
`undefined`.

### F14 — deepArchiveSearch uses chars/4 estimator (P3)

`EST_TOKENS = length/4` (deepArchiveSearch.ts:29) while the rest of the pipeline uses real BPE.
Only soft caps are affected (overview assembly); the final brief is budgeted upstream by
`deepBudget`. Switch to `countTokens` for consistency when touching the file; not urgent.

---

## Checked and holds (negative results)

| ID | Invariant | What was checked | Verdict |
|----|-----------|------------------|---------|
| H1 | 1 | Witness enforcement layering: structural filter (`filterRecallByPerception`) + per-scene `Witnessed by:` headers (payloadWorldContext.ts:243-251) + `[NPC KNOWLEDGE BOUNDARY]` system block (payloadStableContent.ts:82-88) + `[KNOWLEDGE FROZEN]` tag on off-stage minified NPCs (contextMinifier.ts:140) | Holds as **hybrid**: structural filter is coarse (only excludes scenes whose recorded witnesses are all archived and none on-stage); per-NPC enforcement is behavioral, and the prompt *does* state it. See F12 for the documentation task. |
| H2 | 1 | `npcsWitnessed = []` never written | Holds — all three writers (header / aux-or-body fallback / seal corrections) guard non-empty. F13 hardens the reader anyway. |
| H3 | 1 | NPC minification leaking unwitnessed knowledge | Holds — `minifyNPC` carries status/affinity/appearance/personality/goals only; no cross-scene event data. `Inner:` notes come from chapter `npcInnerState`, which is the NPC's own state. |
| H4 | 3 | Seal summaries baking pre-divergence canon | Holds in design — the seal summarizes play text (scenes as they happened, divergence included), not lore. (But see F3: it currently summarizes the wrong text entirely.) |
| H5 | 5 | Scene-ID padding round-trip through the funnel | Holds — `--- SCENE (\d+) ---` capture preserves leading zeros; `indexMap.get(sceneId)` lookups compare same-source padded strings; `fetchArchiveScenes`/range filters use `parseInt`. The one violation is F7. |
| H6 | 6 | Tier gates: lite/pro/max degrade cleanly | Holds — every `tierAllows` feature on the turn path is checked **before** any LLM call is issued; flat-recall else-branch (turnContext.ts:360-366) covers funnel-off and no-chapters. The one paid-but-discarded path is the funnel race loser (F1). |
| H7 | 2, 6 | `pinnedChapterIds` cleared at turnContext.ts:397 then read again at :449 | Holds **by snapshot semantics** — `TurnState.pinnedChapterIds` is captured at turn start (ChatArea.tsx:283), so the recommender still sees this turn's pins. Fragile if TurnState ever becomes live-getter-based; a comment at the clear site would help. |
| H8 | 2 | `fitHistory` accounting | Holds — every emitted section (stable, divergence, pinned-memories, world, volatile, user msg) is counted into `reservedTokens`; history fits the remainder; tool/scene-marker messages excluded. Issues are only the unbounded inputs (F6) and the unclamped negative budget. |

---

## Fix pass — scoped task list

Ordered by severity, then by how much each unblocks. Each item is a separate reviewable change.
**Verification rule for every item:** `npm run build` (tsc -b) **and** `npx vitest run` green;
lint only touched files (~93 pre-existing project-wide errors).

| # | Fixes | Executor | Size | Notes | Status |
|---|-------|----------|------|-------|--------|
| 1 | F1 funnel timeout → flat-recall fallback + warn (+ raise/abort race) | **OPUS** | S | concurrency-adjacent; add test: race loses → flat recall result present | ✅ DONE — abort threaded funnel→filter→validate; `funnelAbort.test.ts` |
| 2 | F3 seal input: fetch real scene content | **OPUS** | S | one function; add test seal prompt contains GM text | ✅ DONE — `getScenes` fetch; `sealContent.test.ts` |
| 3 | F4 thread divergenceSceneIds + plannerFilters through funnel | **DONE** | S | mechanical signature threading; test: diverged scene forced in funnel result | ✅ DONE — `divergenceSceneIds` + `filters` params added to `recallWithChapterFunnel`; all three internal `retrieveArchiveMemory` calls forward them; call sites in `turnContext.ts` pass them; pinned chapter injection also passes `divergenceSceneIds`; `auditFixes.test.ts` |
| 4 | F2 wire pinnedExcerpts through TurnState → gatherContext → buildPayload | **DONE** | S | + payload test | ✅ DONE — `pinnedExcerpts?: PinnedExcerpt[]` added to `TurnState`; passed from `ChatArea.tsx` → `runTurn`; forwarded to `buildPayload` in `turnContext.ts`; `auditFixes.test.ts` |
| 5 | F5 recall budget derived from world budget + per-scene truncation in trimWorldBlocks + warn-on-drop | **OPUS** | M | touches ranking/budget interplay; characterization tests for block order first | ✅ DONE — `WorldBlock.segments/rewrap`; `budgetHardening.test.ts` |
| 6 | F6+F9+F10 budget hardening: clamp historyBudget, cap verbatim-rules fallback, cap divergence render, proportional margin, retire or enforce dead buckets | **OPUS** | M | one PR; budget table in PR description | ✅ DONE — buckets kept advisory + overflow warn; `budgetHardening.test.ts` |
| 7 | F7 parseInt compare in resolveTimeline | **DONE** | XS | + test with scene 999/1000 | ✅ DONE — `parseInt` compare; `auditFixes.test.ts` |
| 8 | F8 try/catch + finally around handlePostTurn / runTurn prelude | **DONE** | S | assert streaming flag resets on induced failure | ✅ DONE — `handlePostTurn` wrapped in try/catch/finally in `turnOrchestrator.ts`; teardown moved to `finally`; error toast on catch; `ChatArea.tsx` `handleSend` wraps `runTurn` in try/finally |
| 9 | F11 console.warn sweep + F13 empty-array guard + F14 tokenizer consistency | **DONE** | S | pure additive logging + 1-line guard + tests | ✅ DONE — 5 warn logs added; F13 guard; F14 `countTokens`; `auditFixes.test.ts` |
| 10 | F12+H1 document witness-integrity model in docs/ (structural vs behavioral) | **DONE** | XS | docs only | ✅ DONE — `docs/WITNESS_INTEGRITY.md` |

**Implementation notes (items 5/6):** `archiveRecallBudget = clamp(600, worldBudgetEstimate, 3000)` where
`worldBudgetEstimate = floor((limit − rulesReserve) × 0.40)`; pinned scenes now take the *remainder*
of the world budget after recall, not an independent 35 % of the whole context. `trimWorldBlocks`
keeps the largest scene prefix that fits (segments lose rank ordering by the time they reach the
payload — prefix = chronological-oldest-first; acceptable as a safety net, the fetch-budget sizing
is the primary fix). Divergence cap = `limit × 0.20`, collapses oldest non-pinned chapters first.
The three advisory budget buckets (stable/summary/volatile) were **kept** (deliberate F9 choice) with
a truth-telling comment + a buildPayload overflow warn, rather than deleted or hard-enforced.

Suggested batching: (7, 9) as one quick PR; (1, 2) next — they're the silent-data-quality pair;
then 3, 4, 5, 6, 8, 10.
