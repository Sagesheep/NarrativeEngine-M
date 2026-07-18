# NPC Agency Architecture — Implementation Plan

## Context

The GM Cockpit app at `D:\Games\AI DM Project\Automated_system\mainApp` has strong infrastructure (archive, vector search, condenser, divergence register, NPC drift detection, knowledge boundaries) but the roleplay still feels stale — "Yes Man Syndrome." Six AIs (Claude Sonnet, Gemini 3.1 Pro, GLM 5.1, DeepSeek V4 Pro, Kimi 2.6 Thinking, plus a final Gemini Pro stress-test) debated this in `D:\Games\AI DM Project\App Optimized\Brainstorm.md`. The synthesis converged on layered drives, spotlight filtering, friction accumulators, scene heat gating, and threat state machines for foreshadowing.

The infrastructure runs both cloud endpoints (DeepSeek V4 Pro, Claude, Gemini, etc. — per the per-endpoint LLM queue system in `llmRequestQueue.ts`) and local quantized models. **This dual-model constraint is the hinge of the plan**: cloud models can absorb a softer role clarification at the top of the system prompt, but quantized local models (especially under VRAM pressure) exhibit strong recency bias and require any forcing instruction to be appended at the END of the payload, immediately before the generation point. The plan accommodates both.

This plan rejects the maximalist 6-phase build and proposes a **measure-then-activate** strategy that respects the user's prior failures (Surprise Engine, AI Player System — both removed) and the practical constraint that GLM 5.1 is the coding workhorse with finite cycles.

---

## My opinion (Opus 4.7) — what the five-AI debate actually concluded

After reading all five takes, two insights stand above the rest and they came from the *last* two contributors:

**DeepSeek's role conflict diagnosis is the deepest insight in the file.** The Claude/Gemini argument over "MUST mandate" vs "soft permission" misses that the LLM isn't refusing friction — it's confused about whether its job is to be a helpful assistant or a challenging GM. A 20-token global directive ("your job is memorable, not easy — facilitating every wish is poor GM-ing") may eliminate 60–80% of the problem on cloud models at zero ongoing cost. This also retroactively explains why the original Surprise Engine failed: it was a foreign instruction colliding with the LLM's helpfulness alignment, not a fiction-grounded character action.

**Kimi's instrument-before-activate principle is the right engineering discipline.** Both Claude (Sonnet) and Gemini are debating theoretical failure modes against models neither has tested. The user has the actual app. The cheap move is build counters, log them, play 2–3 sessions, and let the data say what to activate. The 6-phase build presupposes problems we haven't confirmed exist *for this user's specific model stack*.

**Gemini Pro's recency-bias pushback is technically sharp and partially right.** Quantized local models DO weight recent context far more heavily than the static system prompt. A role-clarification sentence in the global rules section will be drowned out on those models within a few turns. Gemini Pro's prescription — append the hard interrupt directive at the END of the context payload, immediately before the generation token — is correct for that deployment class. Where Gemini Pro overstates: it claims role clarification is "structurally false" for local models. That's too strong. Modern instruction-tuned local models (Qwen 2.5+, DeepSeek-V2+, Llama 3.x+) handle high-level framing well enough that role clarification still adds value as a baseline; it just isn't *sufficient alone* under VRAM-constrained quantization. The fix is layered: keep the role clarification cheaply at the top, AND ensure that when forcing functions are needed (Phase 2), they ride at the end of the payload, not the start.

**Where I depart from all six:**

1. **Stage directions appended at end-of-payload, not MUST mandates and not start-of-prompt suggestions.** This combines the strongest insight from each side. Gemini Pro is right that recency bias requires end-of-payload placement; Gemini's earlier reply was wrong that the format should be a meta-instruction (`MANDATORY GENERATION RULE`) — that's still a hedge-able instruction. The right tool, *if activation becomes necessary*, is partial-output completion appended last: `[Senna's next dialogue beat begins with her stepping into the player's path. Generate her opening line consistent with sceneWant=...]`. The model can't hedge on a beat it's required to continue, AND it can't lose track of the directive to recency bias because the directive IS the most recent thing in context.

2. **Bidirectional pressure.** Everyone framed accumulators as ignored-only. But engagement also accrues — NPCs the player invests in should become *more* willing to speak up. Without engagement tracking, "stakes that matter" can't work because there's no signal for what the player has emotionally invested in.

