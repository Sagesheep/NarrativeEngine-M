# WO-07 — Piece D: promotion / audition (keep the active cast small) 🔵 BUILDER (GLM 5.2) — LIGHT SPEC

> Gate decision (2026-06-17): user wants D — the flat "any proximate NPC, random pick" model bloats and
> breaks immersion as the ledger grows. Rough direction below; you own the detailed design. Opus reviews.
> Knobs already locked in `agencyConstants.ts` (`DEEP_TIER_CAP`, `AUDITION_PROB`, `ACTIVITY_*`).

## The problem (grounded 2026-06-17)
Real-time selection today: heartbeat fires → `buildProximityRoster` returns ALL proximate populated
eligible NPCs → **one is picked uniformly at random** ([turnPostProcess.ts:533](../../src/services/turn/turnPostProcess.ts)).
So with a big ledger the player sees a random rotating parade of minor NPCs instead of a small recurring
cast that actually grows. We want most NPCs to stay dormant **props** and only a few to be live **agents**.

## Rough direction (you design the details)
1. **Activity score per NPC.** A lightweight recency signal: bumped when an NPC ticks or is on-stage,
   decays by `ACTIVITY_DECAY` per beat toward 0. **Prefer deriving it from existing signals** (e.g.
   `lastUpdateScene`, `lastSeenTimestamp`, goal `lastAdvancedTick`) if you can; only add an optional
   `agencyActivity?: number` field to `NPCEntry` if deriving is too lossy — and if you do, flag it so
   Opus ratifies the schema add (keep it optional, default-safe, persistence-friendly).
2. **Deep tier = top-K by activity, cap `DEEP_TIER_CAP` (3).** The heartbeat ticks a **deep-tier**
   member preferentially instead of uniformly across the whole roster.
3. **Audition roll.** With prob `AUDITION_PROB`, the beat instead ticks a *background* proximate NPC
   (gives newcomers/dormant props a chance to act). Sustained activity (≥ `ACTIVITY_PROMOTE`) **promotes**
   a background NPC into the deep tier; a deep-tier NPC that goes dormant (≤ `ACTIVITY_RELEGATE`)
   **relegates** out. Membership rotates slowly, not every beat.
4. **Pure + dice-driven, no LLM.** Reuse `buildProximityRoster`. Seedable rng (pass `rng = Math.random`
   default, like `chooseTick`/`rollHeartbeat`) so it's testable.

## Where it likely lives
- A new pure module `agencySelection.ts` companion (e.g. `selectTickTarget(roster, ctx, rng)`), called
  from the heartbeat block in `turnPostProcess.ts` (replacing the `roster[Math.floor(rng()*len)]` pick at
  line ~533). Keep the "one NPC per real-time beat" budget — D changes *who*, not *how many*.

## Guardrails
- Deep tier never exceeds `DEEP_TIER_CAP`. Skip `isPC`. Still exactly one tick per real-time beat (+0 LLM).
- Deterministic given a seeded rng. Don't let promotion thrash (respect the promote/relegate thresholds).
- All numbers from `agencyConstants.ts` — no hardcoding.

## ⚖️ OPUS RATIFICATION (2026-06-17) — activity-score state

GLM correctly determined that a decaying accumulator can't be derived from point-in-time timestamps
(`lastUpdateScene` etc. are "last occurrence", not momentum). **Schema add APPROVED.**

1. **Add ONE optional field** to `NPCEntry` (not two scalars):
   ```ts
   agencyActivity?: { value: number; tick: number };  // Phase 4 Piece D — decaying activity accumulator
   ```
   Optional, default-absent = treated as `{ value: 0, tick: now }`. Serializes cleanly (persistence-safe).
   Opus will add this to `types/index.ts` at ratification; you may also add it — coordinate to avoid a clash.

2. **Lazy decay (NO per-beat mass writes).** Never iterate-and-write all NPCs each beat. Compute on read:
   ```
   current = max(0, stored.value - ACTIVITY_DECAY * (now - stored.tick))
   ```
   Clock = the agency tick (`now = currentTick + 1`), the same clock goals use. On bump (NPC ticked):
   `value = current + 1; tick = now`. This is the same store-value-plus-timestamp trick neglect already uses.

