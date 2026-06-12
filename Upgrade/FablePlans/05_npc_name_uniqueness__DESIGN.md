# NPC Name Uniqueness — Deterministic Swap Layer (Design)

> Status: **DESIGN SETTLED 2026-06-12** — discussed and decided with product owner.
> Ready for implementation hand-off (Opus-class model is sufficient; this doc is
> self-contained for a cold session). The two previously-open decisions are resolved
> at the bottom.
>
> Execution phases:
> - **05a** `05a_name_assets_generation__FLASH.md` — raw name bank + blocklist generation (cheap model, offline) — DONE
> - **05b** `05b_name_assets_review__GLM.md` — review/wringer pass + human skim → FROZEN assets — DONE (assets in `assets/clean/`; only 1/26 files carries the FROZEN marker — human skim of REMOVED/#ambiguous sections never completed, see caveat below)
> - **05c** — engine implementation — **DETERMINISTIC CORE DONE 2026-06-12 (Opus 4.8), build + 861 tests green**

## 05c implementation status (2026-06-12)

**SHIPPED — deterministic backbone, end-to-end & tested:**
- `scripts/buildNameBank.mjs` → `src/data/nameBank.json` (6322 names, 18 cultures) +
  `src/data/nameBlocklist.json` (975 words; #ambiguous sections excluded; a build-time
  rule drops any blocklist word that shadows a bank name — names win).
- `src/services/npc/nameBank.ts` — Set/Map loader: `isKnownName`, `lookupCultures`
  (self-classifier, Component D), `genderOf`, `drawUnusedName` (tiered: culture+gender →
  culture → fantasy-neutral → whole bank; injectable rng).
- `src/services/npc/nameSwap.ts` — `detectCollisions` (first-name keyed, relation
  exception automatic), `decideSwap` (table rows 1/2/3 + PC veto; rows 4/5/6 collapse to
  `flag`), `applySwap` (case-insensitive word-boundary incl. possessive), `swapDuplicateNames`
  (the single entry point; `activeNpcIds` undefined → bias to flag, never blind swap).
- Detector blocklist extended from generated data (`npcDetector.ts`).
- `activeNpcIds` threaded out of the payload (`WorldBlock.npcIds` → `buildPayload` return),
  pre-trim (trimmed-out → reported in-payload → biases to flag).
- Single rewrite point wired in `turnOrchestrator.ts` final non-tool branch: synchronous
  swap on `finalText` BEFORE `updateLastAssistant` + `handlePostTurn`, so display, archive,
  and detection all read post-swap text. Streaming = post-stream correction (Decision 1a).
- `' the Younger'` retired (`npcGeneration.ts`) → `drawUnusedName` keyed on the colliding
  name's culture/gender; `' the Younger'` kept only as pool-exhausted last resort.
- Tests: `nameBank.test.ts` (13) + `nameSwap.test.ts` (15). Full suite 861 green; `npm run build` clean.

**DEFERRED (separable; documented for a later pass):**
- **Component C+E** — campaign-header classification utility call + settings dropdown +
  per-turn 5-name menu in the prompt. The swap works without it (self-classification),
  but this is the proactive layer that makes collisions rare up front.
- **Component G** — gray-zone tie-breaker AI call. Table currently returns `flag` for
  rows 4/5/6 (in-payload, off-stage). Wiring G turns some flags into leave/swap. Keeping
  the rewrite point synchronous (no await) was a deliberate low-risk choice.
- **Component H** — rich one-tap flag UX. Flags are currently logged
  (`[NameSwap] flagged …`) and the text is left untouched; no player-facing resolution yet.
- **Predictive recommender** prompt tweak (the separate "details wrong" improvement).

**CAVEAT — assets not human-skimmed.** 05b's FROZEN gate (manual review of REMOVED + every
blocklist `#ambiguous` section) was not completed; only 1/26 clean files is marked FROZEN.
The build-time name-shadow guard caught the 2 worst cases ("mark", "shinto"). A future skim
of `assets/clean/*REMOVED*` and the `#ambiguous` sections is still worthwhile before treating
the asset quality as final. Re-run `node scripts/buildNameBank.mjs` after any asset edit.

## Problem

The story AI reuses NPC names. Players see seven different "Voss"es because each new
character is minted independently with no awareness of names already in the ledger.