3. **Foreshadowing extends the divergence register, doesn't parallel it.** The existing `DivergenceEntry` already has `importance`, `resolved`, `linkedSceneIds`, `supersedes`. Add `foreshadowState: 1|2|3` and `ripensAt`. Don't build a separate register.

4. **The 6-axis psych profile already in `chatEngine.ts:138-181` (N/T/E/S/B/G — Nature/Training/Emotion/Social/Belief/Ego) is the missing scaffolding the brainstorm doesn't reference.** Drives should *project from* it: `coreWant` emerges from B+G axes, `triggers` map from E responses. This avoids profile bloat.

5. **Surprise Engine (DC 95) is still in the codebase** despite the brainstorm saying it was "removed." It's in `ChatArea.tsx:170-185`. Friction-from-drives makes it redundant; remove it. Encounter (DC 198) and World (DC 498) operate at location/cosmic tiers and should stay, optionally modulated by global pressure.

---

## Recommended approach

**Build Phase 1 fully. Instrument everything. Don't activate forcing functions yet. Play 2–3 sessions. Then decide Phase 2.**

This approach:
- Respects DeepSeek + Kimi's "premature engineering" warning
- Delivers immediate behavioral change (drives + role clarification will move the needle even if nothing else fires)
- Gathers empirical data to choose between Spotlight, Stage Direction, Heat Index, etc.
- Keeps the door open for the full Gemini-style mechanical apparatus *if data demands it*

---

## Phase 1: Drives + Role Clarification + Instrumentation (no activation)

**Goal:** Give NPCs character-driven reasons to act, resolve the LLM's role conflict, accumulate counters, but don't yet inject any forcing prompts.

### 1.1 Schema: extend NPCEntry

**File:** [src/types/index.ts:338-361](src/types/index.ts:338)

Add to `NPCEntry`:

```ts
drives?: {
  coreWant: string;        // 1 sentence — character truth, projects from Belief/Ego axes
  sessionWant: string;     // 1 sentence — current arc objective
  sceneWant: string;       // 1 sentence — immediate beat goal
};
behavioralTriggers?: Array<{
  keyword: string;         // matches against player input + recent narrative
  shift: string;           // describes BEHAVIORAL shift, not emotion
                           // optimal: "crosses arms, single-syllable answers"
                           // poor: "becomes defensive"
}>;
hardBoundaries?: string[];  // never crossed — "won't betray her sister"
softBoundaries?: string[];  // crossable but accrues pressure
pressure?: {
  ignored: number;         // accumulates when player crosses boundaries / ignores wants
  engaged: number;         // accumulates when player addresses, returns to, invests in NPC
  lastDecayTurn: number;
  history: Array<{ turn: number; type: 'ignored'|'engaged'; delta: number; reason: string }>;
};
```

**Migration:** Existing NPCs load with all new fields `undefined`. Treat undefined as zero/empty everywhere.

### 1.2 NPC generation prompt — populate drives at creation

**File:** [src/services/npcGeneration.ts:7-103](src/services/npcGeneration.ts:7)

Extend the LLM generation prompt to also output `drives` and `behavioralTriggers`. Use few-shot examples that emphasize:
- `coreWant` = a deep character truth, not a goal
- `sceneWant` = something specific they want from THIS scene
- Triggers describe physical/verbal shifts, not emotional states

Token cost: ~150 tokens added to one-time NPC generation prompt. No runtime cost.

### 1.3 Inject drives into prompt — top NPC only (lightweight Spotlight)

**File:** [src/services/payloadBuilder.ts:202-244](src/services/payloadBuilder.ts:202)

Currently injects ALL matched NPCs as a flat block (the Gemini bland-compromise failure mode). Change:

- Compute simple `salience` score per active NPC: name mention count in last 5 turns + recent dialogue weight + `pressure.engaged` weight + `pressure.ignored` weight
- Top-1 NPC: full minified card + `drives.sceneWant` + active `behavioralTriggers` + 6-axis psych profile (existing)
- Others: existing minified card WITHOUT drives/triggers (current behavior, just no drive bloat)

This is a softer Spotlight than Gemini proposed — no "suppressed state" descriptors yet. We'll add those in Phase 2 if multi-NPC scenes still feel flat.

### 1.4 Global role clarification — DeepSeek's insight, two-position injection

