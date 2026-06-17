# WO-08 — Piece E: event collisions IN PLAYER PROXIMITY 🔵 BUILDER (GLM 5.2) — LIGHT SPEC

> Gate decision (2026-06-17): user wants E, **reframed**. Depends on WO-07 (D). Rough direction; you own
> the design. Opus reviews. Knobs locked: `COLLISION_TANGLE_PROB`, `COLLISION_OPPORTUNITY_BONUS`.

## The reframe (important — not what the original 00_PLAN said)
E is **NOT** autonomous off-screen NPC-vs-NPC life. It is: when two NPCs **in the player's proximity**
are pursuing **coinciding goals**, their *events can tangle* into ONE shared beat the player witnesses.
Scope is strictly proximity-gated — collisions only happen near the player, on the beats they'd already
see. Today the hook exists but is inert: `opportunityBonus` in `goalScore` is always 0
([agencySelection.ts:45](../../src/services/npc/agencySelection.ts)).

## Rough direction (you design the details)
1. **Detect coincidence among PROXIMATE NPCs** (the roster from WO-07 — never the whole ledger). Two
   NPCs "coincide" when their chosen/top goal shares a target: same `region`, or overlapping want/goal
   text (a cheap keyword/normalized match is fine — no LLM, no embeddings). Keep it to **two at a time**.