Two failure shapes observed:
- **Name reuse**: a brand-new character is introduced with a name already owned by an
  existing NPC.
- **Bad disambiguation fallback**: `generateNPCProfile` (in
  `src/services/npc/npcGeneration.ts`) appends `' the Younger'` when its collision
  retry also collides — producing "Voss the Younger" instead of a real distinct name.

## What already shipped (prompt-level guards)

These reduce — but do not eliminate — the problem:

1. **`[RESERVED CHARACTER NAMES]` block** in the story payload
   (`src/services/payload/payloadWorldContext.ts`, `buildReservedNamesBlock`). Lists
   every ledger name (names only, archived included) and instructs the model: new
   characters get distinct names; shared family/clan/house surname allowed ONLY with an
   explicit in-story relation; first names never reused. Placed first among world blocks
   so budget trimming can't drop it.
2. **Reserved list fed into `generateNPCProfile`** initial + retry prompts so the
   generator avoids collisions up front.
3. **Detector hardening** (`src/services/npc/npcDetector.ts`): `classifyNPCNames`
   matches symmetrically (so "Voss the Younger" / "Maren Blackwood" resolve to existing
   ledger entries "Voss"/"Maren" instead of duplicating), plus org-name blocklist.

**Limitation:** all of the above are *instructions*. A weak story model can still ignore
them — and even strong models at 100k context don't follow every rule. This design is
the **deterministic backstop** that doesn't depend on model compliance.

## Settled architecture (overview)

Layered defense; each layer makes the next one rarer. Per-turn AI cost: **+0 calls in
the steady state, +1 conditional call** only on a collision the deterministic table
cannot resolve.

```
1. PROMPT GUARD (shipped)        reserved-names block — depends on compliance
2. NAME MENU (new, 0 AI/turn)    "name new characters from this menu: 5 unused pool names"
3. DETERMINISTIC SWAP (new)      decision table over engine-known facts; rewrite pre-commit
4. TIE-BREAKER (new, rare)       one tiny utility call, only for the gray zone
5. FLAG, DON'T SWAP (new)        one-tap player resolution for what even AI can't decide
```

### Component A — engine-shipped name list with culture headers

A static asset shipped with the engine (fully offline, agnostic, no per-campaign
generation dependency). ~8,000 names ≈ 60–80 KB — trivial. Markdown-style hierarchy:

```
#western
##english
##wild-west
#oriental
##japan
##chinese
#slavic
##ukrainian
#fantasy-neutral        ← designated fallback group, must be large
...
```

**Dual purpose — this is load-bearing:**
1. **Draw pool** for replacements and the per-turn name menu.
2. **Name → culture classifier**: looking up which header contains a name tells you its
   origin. This is what makes per-NPC culture selection zero-AI (see Component D).

**Format details:**
- Every name carries a **gender tag** (`Name | m/f/u`). The swap must prefer a
  same-gender replacement — prose saying "a woman named Kenta" after a careless swap
  would jar. Detector gendered-intro words ("a woman named…") are a secondary signal
  when the minted name isn't in the list.