**File:** [src/services/chatEngine.ts](src/services/chatEngine.ts) — wherever the static system prompt is assembled (search `rulesRaw` near line 62) AND end-of-payload assembly point

Add a short directive in TWO positions, scaled by model class:

**Position A (start of static system prompt — always on):**
```
Your job is to make the game memorable, not easy. Facilitating the player's every
wish is poor game mastering. NPCs with their own wants and boundaries are not
obstacles to remove — they are the texture that makes the world feel alive.
Push back when characters would; let conflicts breathe.
```

**Position B (end of payload, immediately before generation — always on, much shorter):**
```
[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not
default to facilitation.]
```

Why both: Position A frames the role globally for cloud models with strong instruction following. Position B counters recency bias on quantized local models, where the system prompt is overwhelmed by recent player turns. The end-of-payload reminder is ~25 tokens — cheap enough to leave on always; redundant on cloud, essential on local.

Token cost: ~75 tokens total per turn. No additional infrastructure.

This is the **highest-ROI single change in the plan** for cloud deployments and a meaningful baseline for local deployments. If Position A+B alone fixes 50%+ of the staleness on cloud models, Phase 2 may be optional for those endpoints. For local quantized endpoints, expect Phase 2B (Stage Direction injection) to be needed regardless — the role clarification is necessary but not sufficient there.

### 1.5 Pressure counters — accumulate, don't inject

**Files:**
- [src/services/postTurnPipeline.ts:148-206](src/services/postTurnPipeline.ts:148) — extend `runNPCTrack`
- New: `src/services/npcPressureTracker.ts`

After each player turn, for each active NPC:

**Engagement scan (cheap, regex-based):**
- Player input mentions NPC name → `engaged += 1`
- Player input contains pronoun within 30 chars of NPC name (simple heuristic) → `engaged += 0.5`
- Player explicitly directs action at NPC ("I ask Senna...", "tell Mira...") → `engaged += 2`

**Ignore scan (cheap, regex-based against existing data):**
- Player input contains a `behavioralTriggers[].keyword` AND the response is contradictory to NPC's `sceneWant` → `ignored += 1`
- Player crosses a `softBoundaries` phrase → `ignored += 1`
- NPC has stated `sceneWant` and 3+ turns elapsed without progress toward it → `ignored += 1` (one-time, then reset internal "stalled" flag)

**Decay:** Both counters decay by 0.1/turn to prevent stale accumulation.

**Persist:** Append to `pressure.history` with reason. Save to existing campaign store via existing debounced save (`updateNPC`). Use existing storage path — no schema migration on backend beyond the JSON shape.

**Crucially: no injection yet.** Counters are observable in a dev panel only. We are gathering data to decide whether activation is needed.

### 1.6 Dev panel: NPC pressure inspector

**File:** New — `src/components/NPCPressureInspector.tsx` or wherever existing dev/debug panels live (check `src/components/` for existing pattern)

Lightweight panel showing per-NPC live state:
- name, current `sceneWant`
- `pressure.ignored`, `pressure.engaged` with mini-sparkline
- last 5 history entries with reasons
- "salience" computed for current scene (so user can see who would be spotlit)

This is the **measurement instrument** that decides Phase 2.

### 1.7 Remove Surprise Engine

**File:** [src/components/ChatArea.tsx:170-185](src/components/ChatArea.tsx:170)

Delete the Surprise Engine block. Its job (random tension spike when nothing happens) is now done — at least in principle — by character drives + role clarification. Keep Encounter (DC 198) and World (DC 498); they operate on location/cosmic tiers that drives don't cover.

If Phase 1.5 data shows pacing still stalls in NPC-light scenes, we can reintroduce a smarter version in Phase 2+.

### 1.8 Verification (Phase 1)

End-to-end check that Phase 1 works before declaring it done:

1. Open existing campaign, confirm existing NPCs load without errors (drives undefined, treated as empty).
2. Generate a new NPC via existing flow, confirm `drives.coreWant`/`sessionWant`/`sceneWant` and `behavioralTriggers` appear populated in the inspector.
3. Run a turn with one named NPC mentioned. Confirm payload preview (existing diagnostic — check what tooling exists) shows that NPC's drives injected, others omitted.
4. Run a turn that crosses a stated soft boundary. Confirm `pressure.ignored` increments in the inspector. No injection should fire.
5. Run a turn that addresses an NPC by name 3 times. Confirm `pressure.engaged` increments.
6. Confirm Surprise Engine removal doesn't break the dice fairness engine or other existing tests.