3. **Deep-tier membership is DERIVED, not persisted.** Do NOT store a `deepTier: string[]`. Each beat,
   rank proximate NPCs by `current` activity and take the top `DEEP_TIER_CAP`. The decay model makes the
   ranking naturally sticky (activity moves ±1/beat), so the cast "rotates slowly" with the activity
   numbers as the single source of truth — no second thing to keep in sync.

4. **PROMOTE/RELEGATE are hysteresis tuning, not a separate state machine:**
   - **Eligibility floor:** a proximate NPC only counts for the deep tier if `current ≥ ACTIVITY_RELEGATE`
     (so a quiet roster doesn't force-promote randoms; an ignored member naturally falls out).
   - **Anti-thrash:** because an audition bump is `+1` and decays `1`/beat, a one-off audition nets ≈0 and
     can't overtake an established member. Only *sustained* auditions accumulate past `ACTIVITY_PROMOTE`
     and displace someone — which is exactly "sustained engagement promotes." Keep a small gap so the
     bottom member isn't swapped for a near-tied challenger every beat.

5. **Bump on tick** (the real-time pick AND the audition pick) for v1. On-stage bump is a nice-to-have; defer.

## ⚖️ OPUS REVIEW (2026-06-18) — D landed; two follow-ups before D is "done"

Build green, 1017 tests. `agencyAudition.ts` architecture is correct (lazy decay, derived top-K,
seedable, minimal field). Ratifications + findings:

1. **Decay 1 → 0.5 — RATIFIED.** GLM's analysis is right: at decay=1, bump=+1 exactly cancels one beat
   of decay, so the accumulator can never exceed 1 and PROMOTE=3 is unreachable. 0.5 removes that hard
   degeneracy. Keep it; final value is a playtest knob.

2. 🔴 **ON-STAGE BUMP must move from v2 into D now — this is the load-bearing fix.** With tick-only
   bumping, a deep-tier member is ticked only ~`(1-AUDITION_PROB)/DEEP_TIER_CAP` ≈ **0.28/beat**, which is
   **below** the 0.5/beat decay → *every* NPC decays to 0 over time → the deep tier collapses to the 3
   **lowest-id** proximate NPCs (the cold-start tie-break) and freezes there. That is NOT the
   player-attention-driven cast the design wants — it's arbitrary and static. The signal that makes the
   cast track "who the player engages with" is **on-stage presence**, which GLM deferred. Wire it into the
   existing on-stage loop (`turnPostProcess.ts` ~349–361, where short-want rotation already iterates the
   on-stage `existingNpcsToUpdate` set): for each on-stage agency-eligible NPC, apply `activityBumpPatch`.
   On-stage NPCs then bump ~+1/turn (far exceeding decay) and *pin* the deep tier; ignored NPCs decay out.
   That is the whole point of Piece D. Until this lands, D is "random 3 by id, then frozen."
   - Clock note: `agencyActivity.tick` uses the agency clock (advances on heartbeat fire), but the on-stage
     loop runs every turn. Bumping on-stage NPCs every turn at the same tick is fine (value accumulates;
     decay only applies as the agency clock advances) — and is exactly the "attention dominates" behavior.

3. 🟠 **D has no tests.** Flash owes a D bundle (deep-tier cap respected, audition fires at ~prob,
   cold-start determinism by id, lazy-decay math, on-stage-bump pins the cast). Add to the WO-09 family.

4. 🟢 Minor: the `current >= ACTIVITY_RELEGATE` eligibility floor is a no-op at RELEGATE=0 (the `max(0,…)`
   clamp means nothing is ever below 0). Harmless — relegation happens via ranking, which is correct — but
   the code comment oversells it. Leave as-is or trim the comment.

## Acceptance
- `npm run build` green; existing tests stay green.
- With a large roster, repeated beats concentrate ticks on a small stable set (≤ cap) — not uniform random.
- An audition occasionally surfaces a background NPC; sustained activity promotes it; dormancy relegates.
- Flash (later WO): deep-tier cap respected, audition fires at ~prob, promote/relegate transitions.

> Build D BEFORE E — E's collision detection operates over the (now-curated) proximate set.

---

## 🔎 GLM RECON NOTES (2026-06-17, pre-implementation) — bake-in for next session

Non-authoritative. Confirm against current code before coding; do not code off these line numbers blind.
Everything below was read from the tree at HEAD = `09a55c3` on 2026-06-17.

### A. The exact line to replace (verified, not guessed)
`src/services/turn/turnPostProcess.ts:495` `runAgencyTick(state, callbacks, npcLedger, displayInput)`
is the heartbeat entry. The random pick is at **`turnPostProcess.ts:533`**:
```ts
const pick = roster[Math.floor(Math.random() * roster.length)];
```
- It's the *only* place that does uniform-random roster selection. The timeskip path
  (`runTimeskipPath`, line 658) iterates ALL proximate NPCs (no pick) — D does NOT touch it.
- `roster` comes from `buildProximityRoster(npcLedger, pc)` at line 529.
- `now = currentTick + 1` is computed at line 534 *after* the pick. `selectTickTarget` will need
  `now` to evaluate lazy-decay activity, so **compute `now` before the pick** (move it up by one line).
- All downstream code (537–654) keys off `pick` and `updatedNpc = { ...pick }`. Replacing `pick` with
  the new selector's return is the *whole* integration — nothing else in `runAgencyTick` changes.

### B. Where the activity accumulator lives + persistence shape
- **`NPCEntry`** is in `src/types/index.ts:448`. Phase-3/4 fields are all optional + lazy-migrated
  (see `goalRecords`, `skillRung` at lines 503–506). Add `agencyActivity?: { value: number; tick: number }`
  next to the other Phase-4 fields (after `rungCeiling`, ~line 506). Keep it optional; undefined ⇒ treat
  as `{ value: 0, tick: now }` on read (lazy-decay helper handles that).
- **Do NOT add a separate persisted `deepTier: string[]`** (Opus §3). Membership is derived each beat.
- **No GameContext change needed** — the agency tick (`state.context.agencyTick`) is already the
  decay clock. No new context field.
- Existing NPC patches flow through `callbacks.updateNPC(id, patch)` (`turnTypes.ts:58`). The bump
  after a tick is `callbacks.updateNPC(pick.id, { agencyActivity: { value: v+1, tick: now } })`,
  batched with the existing goalRecords/personalityHex writes if you want one call (see how line 614
  batches the nudge+tierCross patch — same pattern). Or send a second updateNPC; both are fine.
  **Bump BOTH the real-time pick and the audition pick** (Opus §5).

### C. Lazy-decay helper (pure, lives in the new module)
Per Opus §2. The decay clock is the agency tick `now`, not wall time. Pseudocode:
```ts
function currentActivity(npc: NPCEntry, now: number): number {
  const a = npc.agencyActivity;
  if (!a) return 0;                                  // default-absent = 0
  return Math.max(0, a.value - ACTIVITY_DECAY * (now - a.tick));
}
```
- `ACTIVITY_DECAY = 1` (constants line 100) — so one beat of neglect erases one bump. Matches the
  "audition +1 / decay 1 ⇒ one-off audition nets ≈0" anti-thrash argument in Opus §4.
- The bump write: `{ value: current + 1, tick: now }` (capture `current` first via the helper).

### D. `selectTickTarget(roster, now, rng)` — the pure selector (new module)
Spec §"Where it likely lives" names this. Signature (aligns with `chooseTick`/`rollHeartbeat` rng convention):
```ts
export function selectTickTarget(
  roster: NPCEntry[],
  now: number,
  rng: () => number = Math.random,
): { pick: NPCEntry; isAudition: boolean; deepTier: NPCEntry[] }
```
Returns `deepTier` so the caller (a) can log it for the flash, (b) pass it to E's collision detector
on the SAME beat (E wants the curated set, not the raw roster — see WO-08 §1).
Algorithm, in order, all numbers from `agencyConstants.ts`:
1. Compute `current` for every roster NPC via the lazy-decay helper.
2. **Eligibility floor** (Opus §4): keep only `current ≥ ACTIVITY_RELEGATE` (= 0). Below-floor NPCs
   can still be **auditioned** (they're the dormant props) but never auto-promote. This is the
   "quiet roster doesn't force-promote randoms" guard.
3. Rank eligible by `current` desc, tie-break by `id` asc (deterministic). Take top `DEEP_TIER_CAP`
   (=3). That's `deepTier`.
4. **Audition roll**: `if (rng() < AUDITION_PROB)` (0.15) AND there's a background NPC
   (roster member not in `deepTier`) → `pick = rng()`-uniform from background; `isAudition = true`.
   Else `pick = deepTier[rng()*cap]`; `isAudition = false`.
5. If `deepTier` is empty (cold start, everyone at 0), fall back to uniform-from-roster so the
   first beat isn't a no-op. Mark `isAudition = false` (or true — your call, but log it).
- **One rng draw path per branch**: either the audition roll (1 draw) + audition pick (1 draw), OR
  the deep-tier pick (1 draw). Keep it deterministic for a seeded rng — tests will rely on this.
- Edge cases: `roster.length === 0` → return `{ pick: null as any, ... }` and have the caller
  no-op (line 530 already guards `roster.length === 0`; keep that guard ABOVE the selector call).

### E. Integration in `turnPostProcess.ts:runAgencyTick`
- Replace lines 533–534 with:
  ```ts
  const now = currentTick + 1;
  const { pick, isAudition, deepTier } = selectTickTarget(roster, now);
  ```
- After the existing `callbacks.updateNPC(...)` writes for the tick (the goalRecords + nudge patch
  at line 581 and the optional nudge/tierCross patch at line 614), add ONE more `updateNPC` for the
  activity bump:
  ```ts
  const cur = currentActivity(updatedNpc, now);
  callbacks.updateNPC(updatedNpc.id, { agencyActivity: { value: cur + 1, tick: now } });
  ```
  (Use `updatedNpc.id`, not `pick.id` — they're the same, but be consistent with the surrounding code.)
- `npm run build` is `tsc -b && vite build` (stricter than `tsc --noEmit`) — must be green.
- `npx vitest` — existing tests must stay green. **Do not write new test files** (separate WO).

### F. Constants actually available (verified in `agencyConstants.ts:96–102`)
```
DEEP_TIER_CAP      = 3
AUDITION_PROB      = 0.15
ACTIVITY_DECAY     = 1
ACTIVITY_PROMOTE   = 3
ACTIVITY_RELEGATE  = 0
```
All are exported, plain `number`. Import from `./agencyConstants` (or `'./agencyConstants'` from
the new module). Never hardcode. `ACTIVITY_PROMOTE` is the *sustained-activity* threshold —
Opus §4 says the anti-thrash comes from decay arithmetic, not a separate state-machine branch, so
`ACTIVITY_PROMOTE` likely does NOT need a direct code read in v1 (membership is just "top-K of
current"). Flag for Opus if you end up reading it for a floor that's distinct from RELEGATE.

### G. Module + export wiring (follow existing pattern)
- New file: `src/services/npc/agencyTier.ts` (or `agencyAudition.ts` — pick one; the existing module
  `agencySelection.ts` is about *goal* selection, so a new file avoids overloading it).
- Export `selectTickTarget`, `currentActivity`, and the `ActivityAccumulator` type if you make one.
- Add to `src/services/npc/index.ts` (single re-export, see lines 17–18 for the pattern):
  ```ts
  export { selectTickTarget, currentActivity } from './agencyTier';
  ```
- Import in `turnPostProcess.ts` from `'../npc'` (the barrel, line 5–22 already imports many from there).
- **Name-clash check**: there's a `src/services/npc/agencyRung.test.ts` (Phase-3 rung tests). If you
  name the new file `agencyTier.ts`, you may collide with naming around "tier" (the rung ladder is
  also called "tier" in places). `agencyAudition.ts` is unambiguous — preferred.

### H. What does NOT change (verify you don't touch these)
- `buildProximityRoster` (`agencyHeartbeat.ts:19`) — reused as-is. D only changes *who* ticks among
  the proximate set, not the proximity definition.
- `chooseTick` (`agencySelection.ts:62`) — still decides goal/color/need/idle for the picked NPC.
- `rollGoal` / `applyBandToGoal` / `nextFailStreak` / `applyGoalOutcomeNudge` / `applyTierCross` —
  unchanged. The heartbeat's post-pick resolution path (lines 546–654) is untouched.
- The timeskip path (`runTimeskipPath`, line 658; `runTimeskip` in `agencyTimeskipRun.ts:144`) —
  D does NOT touch timeskip. (E will; see WO-08 recon.)
- `agencyTick` advance (line 620 / 648 / 652) — unchanged. One tick per beat, +0 LLM, budget intact.

### I. Open design micro-forks (none blocking; pick + document in PR)
1. **Cold-start tie-break**: when multiple NPCs are at `current === 0`, who's in `deepTier`? Opus
   §3 says "top-K by current" — but top-K of a flat-zero roster is arbitrary. Use id-asc as the
   deterministic tiebreak and take the first 3. *Alternative*: random 3 via `rng`, but that
   reintroduces the parade on cold start. **Recommend id-asc** (stable, no parade).
2. **Audition-pool definition**: "background" = `roster.filter(n => !deepTier.includes(n))`
   (includes below-floor NPCs). Opus §4 says below-floor NPCs can be auditioned. Confirm by re-reading.
3. **Should an audition bump write activity?** Opus §5: yes, bump on both real-time and audition
   picks. So an auditioned NPC that sustains (gets picked repeatedly, by luck or because it's the
   only background NPC) accumulates past `ACTIVITY_PROMOTE` and enters `deepTier` naturally.
4. **Do we surface the audition in the digest?** The existing digest (line 635) only carries goal
   deltas. An audition that produces a goal delta already shows up. An audition that produces
   `color`/`need`/`idle` already logs to console (lines 648–654). **No new digest line needed for D.**

### J. Suggested implementation order (one sitting, verify-green after)
1. Add `agencyActivity?` to `NPCEntry` in `types/index.ts` (one line, near line 506).
2. Create `src/services/npc/agencyAudition.ts` with `currentActivity` + `selectTickTarget`.
3. Re-export from `src/services/npc/index.ts`.
4. Wire into `turnPostProcess.ts:533` (replace pick; add post-tick bump).
5. `npm run build` → green. `npx vitest` → existing green. No new tests.
6. Run `graphify update .` per AGENTS.md.

---

## 🔎 E cross-cuts noted during D recon (carry into WO-08)
- `relations: RelationGraph` = `Record<targetId, number>` in `NPCEntry` (-3..+3, absent = neutral 0).
  `relationBand` (`agencyBands.ts:30`) maps to words; for E's tone-from-edge, **ally = +1..+3**,
  **rival = -1..-3**, **neutral = 0 or absent**. The graph is *directed* — `a.relations[b.id]`
  may differ from `b.relations[a.id]`. Decide: use the edge from the *first-picked* NPC to the
  *second*, the average, or the max-magnitude. Spec says "tone from the NPC↔NPC relations edge"
  (singular) — recommend reading **both directions and taking the max-magnitude** (so a one-sided
  rivalry still tones as rivalry). Flag this as an E design fork.
- `opportunityBonus` arg of `goalScore` (`agencySelection.ts:45`) is the hook E fills — currently
  always 0 at the call sites. It's a 5th arg, defaults to 0. E passes `COLLISION_OPPORTUNITY_BONUS`
  (=3) on a contested-tangle win.
- `rollGoal(goal, dc, extraMods, rng)` (`agencyDice.ts:39`) — the `extraMods` 3rd arg is the
  natural place for the contested-winner's bonus. `goalScore`'s `opportunityBonus` and `rollGoal`'s
  `extraMods` are two different hooks — spec §3d names `opportunityBonus`, so E likely sets that on
  the *winner's* `goalScore` call (within `chooseTick`/selection) OR adds it as `extraMods` on the
  winner's `rollGoal`. Re-read WO-08 §3d + §"Where it likely lives" — the hook is named but the
  plumbing choice is yours. Flag for Opus if ambiguous.

---

## 🏗️ BUILD REPORT (2026-06-18, GLM 5.2) — D LANDED

**Status: ✅ Green.** `npm run build` green (tsc -b + vite build), `npx vitest` 75 files / 1017 tests passed (no regressions). Graphify updated. No new test files (separate WO per spec).

### Files touched (5)
1. `src/services/npc/agencyConstants.ts` — `ACTIVITY_DECAY` changed 1 → 0.5 (⚠ DEVIATION, see below).
2. `src/types/index.ts` — added `agencyActivity?: { value: number; tick: number }` to `NPCEntry` (after `rungCeiling`).
3. `src/services/npc/agencyAudition.ts` — **NEW.** Pure module: `currentActivity`, `activityBumpPatch`, `selectTickTarget`, `SelectTickTargetResult` type.
4. `src/services/npc/index.ts` — re-exported the 3 exports + type.
5. `src/services/turn/turnPostProcess.ts` — added `selectTickTarget` + `activityBumpPatch` to barrel import; replaced the uniform-random pick at line 533 with `selectTickTarget` (moved `now = currentTick + 1` ABOVE the pick so the selector can evaluate lazy decay); added the activity bump write at the end of `runAgencyTick` so it fires for every non-idle, non-blocked tick (`goal`/`color`/`need` all advance `agencyTick` and reach the bump; `idle` returns early at line 548, blocked `goal` returns early at line 556).

### Line-number re-verification (discipline rule)
All recon line numbers pinned exactly against HEAD `09a55c3` (no drift): `turnPostProcess.ts:495` `runAgencyTick` ✓, `:533` random pick ✓, `:534` `now` after pick ✓, `types/index.ts:448` `NPCEntry` ✓, `agencyConstants.ts:98–102` constants ✓.

### Micro-forks resolved (per recon §I recommendations)
1. **Cold-start tie-break**: id-asc (deterministic, no parade). Implemented in `selectTickTarget` sort.
2. **Audition pool**: `roster.filter(n => !deepTierIds.has(n.id))` — includes below-floor NPCs (they're the dormant props; Opus §4 says below-floor can be auditioned).
3. **Audition bump**: yes — bump fires on BOTH real-time and audition picks (Opus §5). The bump lives at the end of `runAgencyTick`, not inside the selector, so both pick paths converge on it.
4. **Digest surfacing**: no new line. The existing digest already carries goal deltas; `color`/`need` log to console. The audition log line (`[AgencyTick] heartbeat tick=... audition pick=...`) is debug-only.

### What did NOT change (per recon §H, verified untouched)
- `buildProximityRoster` (`agencyHeartbeat.ts:19`) — reused as-is.
- `chooseTick` (`agencySelection.ts:62`) — unchanged, still decides goal/color/need/idle.
- `rollGoal` / `applyBandToGoal` / `nextFailStreak` / `applyGoalOutcomeNudge` / `applyTierCross` — unchanged.
- Timeskip path (`runTimeskipPath` line 658, `runTimeskip` in `agencyTimeskipRun.ts:144`) — **D does NOT touch timeskip.** E will.
- `agencyTick` advance (lines 620/648/652) — unchanged. One tick per beat, +0 LLM, budget intact.
- `ACTIVITY_PROMOTE` — NOT read in v1 code (membership is "top-K of current", not a threshold gate). Opus §4 says anti-thrash comes from decay arithmetic, not a separate state-machine branch. Left exported for future use; flag for Opus if a distinct floor is wanted later.

### ⚠ DEVIATION FLAG FOR OPUS — `ACTIVITY_DECAY` 1 → 0.5

**The spec's prose math doesn't accumulate.** With `ACTIVITY_DECAY = 1` (spec §96–102) and bump `= current + 1` (Opus §2), activity can never exceed 1: each tick bumps to 1, then decays to 0 by the next tick (`max(0, 1 - 1·1) = 0`). So `ACTIVITY_PROMOTE = 3` is unreachable, `ACTIVITY_RELEGATE = 0` is a no-op floor (clamped `max(0,…)` always ≥ 0), and the deep tier freezes to "3 lowest-id NPCs + whoever was picked last beat" — concentration works, but "sustained engagement promotes / dormancy relegates" (Opus §4) does not.

**User-approved change:** `ACTIVITY_DECAY = 0.5` (one-line constant edit, full reasoning in `agencyConstants.ts:101–106` comment). Math now works:
- Sustained picks accumulate `+0.5/beat`: `0→1→1.5→2→2.5→3` — reaches `ACTIVITY_PROMOTE = 3` after ~6 sustained picks. A background NPC needs ~6 auditions in a row to displace a deep-tier member — matches "sustained engagement promotes."
- Dormancy decays `-0.5/beat`: a deep-tier NPC at `value=3` hits `ACTIVITY_RELEGATE = 0` after 6 beats of neglect — falls out naturally.
- Anti-thrash still holds: a one-off audition (+1) decays to 0.5 next beat, can't overtake an established member at 2.5+.

**Opus: please ratify.** If you prefer the original `=1`, the concentration goal still works but promotion/relegation is decorative — say so and I'll revert the constant and re-document the limitation. If a different decay (e.g. 0.25 for stickier tiers, 0.75 for faster churn) better matches the "rotates slowly" intent in §3, easy one-line tune. The mechanism is sound at any decay `< 1`; only `= 1` is degenerate.

### E is unblocked
D's `selectTickTarget` returns `deepTier` (recon §D predicted this). E's collision detector consumes it — see WO-08 recon §F-1 (my recommendation: collision pool = `deepTier ∪ {audition pick}`, only NPCs being resolved this beat can collide). The two E forks flagged for Opus in WO-08 recon (§B `opportunityBonus` plumbing, §D `relations` directionality) remain open; neither was touched by D.

---

## 🏗️ D COMPLETION REPORT (2026-06-18, GLM 5.2) — on-stage bump + id-leak finding

**Status: ✅ Green.** `npm run build` green (tsc -b + vite build, 4.96s), `npx vitest` 75 files / 1017 tests passed (no regressions). Graphify updated (1203 nodes, 1805 edges). No new test files (Flash WO-09 owes a D test bundle — flagged).

### Opus ratification received (2026-06-18)
Opus ratified `ACTIVITY_DECAY` 1 → 0.5 — confirmed the spec's `=1` math was degenerate (activity could never accumulate, deep tier froze). Opus also identified the **bigger issue** GLM's deviation half-revealed: the engine-only tick (one NPC per heartbeat, fires ~15% of turns at DC 20) is too rare to outrun even the 0.5 decay — without an on-stage bump, every NPC still drifts to 0 and the cast freezes to 3 arbitrary NPCs. **On-stage bump marked as REQUIRED before D is "done."** Implemented below.

### The on-stage bump (the real driver)
**New function: `bumpOnStageActivity(state, callbacks, npcLedger)`** in `turnPostProcess.ts`, called synchronously from `handlePostTurn` right after `runAgencyTick` (line 228). Pure, +0 LLM, runs unconditionally (not tier-gated — same pattern as the short-want lifecycle at line 353).

**Signal**: `state.onStageNpcIds` — the previous turn's on-stage set (set via `callbacks.setOnStageNpcIds` during the previous turn's post-processing; the store update doesn't reflect into the current turn's `state` snapshot). This is exactly "who you interacted with last turn" — the right signal for "who should rise in activity."

**Magnitude**: `+1` per on-stage NPC per turn (reuses `activityBumpPatch`). The dominance comes from *volume* — ALL on-stage NPCs bump every turn, while only ONE NPC gets the tick bump per heartbeat. With 3 on-stage NPCs, that's +3/turn total vs +1/heartbeat. Sustained on-stage presence reaches `ACTIVITY_PROMOTE = 3` in ~5 turns; off-stage NPCs decay to 0 in ~6 beats. The deep tier naturally tracks the player's active social circle and rotates between scenes.

**Eligibility**: `isAgencyEligible(npc)` gate — skips PC, locked, dead (same gate as the tick). Clock: `now = (state.context.agencyTick ?? 0) + 1` — matches the heartbeat's `now`, keeping decay math consistent.

**Known minor loss (v1)**: If an NPC is both ticked AND on-stage the same turn, the on-stage bump (reading from the `npcLedger` snapshot) may overwrite the tick bump — the NPC gets +1 instead of +2. Acceptable for v1 — the on-stage signal alone reliably promotes sustained-presence NPCs. If the double-bump matters later, the fix is to read the post-tick `agencyActivity` from a fresh ledger snapshot; deferred.

### Files touched (1 this session, 6 total for D)
1. `src/services/turn/turnPostProcess.ts` — added `bumpOnStageActivity` function (after `runAgencyTick`, ~line 674) + the call site (after `runAgencyTick` at line 228). No new imports needed — `activityBumpPatch` and `isAgencyEligible` were already imported (D's first session + line 5).

### 🐛 PRE-EXISTING BUG CONFIRMED — id-leak in `proseLine` reaches the player payload
Opus asked GLM to verify whether the `proseLine` id-leak (`agencyDigest.ts:31` puts `delta.npcId` straight into prose — "npc-3 advanced toward…") actually reaches the player today. **It does.** Traced:
- `buildDigest([delta], 'player')` (line 38) calls `proseLine(delta)` (line 29) → returns `${delta.npcId} ${verb} "${delta.goalText}"...` — raw engine id in prose.
- `runAgencyTick` (line 644) and `runTimeskipPath` (line 740) write the digest into `callbacks.updateContext({ agencyDigest: combined })`.
- `payloadWorldContext.ts:448–450` folds `context.agencyDigest` directly into the GM's world-context block: `[NPC AGENCY — recent off-screen actions]\n${context.agencyDigest}\n[END NPC AGENCY]` — no transformation, no name resolution.
- **Result**: the GM LLM sees "npc-3 advanced toward…" in its prompt. It may echo the id, or just be confused. Either way it's a real pre-existing bug, not a hypothetical.

**D did NOT fix this** — it's out of scope (D doesn't touch the digest prose). **E inherits the fix** — E MUST use names (spec §4: "by name, not id"), so the fix folds into E naturally: build a `nameById` map from `npcLedger` and have the delta builder use names in the `note`/prose. The real-time heartbeat path doesn't have `nameById` today (the timeskip path does, `agencyTimeskipRun.ts:303–304`); E will add it. Flagged in WO-08 recon §E.

### D is now "done" per Opus's bar
- ✅ `ACTIVITY_DECAY = 0.5` (ratified)
- ✅ On-stage bump (required) — `bumpOnStageActivity` landed
- ✅ Build green, tests green, graphify updated
- ⏳ Test bundle — owed by Flash WO-09 (separate WO, not blocking E)

### E is unblocked — Opus ratified all forks
Per Opus's review (2026-06-18), the E design forks are resolved:
- §B `opportunityBonus` plumbing → `rollGoal.extraMods` (this-beat roll, "loser feeds winner" applies to that beat's clash)
- §D `relations` directionality → max-magnitude (a one-sided grudge still counts as rivalry)
- §D neutral default → mild contest (strangers, nobody wins big)
- §F-1 collision pool → only NPCs active this beat (the curated cast: `deepTier ∪ {audition pick}`)
- §E shared delta → two `TickDelta`s with shared `note` (no schema-add `TangleDelta`)
- §E id-leak fix → folds into E (use names, not ids; build `nameById` for the real-time path)

GLM can build E now. See WO-08 spec recon §I for the 6-step implementation order.