- A name MAY belong to multiple headers ("Anna" under ##english and ##russian) —
  lookup returns all memberships; when classifying a colliding minted name, prefer the
  membership matching the campaign headers, else any.

**Build pipeline (one-time, offline, not runtime):**
cheap AI (Flash/GLM) generates raw lists (phase 05a) → mid AI "wringer" pass
dedupes/filters junk (phase 05b) → single human/strong-model skim of removals +
ambiguous entries → assets marked FROZEN → ship as static asset.

Runtime lookup: plain JS `Set`/`Map` (hash lookup, O(1)). **No trie needed** — tries are
for prefix search; membership checks at 8k entries are instant with a Set.

### Component B — detector blocklist (same pipeline)

A large generated blocklist (titles, ranks, place-words, capitalized common nouns:
"Sergeant", "Winter", "Mother", …) extending the existing hand-grown org blocklist in
`npcDetector.ts`. Same cheap→mid→review pipeline. Cuts false NPC detections and cleans
ledger noise — pays off outside this feature too.

### Component C — campaign header classification (once per campaign, ~0 cost)

At campaign setup, one tiny utility call: send the **header taxonomy only** (top headers
+ subheaders, NOT the names — ~40 tokens) plus a sliver of campaign context (setting
summary or first ~500 chars of lore doc + a few existing character names):
*"Which of these headers fit this world? Maximum 3."*

- **Closed-set, validated**: parse the reply, drop anything not matching a real header
  exactly. Nothing valid survives → fall back to `#fantasy-neutral`.
- **Hierarchy semantics**: picking a parent (`#oriental`) = union of its subgroups;
  picking `##japan` = that group only. Up to 3 picks union into the campaign's menu pool.
- **Author override**: surface the chosen headers in campaign settings as a dropdown.
  Covers both correction and hand-curation. Re-classify only on explicit request.
- Stored in the campaign bundle (`src/services/campaignBundle.ts`).

**Scope limit (important):** campaign headers seed the *proactive name menu ONLY*. They
are a default flavor, **not a cage**. The story AI stays free to introduce any culture
(isekai campaign meeting a Ukrainian is fine — see Component D). The swap never uses
campaign headers to pick a replacement.

### Component D — per-NPC culture: the duplicate name classifies itself (0 AI)

When a swap fires, the engine does NOT choose a culture — the story AI already did, by
minting the name. The colliding name is looked up in the engine list:

- AI mints "Hanabi" (collides) → found under `##japan` → replacement drawn from
  `##japan` → player sees "Kaede". Culture preserved, no AI call, regardless of campaign
  headers.
- AI mints "Dmytro" in an isekai campaign (collides) → found under `##ukrainian` →
  replacement "Bohdan", not a western default.
- Non-colliding exotic names pass through untouched (no collision → no swap → engine
  never intervenes).

**Gap fallback**: minted name not in the 8k list at all → collision is also near
impossible (not in ledger either). If it somehow happens: one utility call, "5 names
with the same vibe as X". Rounds to zero frequency.

Draw mechanics: `Math.random()` over the header group, filtered against ledger names +
lore headers (an engine name must never collide with an author's existing character).
Mark drawn names consumed per campaign.

### Component E — per-turn name menu (0 AI)

Every turn, inject ~5 unused pool names (drawn from campaign-header groups) into the
story prompt: *"If you introduce any new character this turn, name them from this list:
Maddox, Sera, Korrin, …"*. The model grabs from a short menu instead of having to obey
"avoid these 80 names" — makes collisions rare before the swap layer ever runs.

### Component F — swap decision table (hard problem 1, SOLVED)

Core insight: **the engine knows exactly what it showed the story AI this turn.** A
duplicate happens because the model didn't have the real NPC in front of it. So decide
from verifiable facts, not model intent:

Given: detector intro pattern fired ("a man named Voss", role-apposition, etc. — NOT a
bare mention) AND first-name collision with ledger:

| # | Condition (checked in order) | Verdict |
|---|---|---|
| 1 | Existing NPC is **on-stage** this turn (`onStageNpcIds`) | **Leave** — it's a reference. Hard veto, never swap. |
| 2 | Existing NPC's profile was **NOT in this turn's payload** (not in active NPC context, not semantically recalled) | **Swap confidently** — the model couldn't have meant them; coincidence mint. |
| 3 | Existing NPC is **dead/archived** | **Swap** (flag instead if campaign allows resurrection plots). |
| 4 | Profile **was in payload** but NPC off-stage + detector's apposition role **matches** ledger role/description keywords | **Leave** — deliberate deployment of the real NPC (legit first on-screen appearance). |
| 5 | Profile was in payload, off-stage, role **contradicts** ledger ("young sailor Voss" vs ledger old blacksmith) | **Swap.** |
| 6 | Gray zone — in payload, off-stage, role inconclusive | **Tie-breaker call** (Component G). |

**Relation exception (preserve):** collision keys on **first names only**. "John
Ashwood" when "Rick Ashwood" exists is legal (siblings/clan/dojo surname). Shared
surname + different first name must never trigger.

Bias rule: every **swap** verdict requires positive evidence the model couldn't/didn't
mean the real character. Absence of proof → leave or flag. A wrong swap corrupts canon
(strictly worse than a duplicate).

### Component G — gray-zone tie-breaker (the ONLY per-turn AI call, conditional)

Fires only when row 6 is reached — collision + in-payload + off-stage + inconclusive
role. A few times per session at most:

*"Prose sentence: «…». Existing character: Voss, old blacksmith in Ashford, last seen
owing the party money. Same person? Answer: yes / no / unsure."*

- `yes` → leave. `no` → swap. `unsure` → flag.
- **Tier-gated** like the recommender (`tierAllows`): lower tiers skip straight to flag.
- **Off the critical path**: runs at the post-stream rewrite point while the player is
  already reading — not stacked on response latency.

### Component H — flag UX

Small inline prompt on the message: *"New character 'Voss' may duplicate existing Voss —
[keep as same person] [rename to Maddox]"*. One tap; the answer feeds the same rewrite
point so the choice stays consistent across display, archive, and ledger.

### Component I — single rewrite point (hard problem 2)

The swap executes at ONE canonical point in the turn post-process pipeline
(`src/services/turn/turnPostProcess.ts` / `turnOrchestrator.ts`), **between generation
and commit** — before display-final state, archive/embeddings/fact extraction, and NPC
detection. All downstream consumers read post-swap text; otherwise stored scenes say
Voss while the ledger says Maddox (ghost).

Swap execution is pure code: word-boundary regex replacement handling possessives and
punctuation ("Hanabi's", "Hanabi,"). No AI.

## Resolved decisions (previously open)

**Decision 1 — Streaming: (a) post-stream correction.** Text streams live; on the rare
swap turn the name visibly updates once at turn end. A rare one-frame flicker beats
adding buffering latency to every turn. (Reversible later if the flicker annoys in
practice.)

**Decision 2 — Pool seeding: engine-shipped static tagged list** (Components A + C),
replacing the earlier "generate pool from lore doc at setup" sketch. Auto-classification
with author-override dropdown. Lore-generated pools remain a possible future enhancement,
not a dependency.

## Related improvement (separate, small): predictive recommender

The existing recommender (`src/services/turn/stages/recommenderStage.ts` →
`recommendContext`) picks NPCs *reactively* — relevant to what just happened. Extend its
prompt to also be *predictive*: "list ledger NPCs likely to appear next given where the
scene is heading." Fixes the "details wrong because profile wasn't in payload" failure.
One prompt change to an existing call; zero added latency; also shrinks decision-table
row 2 false-negatives. Can ship independently of the swap layer.

## Relevant code (entry points)

- `src/services/npc/npcDetector.ts` — `extractNPCNames` (intro passes),
  `classifyNPCNames` (collision, already symmetric), org blocklist (extend with B).
- `src/services/payload/payloadWorldContext.ts` — `buildReservedNamesBlock`,
  `selectActiveNPCs` / `capActiveNPCs` / `mergeSemanticRecall`, `onStageNpcIds` —
  source of "in payload" + "on-stage" facts for the decision table.
- `src/services/turn/stages/recommenderStage.ts` — recommender (predictive extension).
- `src/services/turn/turnPostProcess.ts` / `turnOrchestrator.ts` — the rewrite point.
- `src/services/npc/npcGeneration.ts` — `generateNPCProfile`; retire `' the Younger'`
  fallback once the pool exists (draw from pool instead).
- `src/services/campaignBundle.ts` — persisted campaign headers + consumed-name state.

## Scope guardrails

- Do NOT swap on bare name mentions — introduction patterns only.
- Do NOT swap when the colliding NPC is on-stage (hard veto).
- First-name collision only; respect the shared-surname relation exception.
- Campaign headers seed the menu only — never constrain what the story AI may introduce,
  never pick the replacement culture (the colliding name self-classifies).
- One canonical rewrite point; display/archive/detection all read post-swap text.
- Every swap requires positive evidence; ambiguity → flag, never guess.
- Per-turn AI budget: +0 steady state; +1 conditional (tie-breaker), tier-gated.

## Implementation hand-off notes

- Suitable for Opus (or Sonnet for the plumbing: list asset loading, Set lookups,
  bundle persistence). The name/blocklist *generation* is a cheap-model offline job.
- ⚠️ Verify with `npm run build` (tsc -b — stricter than tests alone), not just
  `npx vitest`. Lint changed files only; project-wide lint has ~93 pre-existing errors.