---

## Phase 1.5: Empirical Decision Gate (2–3 sessions of play)

**This is not code work. It is data collection.**

After Phase 1 ships, play 2–3 actual sessions. Then evaluate:

| Observation | Implies | Phase 2 component to add |
|---|---|---|
| Drives appear honored, NPCs proactive (likely cloud endpoints) | Phase 1 was sufficient | None — done |
| Multiple NPCs in scene → bland compromise | Spotlight wasn't aggressive enough | Full Spotlight w/ suppressed-state descriptors |
| Drives ignored entirely, NPCs still passive | Role clarification + drives insufficient for this model | Stage Direction injection at END of payload (when ignored ≥ 3) |
| Behavior differs starkly between cloud and local endpoints | Recency bias on local models | End-of-payload reminders + Stage Direction (Phase 2B is the local-model fix) |
| Friction lands tone-deaf in combat | Need scene awareness | Scene Heat Index gating |
| Multi-session threads don't connect | Need explicit foreshadowing | Foreshadow extension to divergence register |
| Drive content stale, NPC says same thing every scene | Drives need mutation | Drive mutation hook on divergence events |
| LLM hedges past stage directions even at end-of-payload | Need delivery enforcement | Verification + retry (most likely needed for heavily quantized local models) |

**Note on local quantized endpoints:** Per Gemini Pro's recency-bias analysis, expect Phase 2B (Stage Direction at end-of-payload) to be required, not optional. For users running primarily on local quantized stacks, consider building Phase 1 + 2B in a single batch rather than waiting for empirical data — the data is essentially pre-determined by the inference stack.

**The pressure counters give you the data.** If `pressure.ignored` climbs past 3 frequently and the LLM never naturally reflects that, you need activation. If it stays low because the LLM is acting on drives, you don't.

---

## Phase 2+: Conditional Roadmap (build only if Phase 1.5 data demands)

These are *modular additions*, each independently shippable, each gated by Phase 1.5 evidence. Order is not rigid — pick by which symptom you're seeing.

### 2A: Full Spotlight Filter

**If symptom:** Multi-NPC scenes still produce bland compromise.

**Files:** `src/services/payloadBuilder.ts`, new `src/services/npcSpotlight.ts`

- Compute Activation Energy = trigger proximity (×4) + `pressure.ignored` (×2) + `pressure.engaged` (×1.5) + name salience (×1)
- Top-1 NPC: full drives + triggers + psych profile
- Others: one-line suppressed-state descriptor (`"Mira [reactive | yields to spotlit NPC | sceneWant suppressed: stay unnoticed]"`)
- Manual "force spotlight on X" debug toggle to override

### 2B: Stage Direction Injection at END of payload (NOT MUST mandate, NOT start-of-prompt)

**If symptom:** Drives ignored, friction never manifests in dialogue. **Default-on for local quantized endpoints.**

**Files:** `src/services/payloadBuilder.ts`, new `src/services/frictionEngine.ts`

**Critical placement:** The stage direction must be appended at the absolute end of the context payload, after recent conversation history, immediately before the generation point. Per Gemini Pro's recency-bias analysis, instructions placed early in the context are progressively de-weighted by quantized local models as the conversation lengthens. End-of-payload placement makes the directive the most recent context the model sees, maximizing compliance.

When spotlit NPC's `pressure.ignored ≥ 3` (and Heat allows, see 2C):

```
[STAGE DIRECTION — non-negotiable beat opener]
{NPC.name}'s next dialogue beat opens with a physical action consistent with
{firstUnaddressed trigger.shift}. Their first sentence expresses
{drives.sceneWant}. Continue the scene from there.
```

