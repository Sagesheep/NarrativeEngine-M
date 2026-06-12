# Meta / Gamertag / Parody Names — MMORPG-Flavor Name Group (Idea)

> Status: **IDEA / PARKED 2026-06-12** — low stakes, fun-to-have, no MMORPG campaign
> run yet. Not scheduled. Depends on Plan 05 Component C (campaign-header classification
> + author override) being built first — see "Dependency" below. Self-contained so it
> can be picked up cold.

## The idea

In an MMORPG / LitRPG / isekai-game-world campaign, NPC and player names aren't
"Aldric" and "Maren" — they're **player handles**: `xXShadowXx`, `Sephirot420`,
`NoobMaster69`, `DragonSlayer99`, plus trademark-dodging parodies (`Geraldo of Rivia`,
`Master Cheef`). In that setting those names are the authentic flavor, not garbage.

This extends the Plan 05 name bank (`src/data/nameBank.json`, built by
`scripts/buildNameBank.mjs` from `Upgrade/FablePlans/assets/`) with a new **opt-in**
culture group that produces handle-style names — so the deterministic swap and the
(future) per-turn name menu draw gamer-handle replacements in game-world campaigns and
NOTHING in normal ones.

## Design

New header group in the bank taxonomy:

```
#meta
##gamertag     xXShadowXx, Sephirot420, NoobMaster69, DragonSlayer99
##parody       Geraldo of Rivia, Sephirot, Master Cheef
```

Two non-negotiable rules that keep this from wrecking serious campaigns:

1. **Opt-in, never default.** `#meta` must never be in the default draw. It only
   activates when the campaign's selected headers include it — i.e. the author ticks it
   in the Component C header dropdown ("this campaign uses gamer-handle names"). A
   grimdark campaign that never opts in can never randomly mint "Sephirot420".
2. **Don't pollute the general pool.** Exact trademarked character names (Sephiroth,
   Kratos, Cloud) stay OUT of every normal culture group — that's the leakage Plan 05
   already avoids. The vibe is delivered *only* through this tagged, opt-in group, and
   via parody-spellings, not exact IP.

Everything else falls out of the existing architecture for free:
- **Self-classification (05 Component D):** AI mints "Xeno420", it collides with the
  ledger, the engine looks it up under `##gamertag`, draws another gamertag. No special
  case in the swap.
- **Per-turn menu (05 Component E):** when `#meta` is an active header, the 5-name menu
  is seeded with handles, nudging the story AI to name new arrivals in-flavor up front.

## The one technical wrinkle — generator, not a flat list

Gamertags are **combinatorial** (base word + number + leetspeak + x-wrapping), so a
static 200-entry list goes stale fast. `##gamertag` is better as a tiny **generator**:

```
base   ∈ { Shadow, Dragon, Reaper, Frost, Void, Blaze, ... }   (a modest word list)
style  ∈ { plain, xWrap(xXbaseXx), suffixNum(base+00..999), leet(Sh4d0w), titleNum }
```

`drawUnusedName` would special-case `##gamertag` to call the generator (still honoring
the `exclude` set and `rng` injection for determinism) instead of sampling a flat array.
`##parody` can stay a normal static list and needs no special handling.

Cheap-model job to produce: the `##parody` list + the `base` word list for the generator
(same offline pipeline as 05a/05b). Tiny.

## Dependency

**Blocked on Plan 05 Component C** (campaign-header classification + author-override
dropdown), which is currently deferred. Reason: the opt-in toggle IS the safety
mechanism. Building `#meta` before the toggle exists means it either draws always (ruins
normal campaigns) or never (pointless). So this rides along with — or just after — the
Component C build, not before.

## Scope when built

1. Add `#meta/##gamertag/##parody` to the bank taxonomy + generate `##parody` list and
   the gamertag `base` word list (cheap model, offline).
2. Add the gamertag generator + wire `drawUnusedName` to use it for `##gamertag`.
3. Ensure `#meta` is excluded from default draws and only active via campaign headers.
4. Surface it as an author-tickable option in the Component C header dropdown.
5. Tests: generator determinism under injected rng + exclude; `#meta` never drawn unless
   the campaign opts in.

## Why parked

Fun, low-stakes, and there's no MMORPG campaign to exercise it yet. Captured here so the
idea isn't lost; pick up when Component C lands or when an actual game-world campaign
makes it worth the afternoon.