2. **Roll solo vs. tangled** at `COLLISION_TANGLE_PROB`. If solo, behave exactly as today (no change).
3. **If tangled, tone from the NPC↔NPC `relations` edge:**
   - allies → **cooperate** (both advance / a shared win),
   - rivals → **contest** (contested roll; the loser's failure feeds the winner via `COLLISION_OPPORTUNITY_BONUS` → `opportunityBonus`, §3d),
   - neutral / no edge → mild contest or ego-overreach (pick a sensible default).
4. **Emit ONE shared delta**, not two independent ones — a single beat naming both NPCs (by name, not id),
   routed through the existing digest / timeskip narration (+0 LLM; no new call).

## Where it likely lives
- A pure detector + resolver (e.g. `detectCollision(roster, ...)` / `resolveCollision(a, b, relations, rng)`)
  in the agency layer. Wire into:
  - **real-time** heartbeat beat (`turnPostProcess.ts`): when the picked NPC's goal coincides with another
    proximate NPC's top goal → tangle, adjust the resolution, push a shared delta.
  - **timeskip** (`agencyTimeskipRun.ts`): among the ticked proximate set, detect coinciding pairs → tangle.
- Feed the contested outcome through the existing `opportunityBonus` arg of `goalScore` / a contested roll;
  reuse the Phase-3 dice + band machinery (`rollGoal`, `bandFromMargin`).

## Guardrails
- **Proximity-only.** Never fire for NPCs outside the roster. Two NPCs per collision, max.
- One shared delta out; no double-counting. No raw engine number reaches the payload — word-bands/digest only.
- Pure + seedable rng. All numbers from `agencyConstants.ts`. Skip `isPC`. Budget stays +0 / timeskip +1.

## Acceptance
- `npm run build` green; existing tests stay green.
- Two proximate NPCs with a coinciding goal sometimes tangle (at ~`COLLISION_TANGLE_PROB`); allies
  cooperate, rivals contest with the loser feeding the winner; the player sees ONE combined beat.
- NPCs outside proximity never collide.
- Flash (later WO): coincidence detection, tangle/solo roll, ally-vs-rival tone, single-shared-delta,
  proximity exclusion.

---

## 🔎 GLM RECON NOTES (2026-06-17, pre-implementation) — bake-in for next session

Non-authoritative. Confirm against current code before coding; line numbers from HEAD `09a55c3`.
D must land first (WO-08 §"Build D BEFORE E"); D's `selectTickTarget` returns the curated `deepTier`
which is the natural input to E's detector (see D recon §D — `selectTickTarget` returns `deepTier`).

### A. The two integration sites (verified)
1. **Real-time heartbeat** — `turnPostProcess.ts:495` `runAgencyTick`. After D lands, the pick is at
   ~line 533 (`selectTickTarget(...)`). E wraps *around* the pick:
   - After `selectTickTarget` returns `pick` + `deepTier`, E looks for a coinciding partner inside
     `deepTier` (or `roster` — your call; see fork §F-1) whose top/chosen goal shares a target with
     `pick`'s chosen goal.
   - If found AND `rng() < COLLISION_TANGLE_PROB` → tangle. Resolve both NPCs' goals in ONE beat:
     ally → both advance (cooperate); rival → contested roll, loser feeds winner via the
     `opportunityBonus` hook. Emit ONE shared delta naming both NPC **names**.
   - Else → solo, today's path unchanged.
   - The post-pick resolution block (lines 546–654) is mostly reusable but needs a "tangle" branch:
     resolve a *pair* instead of one. Easiest is a new `resolveTangle(a, b, ...)` helper that the
     heartbeat calls *instead of* the single-NPC path when a collision is detected.
2. **Timeskip** — `agencyTimeskipRun.ts:144` `runTimeskip`. Today it iterates ALL proximate NPCs
   (line 161) and allocates ticks per NPC independently (line 171). E's wiring: among the ticked
   proximate set, detect coinciding pairs → tangle (one shared delta, not two). The per-NPC loop
   (lines 161–286) is where pairs are found; you'll likely add a pairwise pass after the loop, or
     fold detection into the loop. **Budget unchanged: timeskip stays +1 LLM** (the narration call
     at `turnPostProcess.ts:737`). E adds zero LLM calls.

### B. The `opportunityBonus` hook (the inert one E fills)
- **`goalScore(goal, now, hexDrive, sceneStakes, opportunityBonus = 0)`** — `agencySelection.ts:40–51`.
  5th arg, defaults to 0. Today every call site passes nothing (so it's 0). E passes
  `COLLISION_OPPORTUNITY_BONUS` (=3) on a **contested-tangle winner**.
- **`rollGoal(goal, dc, extraMods = 0, rng)`** — `agencyDice.ts:39`. 3rd arg, defaults to 0. This is
  the *other* hook for injecting a contested bonus — directly into the d20 roll, before `bandFromMargin`.
- **Spec names `opportunityBonus`** (§3d) but `goalScore`'s `opportunityBonus` only affects *selection*
  (which goal is hottest — `chooseTick`), NOT the roll. To feed the winner on a contested success,
  you need `rollGoal(goal, GOAL_BASE_DC, COLLISION_OPPORTUNITY_BONUS, rng)` — the `extraMods` path.
  **Design fork (flag for Opus):** is `COLLISION_OPPORTUNITY_BONUS` meant to go into `goalScore`
  (selection heat, so the tangled goal is *more likely to be chosen* next time) OR into `rollGoal`
  (the contested roll itself, so the winner's success band improves *this beat*)? Spec §3d says
  "loser's failure feeds the winner via `opportunityBonus`" — that reads as "this beat's roll", so
  `rollGoal`'s `extraMods` is the right plumbing. But the *name* matches `goalScore`'s arg.
  **Recommendation:** `rollGoal` `extraMods` for the contested roll (this beat), and optionally also
  `goalScore` `opportunityBonus` (future selection heat). Ask Opus to ratify which.

### C. Coincidence detection (cheap, no LLM, no embeddings — spec §1)
Two NPCs "coincide" when their chosen/top goal shares a target. Cheap signals available:
- **`npc.region`** (string, e.g. `'academy'`, `'Ryuten'`) — same region is a strong coincidence
  signal. Already used by `buildProximityRoster` (`agencyHeartbeat.ts:39`).
- **`goal.text`** — normalized keyword overlap. Normalize: lowercase, strip punctuation, split on
  whitespace, drop a small stoplist (`the`, `a`, `to`, `and`, `of`, ...), check for shared
  non-stopword tokens. **No embeddings, no LLM.** Two NPCs share a target if they share ≥1
  non-trivial keyword OR have the same region.
- **Goal target matching is on `goal.text` only** — the only payload-visible field (types/index.ts:413).
  Don't use `goal.horizon`/`progress`/etc. for coincidence (those are engine-internal).
- **Two at a time max.** If `pick` coincides with multiple partners, pick ONE partner
  deterministically (e.g. highest `relations` magnitude with `pick`, tie-break `id` asc). Never 3+.

### D. Tone from the NPC↔NPC `relations` edge
- **`npc.relations: RelationGraph`** = `Record<targetId, number>` (`types/index.ts:427`), sparse
  directed, -3..+3, absent key = Neutral (0).
- **`relationBand(v)`** (`agencyBands.ts:30`) maps to words: `[-3..+3]` →
  `[Arch-enemy, Hostile, Cold, Neutral, Friendly, Close, Devoted]`. For tone:
  - **ally** = `>= +1` (Friendly/Close/Devoted)
  - **rival** = `<= -1` (Cold/Hostile/Arch-enemy)
  - **neutral** = `0` or absent key
- **Directed-edge fork (flag for Opus):** `a.relations[b.id]` may differ from `b.relations[a.id]`.
  Spec says "the NPC↔NPC relations edge" (singular). Options:
  1. Read from `pick` → partner (the picked NPC's stance toward the partner).
  2. Read from partner → `pick` (the partner's stance toward the picked NPC).
  3. Max-magnitude of the two directions (a one-sided rivalry still tones as rivalry).
  4. Average + round (a +2/-2 relationship tones neutral — probably wrong).
  **Recommendation: max-magnitude** (option 3) — a one-sided rivalry is still a rivalry. Ask Opus.
- **Neutral / no edge default** (spec §3 bullet 3): "mild contest or ego-overreach." Pick one and
  document. **Recommendation: mild contest** (both roll, higher margin wins, the loser doesn't feed
  the winner — no `opportunityBonus`). Ego-overreach is a flavor-text choice; without LLM, the
  text would be a canned word-band — mild contest is mechanically cleaner.

### E. The single shared delta (ONE beat, both NPC names, no ids, no engine numbers)
- **`TickDelta`** (`agencyDigest.ts:5`): `{ npcId, goalText, horizon, band, visibility, note }`.
  It's *one NPC per delta*. For a tangle, you need a **shared-delta shape** — either:
  1. Extend `TickDelta` with optional `partnerId?: string` + `tangle?: 'cooperate' | 'contest'`
     (schema add — flag for Opus ratification), OR
  2. Emit two `TickDelta`s with a shared `note` that names the partner (e.g.
     `note: 'with Bryn (rival): contested, won'`) and let `buildDigest` render them. The digest
     caps at `DIGEST_PLAYER_CAP = 3` (`agencyConstants.ts:74`) — a tangle producing 2 deltas eats
     2/3 of the cap. Probably fine. **No schema add, simpler.** **Recommendation: option 2**
     unless Opus prefers a first-class `TangleDelta`.
- **Names, not ids**: `agencyDigest.ts:31` `proseLine` already uses `delta.npcId` directly in the
  prose (!). That's an existing bug-quality issue — the digest shows the internal id, not the name.
  For E's shared beat, you MUST use names (spec §4). The timeskip path already has `nameById`
  (`agencyTimeskipRun.ts:303–304`) and uses it in `buildReturnBeatGrounding`. The real-time
  heartbeat path does NOT have a nameById today — you'll need to build one from `npcLedger` in
  `runAgencyTick` and pass it into the delta builder. Flag this if `proseLine`'s id-leak surprises Opus.
- **No raw engine numbers in the payload** — bands (`critSuccess`, `success`, etc.) and names only.
  `buildDigest` already does this for solo deltas; E's shared delta must too.

### F. Open design forks (none blocking; pick + document, flag for Opus if uncertain)
1. **Collision-pool scope**: detect coincidence among `deepTier` (D's curated 3) or the full
   `roster` (all proximate)? Spec §1 says "the roster from WO-07" which is the full proximate set,
   but D's whole point is that the `deepTier` is who *ticks*. A collision needs both NPCs to
   actually be *ticking this beat*. **Recommendation: `deepTier` ∪ {audition pick}** — only NPCs
   being resolved this beat can collide. Re-read WO-08 §1 + §"Where it likely lives" to confirm.
2. **Cooperate vs contest outcome (ally)**: spec says "both advance / a shared win." Cleanest: roll
   once, share the band — both NPCs' goals get `applyBandToGoal` with the same `band`. The
   `progressDelta` (`agencyProgress.ts:8`) is per-goal so both advance by the same delta. One
   `TickDelta` per NPC (two deltas total), one shared `note` line naming the partner. **No
   `opportunityBonus`** on cooperate (ally doesn't feed on ally).
3. **Contest resolution (rival)**: both roll `rollGoal` with their own karma; higher `margin` wins.
   Loser's band = the worse of the two (or `fail` minimum); winner gets `COLLISION_OPPORTUNITY_BONUS`
   as `rollGoal` `extraMods` (per §B recommendation). Loser's `failStreak` increments via
   `nextFailStreak`; winner's resets. One `TickDelta` each, shared `note`.
4. **Timeskip collisions**: spec §"Where it likely lives" names `runTimeskip` as a second site. In
   timeskip, multiple ticks happen per NPC (line 179–282). Do you detect collisions *per tick*
   (pair up the tick allocation across NPCs at each tick index) or *once* at the start (pair up
   NPCs that share a goal, then resolve their allocations jointly)? **Recommendation: once at the
   start of the timeskip** — detect coinciding pairs among the roster, and if a pair coincides,
   merge their tick allocations into a single shared sequence (one fewer LLM-budget tick total).
   Simpler, fewer moving parts, no double-counting. Flag for Opus.
5. **What if the partner's top goal is blocked by stakes** (`contextAllow === 0`)? The partner's
   goal can't roll today. In a tangle, does the tangle fizzle (solo) or does the partner join with
   a forced `fail` band? **Recommendation: fizzle → solo** (don't tangle into a blocked goal).
   Matches the existing hard-gate behavior (`turnPostProcess.ts:552–556`).

### ⚖️ OPUS RATIFICATION (2026-06-18) — E forks resolved. GLM's recon is sound; rulings:

- **Collision pool (§F-1):** **deepTier ∪ {audition pick}** — only NPCs actually resolving this beat can
  collide. (Affirms GLM.) Detect over the curated active set, not the whole roster.
- **`opportunityBonus` plumbing (§B):** use **`rollGoal`'s `extraMods`** = `COLLISION_OPPORTUNITY_BONUS`
  on the contested-tangle **winner this beat**. Spec §3d "loser's failure feeds the winner" is a
  *this-beat* effect, so it belongs in the roll, not selection heat. **Do NOT also touch `goalScore`** for
  v1 (one mechanism; the name match to `goalScore.opportunityBonus` is cosmetic — ignore it).
- **Relations direction (§D):** **max-magnitude** of the two directed edges — a one-sided rivalry is still
  a rivalry. (Affirms GLM option 3.) ally = ≥+1, rival = ≤−1, else neutral.
- **Neutral default (§D / §F):** **mild contest** — both roll, higher margin wins, **no** `opportunityBonus`
  feed (no one "wins big" off a neutral). (Affirms GLM.)
- **Shared delta (§E) — ONE delta. FINAL (shipped 2026-06-18, Opus fix).** `buildTangleDeltas` returns a
  **single-element `TickDelta[]`** (kept array-typed so `buildDigest` callers are unchanged). The surfaced
  delta **leads with the higher-visibility side** (`visibilityFromBand` rank direct>report>hidden; exact
  tie → `a`/the pick), so a dramatic clash always shows even when the pick is the one who lost quietly.
  Its `note` names the partner via `toneWord` (`cooperating with` / `contesting` / `crossing paths with`).
  Both NPCs' goals STILL update mechanically in the caller (`applyBandToGoal`/`nextFailStreak`) — this
  controls surfacing only. One `npcName` field was added to `TickDelta` for the id-leak fix (accepted).
  **WO-09 must assert ONE delta per tangle, from the higher-visibility side.** (GLM's first pass emitted
  two deltas; corrected to honor the §4 "one shared beat" rule.)
- **Cooperate/contest mechanics (§F-2/§F-3):** affirmed as written — shared band on cooperate; dual roll,
  higher margin wins, winner gets the `extraMods` bonus, loser's `failStreak` increments on contest.
- **Timeskip (§F-4):** detect coinciding pairs **once at the start**, merge their allocations. (Affirms GLM.)
- **Blocked partner goal (§F-5):** **fizzle → solo** — never tangle into a stakes-blocked goal. (Affirms GLM.)
- **`proseLine` id-leak (§E) — CONFIRMED REAL BUG, fix as part of E.** [agencyDigest.ts:31](../../src/services/npc/agencyDigest.ts) puts `delta.npcId`
  straight into player prose. E needs a `nameById` in `runAgencyTick` regardless, so build it and route ALL
  player-facing digest prose through names (not just the tangle line). **Also verify** whether the
  real-time player digest is surfaced today — if it is, this is a live id-leak independent of E and should
  be fixed now; if not, fixing it alongside E is sufficient. Flag findings either way.

### G. Constants available (verified `agencyConstants.ts:104–107`)
```
COLLISION_TANGLE_PROB       = 0.5
COLLISION_OPPORTUNITY_BONUS = 3
```
Both exported. `COLLISION_OPPORTUNITY_BONUS` is the *only* number E injects; everything else is
word-bands from existing machinery. Never hardcode.

### H. Module + wiring (follow D's pattern)
- New file: `src/services/npc/agencyCollision.ts` (pure detector + resolver).
- Exports: `detectCollision(pick, candidates, rng)`, `resolveTangle(a, b, aGoal, bGoal, ...)`,
  `currentActivity` helper if D put it in `agencyAudition.ts` (import, don't dup).
- Re-export from `src/services/npc/index.ts`.
- Real-time: wire into `runAgencyTick` after `selectTickTarget`, before the single-NPC resolution.
- Timeskip: wire into `runTimeskip` after the per-NPC allocation loop (or fold into it).
- `npm run build` green; `npx vitest` existing green; **no new test files** (separate WO).
- Run `graphify update .` per AGENTS.md after both D and E land.

### I. Suggested implementation order (after D is green)
1. `agencyCollision.ts`: `detectCollision` (pure, keyword + region match) + `resolveTangle`
   (cooperate/contest/neutral branches, reusing `rollGoal`/`applyBandToGoal`/`nextFailStreak`).
2. Re-export from `index.ts`.
3. Wire real-time: into `runAgencyTick` — tangle branch beside the single-NPC path. Build a
   `nameById` map from `npcLedger` for the shared delta.
4. Wire timeskip: into `runTimeskip` — detect once, merge allocations for coinciding pairs.
5. `npm run build` → green. `npx vitest` → existing green.
6. `graphify update .`.

---

## 🏗️ BUILD REPORT (2026-06-18, GLM 5.2) — E LANDED

**Status: ✅ Green.** `npm run build` green (tsc -b + vite build, 4.75s), `npx vitest` 75 files / 1017 tests passed (no regressions). Graphify updated (1212 nodes, 1828 edges). No new test files (Flash WO-09 owes an E test bundle — flagged, same as D).

### Files touched (5)
1. `src/services/npc/agencyDigest.ts` — added optional `npcName?: string` to `TickDelta`; `proseLine` now prefers `npcName` over `npcId` (id-leak fix, Opus-ratified). Debug line unchanged (id is the debug view's job).
2. `src/services/npc/agencyCollision.ts` — **NEW.** Pure module: `goalsCoincide`, `topActiveGoal`, `relationTone` (max-magnitude), `detectCollision` (one partner, deterministic tie-break, stakes-gated), `resolveTangle` (cooperate/contest/mild-contest), `buildTangleDeltas` (two `TickDelta`s with shared note, names not ids). Types: `DetectedCollision`, `RelationTone`, `TangleOutcome`.
3. `src/services/npc/index.ts` — re-exported the 5 collision exports + 3 types; added `COLLISION_TANGLE_PROB` + `COLLISION_OPPORTUNITY_BONUS` to the constants re-export.
4. `src/services/turn/turnPostProcess.ts` — added the real-time tangle branch in `runAgencyTick` (after `chooseTick` returns `goal`, before the solo path): detect collision in `deepTier ∪ {pick}` minus `pick`, roll `COLLISION_TANGLE_PROB`, resolve pair, emit shared deltas, return (skip solo). Solo path unchanged except `npcName` populated on its delta. Imports: `detectCollision`, `resolveTangle`, `buildTangleDeltas`, `COLLISION_TANGLE_PROB`.
5. `src/services/npc/agencyTimeskipRun.ts` — added post-loop pairwise tangle pass in `runTimeskip` (after the per-NPC loop, before the cap): scan ticked NPCs for coinciding pairs, roll `COLLISION_TANGLE_PROB`, resolve tangle, emit shared deltas. Imports: `goalsCoincide`, `topActiveGoal`, `relationTone`, `resolveTangle`, `buildTangleDeltas`, `COLLISION_TANGLE_PROB`. Solo deltas now populate `npcName`.

### Line-number re-verification (discipline rule)
All recon line numbers re-pinned against HEAD `09a55c3` post-D-landing (D shifted lines):
- `runAgencyTick` was line 495 → now 507 (D added bumpOnStageActivity call + log).
- `selectTickTarget` call was recon line 533 → now line 550 (D's `now` reorder + isAudition log).
- `runTimeskipPath` was recon line 658 → now 722 (D's activity bump + bumpOnStageActivity).
- `runTimeskip` in `agencyTimeskipRun.ts:144` unchanged (D did not touch timeskip — confirmed).
- `proseLine` (agencyDigest.ts:31) confirmed id-leak; fixed.

### Opus ratifications baked in (all 5 forks resolved per Opus review 2026-06-18)
1. **§B `opportunityBonus` plumbing** → `rollGoal.extraMods`. The winner of a rival contest gets `rollGoal(goal, GOAL_BASE_DC, COLLISION_OPPORTUNITY_BONUS, rng)` — the bonus improves *this beat's* roll (margin → band), not future selection heat. Implemented in `resolveTangle`.
2. **§D `relations` directionality** → max-magnitude. `relationTone(a, b)` reads both `a.relations[b.id]` and `b.relations[a.id]`, picks the direction with the larger absolute value. A one-sided grudge (`a→b = -2`, `b→a = 0`) tones as rivalry. Implemented in `relationTone`.
3. **§D neutral default** → mild contest. Both roll, higher margin wins, no feeding (`aFeedsB = bFeedsA = false`). Implemented in `resolveTangle` neutral branch.
4. **§F-1 collision pool** → active-this-beat cast. Real-time: `deepTier ∪ {pick}` minus `pick` (only NPCs being resolved this beat can collide). Timeskip: `tickedNpcs` (only eligible NPCs with active goals). Implemented at both call sites.
5. **§E shared delta** → two `TickDelta`s with shared `note` naming the partner. `buildTangleDeltas` produces both, each with `npcName` populated and a note like `"contesting Bryn"`. No schema-add `TangleDelta`. Implemented in `buildTangleDeltas`.

### §F open forks resolved (per Opus review + GLM recommendations)
- **§F-1 collision-pool scope**: active-this-beat (see above).
- **§F-2 cooperate outcome**: both roll, share the better band. `applyBandToGoal` + `nextFailStreak` on both. No `opportunityBonus` on cooperate. Implemented.
- **§F-3 contest resolution**: both roll, higher margin wins, winner gets bonus re-roll, loser keeps original band. Loser's `failStreak` increments, winner's resets (via `nextFailStreak`). Implemented.
- **§F-4 timeskip collision timing**: post-loop pairwise pass (detect after solo ticks, emit tangle deltas as additional beats — the tangle is a distinct event from the solo ticks, not a replacement). Simpler than pre-loop allocation merging, no double-counting (solo delta = "Alden worked on X", tangle delta = "Alden and Bryn clashed over X" — different beats). The `REVEAL_CAP = 2` cap surfaces the most dramatic. Implemented.
- **§F-5 blocked-goal partner**: fizzle → skip. `detectCollision` skips partners whose coinciding goal is blocked by dangerous stakes (`sceneStakes === 'dangerous' && partnerGoal.horizon === 'long'`). Timeskip pass does the same. Implemented.

### id-leak fix (Opus-flagged, folds into E)
**Confirmed real, confirmed reaching the player payload.** Traced: `buildDigest([delta], 'player')` → `proseLine(delta)` → `${delta.npcId}...` → `callbacks.updateContext({ agencyDigest: combined })` → `payloadWorldContext.ts:448` folds `context.agencyDigest` directly into the GM's world-context block. The GM LLM saw "npc-3 advanced toward…" in its prompt.

**Fix**: `TickDelta.npcName?: string` (optional, additive — no breaking change). `proseLine` prefers `npcName`, falls back to `npcId` for unmigrated callers. All three delta builders now populate `npcName`:
- Real-time solo path (`turnPostProcess.ts:644`)
- Real-time tangle path (`buildTangleDeltas`)
- Timeskip solo path (`agencyTimeskipRun.ts:274`)
- Timeskip tangle path (`buildTangleDeltas`)
The two hidden-visibility timeskip deltas (blocked-by-stakes, tempo-miss) don't need it — they never reach the player digest (`buildDigest` filters to `direct`/`report`). Left as-is.

### What did NOT change (per guardrails, verified untouched)
- `buildProximityRoster` (`agencyHeartbeat.ts:19`) — reused as-is. E only changes *what happens among* the proximate set, not the proximity definition.
- `chooseTick` (`agencySelection.ts:62`) — unchanged. Still decides goal/color/need/idle for the picked NPC.
- `rollGoal` / `bandFromMargin` / `karmaBonus` (`agencyDice.ts`) — unchanged. `resolveTangle` calls `rollGoal` with the existing signature.
- `applyBandToGoal` / `progressDelta` / `canCrossTier` / `consumeTierCross` (`agencyProgress.ts`) — unchanged.
- `applyGoalOutcomeNudge` / `applyTierCross` (`agencyDrift.ts`) — unchanged. The tangle path does NOT run the hex nudge or tier-cross on the partner (only the solo path does, on `pick`). The partner gets `applyBandToGoal` + `nextFailStreak` only. This is a v1 simplification — if the tangle should also drive hex/rung drift on both NPCs, that's a follow-up. Flagged.
- `agencyTick` advance — one tick per real-time beat (tangle or solo), one batch per timeskip. Budget intact: real-time +0 LLM, timeskip +1 LLM (unchanged). E adds zero LLM calls.
- `ACTIVITY_DECAY = 0.5` (D's ratified deviation) — untouched.
- `bumpOnStageActivity` (D's on-stage bump) — untouched.
- The timeskip narration LLM call (`turnPostProcess.ts:800`) — untouched. E's tangle deltas fold into the existing digest, which the narration LLM weaves into prose.

### Known v1 simplifications (flag for Opus follow-up)
1. **Tangle doesn't fire hex nudge / tier-cross on the partner.** Only the solo path runs `applyGoalOutcomeNudge` + `applyTierCross` on `pick`. The tangle path applies `applyBandToGoal` + `nextFailStreak` to both NPCs but skips the drift machinery. If a rival contest should also nudge the winner's boldness or cross a tier, that's a follow-up — the plumbing exists, just needs to be called in the tangle branch.
2. **Timeskip tangle is a post-loop pass, not a pre-loop allocation merge.** The tangle is an additional beat, not a merged allocation. This means a coinciding pair gets their solo ticks AND a tangle delta — narratively distinct (solo = "worked on X", tangle = "clashed over X"), but it does mean the pair's goals get resolved twice (once solo, once tangle). The `applyBandToGoal` on the tangle uses the post-solo-tick goal state, so progress accumulates. Acceptable for v1; if it over-advances goals, switch to pre-loop allocation merge (recon §F-4 original rec).
3. **`resolveTangle` takes `_aNpc`/`_bNpc` params but doesn't use them in v1.** Kept for API readability + future per-NPC nudge. Underscore-prefixed to satisfy `noUnusedParameters`.
4. **D test bundle + E test bundle both owed by Flash WO-09.** Neither D nor E shipped tests (spec said "no new test files — separate WO"). Test count stayed at 1017 across both.

### E is done per Opus's bar
- ✅ All 5 Opus-ratified forks implemented (opportunityBonus plumbing, relations directionality, neutral default, collision pool, shared delta).
- ✅ All 5 §F open forks resolved (cooperate, contest, timeskip timing, blocked partner, collision-pool scope).
- ✅ id-leak fix folded in (TickDelta.npcName, proseLine prefers it, all delta builders populate it).
- ✅ Build green, tests green, graphify updated.
- ⏳ Test bundle — owed by Flash WO-09.

### Phase 4 status
- WO-05 (Piece A — drift): landed (prior session).
- WO-06 (Piece B/C — nudge + tier-cross): landed (prior session).
- WO-07 (Piece D — audition): landed + on-stage bump + ratified. Done.
- WO-08 (Piece E — collisions): landed. Done.
- WO-09 (Flash tests for D + E): owed.