After firing: reset `pressure.ignored` to 0. (Don't re-fire same beat.)

**Engaged-proactive variant** (firing condition: `pressure.engaged ≥ 5` AND player turn is open-ended):
```
[STAGE DIRECTION] {NPC.name} speaks first this beat, addressing the player
about {drives.sceneWant}. (They feel trusted enough to lead.)
```

This combines two structural defenses against RLHF compliance bias:
- **Partial-output completion** — model can't hedge on a beat it's required to continue
- **End-of-payload placement** — model can't lose the directive to recency drift

For models that use chat templates (Qwen, Llama, etc.), insert the directive inside the final `system` or `user` block immediately before the assistant generation token (e.g., `<|im_start|>system\n[STAGE DIRECTION...]<|im_end|>\n<|im_start|>assistant\n`). For OpenAI-compatible APIs without explicit chat templates, append as a final system message in the messages array.

### 2C: Scene Heat Index — gate Stage Direction firing

**If symptom:** Stage directions land mid-combat or mid-revelation, breaking tone.

**Files:** new `src/services/sceneHeatIndex.ts`, consumed by 2B

Heuristic-based classifier (no LLM call):
- Inputs: dice roll markers in last 5 turns, conflict keyword density, message length variance, exclamation/question density
- Output: `mode: 'calm' | 'tense' | 'combat' | 'aftermath'` + `score: 0-100`
- Combat mode → defer stage direction firing; counter still accrues
- Aftermath mode → flush deferred firings at +1 strength (Gemini's "boiled-over state")
- Calm mode → engaged-proactive variants allowed
- LLM fallback ONLY when score in 40-60 ambiguous band, queued to backgroundQueue, cached 3 turns

### 2D: Foreshadowing — extend divergence register

**If symptom:** Multi-session threads don't connect; payoffs feel disconnected from earlier hints.

**Files:** [src/services/divergenceRegister.ts](src/services/divergenceRegister.ts), [src/services/postTurnPipeline.ts:208-245](src/services/postTurnPipeline.ts:208)

Add to existing `DivergenceEntry`:
```ts
foreshadowState?: 1 | 2 | 3;   // Distant Rumor / Physical Evidence / Direct Encounter
ripensAt?: number;             // turn or sceneId
seedNPCId?: string;            // which NPC carries this thread
```
Add category: `'foreshadow_seed'`

Extend the existing extraction prompt in `extractDivergences()` (line 114) to also emit foreshadow seeds when major events plant future trouble. Same LLM call, no extra cost.

In `renderRegisterForPayload()` (line 374), when a seed's `seedNPCId` matches the spotlit NPC OR the seed's `ripensAt` is reached:
- State 1: inject as background dressing (low priority)
- State 2: inject as `[FORESHADOW EVIDENCE: {seed text}]`
- State 3: inject as `[FORESHADOW READY — direct payoff opportunity available]`

A background pass (`foreshadowRipener`) advances states based on turns elapsed since planting. Reuse existing `resolved` flag to retire payoffs.

### 2E: Drive Mutation on Divergence Hits

**If symptom:** Drives become stale; NPCs keep wanting the same thing despite world changes.

**File:** extend `runDivergenceTrack` in `postTurnPipeline.ts`

When a `DivergenceEntry` with `importance ≥ 7` is created/updated whose `subject` keyword matches an NPC's `behavioralTriggers[*].keyword` or appears in their `coreWant`:
- Queue background `mutateNPCSceneWant(npc, divergence)` via existing `backgroundQueue`
- Lightweight LLM call (~300 tokens): "Given this canonical event and this NPC's core character, what is their new immediate scene-want?"
- Update `npc.drives.sceneWant`, append to `previousSnapshot` (existing field)
- Bursty cost only — fires on major events

Don't use embedding similarity (Gemini's proposal). The codebase doesn't have an NPC embedding index; keyword match is cheaper and sufficient until proven otherwise.

### 2F: Output Verification + Retry

**If symptom:** Stage directions fire but LLM still produces meek output (model-specific RLHF strength varies).

**Files:** wherever turn orchestration completes (check `src/services/turnOrchestrator.ts` per memory note that it was decomposed in Phase 2 of prior work)

After a stage-direction-firing turn:
- `verifyDelivery(response, directive)` — regex/substring check: did NPC name appear in first 200 chars? Did action verb manifest? Did boundary phrase appear?
- If failed: ONE retry with escalated prompt: `[CRITICAL: previous output omitted required beat. Regenerate. {NPC.name} MUST physically intervene in the first sentence with {action}.]`
- Hard cap 1 retry. Both attempts logged for telemetry.
- If both fail: minimal injected coda (`*{NPC.name} steps forward, opening her mouth to speak*`) appended to maintain continuity. Surface dev toast.

---

## Critical files to modify

| Phase | File | Why |
|---|---|---|
| 1.1 | `src/types/index.ts` | NPCEntry schema extension |
| 1.2 | `src/services/npcGeneration.ts` | Populate drives at NPC creation |
| 1.3 | `src/services/payloadBuilder.ts` | Lightweight Spotlight (top-1 drive injection) |
| 1.4 | `src/services/chatEngine.ts` | Global role clarification in system prompt |
| 1.5 | `src/services/postTurnPipeline.ts` | Pressure counter updates |
| 1.5 | new: `src/services/npcPressureTracker.ts` | Pressure scan logic |
| 1.6 | new: `src/components/NPCPressureInspector.tsx` | Dev panel for measurement |
| 1.7 | `src/components/ChatArea.tsx` | Remove Surprise Engine block |
| 2D | `src/services/divergenceRegister.ts` | Foreshadow seed extension |

The five files most changes will land in:
1. `src/services/payloadBuilder.ts` — Spotlight, drive injection
2. `src/services/postTurnPipeline.ts` — pressure tracking, drive mutation hooks
3. `src/types/index.ts` — schema
4. `src/services/chatEngine.ts` — global role clarification, prompt restructuring
5. `src/services/divergenceRegister.ts` — foreshadow extension

---

## Verification (full plan)

**Phase 1 verification** (covered above in 1.8) is the gate to ship.

**Phase 1.5 verification** (after 2–3 sessions of play):
- Export pressure history per NPC; eyeball whether high-ignored NPCs feel underused in the actual narrative
- Eyeball whether high-engaged NPCs are speaking up unprompted (this is the natural-emergence test)
- Compare 3 turns from before/after the role clarification — is the LLM pushing back more?
- Decide which Phase 2 modules to build based on the table in Phase 1.5

**Phase 2 verification** (per module):
- 2A Spotlight: 4-NPC scene shows centered dialogue around one voice instead of polite-roundtable
- 2B Stage Direction: ignore stated boundary 3 turns running → turn 4 NPC physically interrupts
- 2C Heat Index: enter combat → friction defers visibly (inspector shows "deferred"); combat ends → next quiet beat carries deferred friction
- 2D Foreshadowing: plant a seed manually, confirm 10 turns later it surfaces as Evidence-level injection; major divergence event → tied NPC's `sceneWant` rewrites within 2 turns
- 2E Drive Mutation: kill a faction leader → faction-tied NPC's scene want changes (visible in inspector with timestamp)
- 2F Verification: force a friction fire on a known-soft model → logs show retry triggered → succeeded; no infinite loop

---

## What this plan deliberately does NOT include

- Embedding-based drive mutation (Gemini's proposal) — premature; keyword match is cheaper and the codebase lacks an NPC embedding index
- Always-on observer LLM — explicitly rejected by user
- Player engagement signal as a separate system — folded into pressure counters (engaged side)
- A new "Tension Register" (Sonnet's proposal) — folded into Spotlight via Activation Energy
- Removal of Encounter/World engines — they operate at non-NPC tiers and are fine

---

## Decision summary

The early AIs (Sonnet, Gemini, GLM) debated the full mechanical apparatus assuming it was needed. DeepSeek and Kimi correctly pointed out that *we don't know that yet*. Gemini Pro then correctly pointed out that for one specific deployment class (quantized local models), we DO know — recency bias makes start-of-prompt instructions unreliable, so Phase 2B is essentially pre-determined for that endpoint class.

The user's two prior failed systems (Surprise Engine, AI Player System) were both attempts at mechanical apparatus that turned out unnecessary and worse than nothing. There's a pattern there worth respecting — but the pattern is "untethered randomness fails," not "all mechanical apparatus fails." Stage directions tied to character-driven pressure counters are categorically different from RNG-triggered events.

**Build Phase 1 in full. Add role clarification at BOTH start and end of payload (cheap, layered defense). Instrument with bidirectional pressure counters. Play 2–3 sessions. For cloud endpoints, expect Phase 1 may be sufficient. For local quantized endpoints, plan to build Phase 2B alongside or shortly after — the empirical data will most likely confirm Gemini Pro's prediction. Choose remaining Phase 2 modules (Spotlight strength, Heat Index, Foreshadow extension, drive mutation, verification) from observed data, not theory.**