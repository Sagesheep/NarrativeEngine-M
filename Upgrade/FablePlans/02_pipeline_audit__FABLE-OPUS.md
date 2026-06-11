# Plan 2 — Context Pipeline Invariant Audit

**Executor:** FABLE preferred (this is the one task where model strength matters most); OPUS acceptable.
**Output:** `Upgrade/FablePlans/AUDIT_FINDINGS.md` — findings ranked by severity, each with file:line evidence
and a proposed fix. **No code changes during the audit**; fixes are a separate pass so findings stay reviewable.

## Why

Each module is locally correct and unit-tested (742 tests green). The bugs that remain live *between*
modules — invariants no single file owns. Example already found by inspection: the embedding scheduler's
pause/resume deadlock (see Plan 1, BUG-1) — every line looks reasonable alone.

## Method

For each invariant below: trace the full data path end-to-end, write down every hop
(producer → transform → consumer), and check the invariant at each hop. Findings go in a table:
`ID | Severity (P0-P3) | Invariant | Evidence (file:line) | Failure scenario | Proposed fix`.

---

## Invariant 1 — Witness integrity (the app's core promise)

**Claim:** an NPC can only "know" events it witnessed.

Trace paths where NPC knowledge enters the prompt:
- Archive recall → scenes land in payload (`recallArchiveScenes`, `recallWithChapterFunnel` →
  `buildPayload` in `gatherContext`, turnContext.ts:505). Are scenes filtered by *which NPCs are on stage*,
  or does a recalled scene leak events to a non-witness NPC simply by being in context?
- Chapter seal summaries (`buildCombinedSealPrompt`, `extractWitnessCorrections` — community 8):
  do summaries preserve per-NPC witness attribution, or flatten it?
- `semanticFactText` (`queryFacts` → `formatFactsForContext`, turnContext.ts:431): are facts witness-scoped?
- Divergence register entries and the new resolved-threads world context (latest commit): witness-scoped?
- NPC payload minification: does the minified profile carry "knows about X" data it shouldn't?

**Key question to answer explicitly:** is witness tracking enforced *structurally* (filtered out of the
payload) or only *behaviorally* (system prompt asks the LLM to respect it)? If behavioral, document that
as a known design limit, not a bug — but check the prompt actually states it.

## Invariant 2 — Token budget never overflows the context limit

**Claim:** the assembled payload fits `settings.contextLimit`.

`gatherContext` hands `buildPayload` inputs sized by **independent, overlapping budgets**:
- archive recall: hardcoded `3000` tokens (turnContext.ts:332, 356, 363)
- pinned chapters: `contextLimit * 0.35` (turnContext.ts:388) — **added on top of** archive recall
- deep scan brief: `contextLimit * 0.45` (turnContext.ts:407)
- recommender lore injection: `+600` (turnContext.ts:463)
- lore: 1200 (turnContext.ts:276), rules: `contextLimit * rulesBudgetPct * 1.2` threshold logic
- facts: 500, plus timeline text appended unbudgeted (turnContext.ts:441)

Audit `computeBudgets` / `fitHistory` / `payloadBudgeter.ts`: does `buildPayload` re-fit everything to the
real limit (in which case the worst case is silent truncation — check *what* gets cut and in what order),
or can sections sum past `contextLimit` (8k default!) and overflow? Worst case to model:
pinned (35%) + deep scan (45%) + archive (3000) + lore + rules + history on an 8192 limit.
Also: is `countTokens` (tokenizer.ts) the same tokenizer family as the target models, and how wrong is it
for the worst-case provider?

## Invariant 3 — Divergence/canon consistency

**Claim:** once a scene diverges from canon, recall never re-asserts the canonical version.

Trace: `divergenceRegister` → `getDivergenceSceneIds` (passed into flat recall at turnContext.ts:356, 363 —
note it is **not** passed into `recallWithChapterFunnel` at line 332; is the funnel path divergence-aware
internally, or is this a gap?) → `timelineResolver.resolveTimeline` → `formatResolvedForContext`.
Also check the chapter-seal path: do sealed summaries bake in pre-divergence text?

## Invariant 4 — Failures are visible

Catalog every swallowed error on the turn path (`catch {}` / `catch (_e)` with no log). Known instances:
turnContext.ts:313, 432-434, 443-445; embeddingScheduler.ts:143-144, 156-157; llmCall fallbacks.
For each: what does the user experience when it fires (degraded recall? stale facts? nothing?), and
should it at least `console.warn`. Special attention: `gatherContext`'s funnel fallback
(`Promise.race` with 5 s timeout, turnContext.ts:334-342) — if the funnel loses the race, the promise
keeps running and its result is discarded; check for side effects and wasted utility-LLM spend.

## Invariant 5 — Scene ID integrity

Scene numbers are `padStart(3, '0')` strings (turnContext.ts:312) but parsed back via regex
`--- SCENE (\d+) ---` (turnContext.ts:345) and stored unpadded. Check: campaigns past 999 scenes;
string-vs-number comparison in `sceneIdRange` filters (planner, turnContext.ts:39) and chapter
`sceneRange` lookups; lexicographic sort assumptions anywhere scene IDs are ordered.

## Invariant 6 — Tier gates are consistent

`tierAllows` gates planner / expandQuery / reranker / archiveFunnel / deepScan / recommender.
Check each feature degrades cleanly when gated off (the `else if` at turnContext.ts:360 covers funnel-off;
do the others have equivalent fallbacks?) and that no gated feature is still *paid for* (LLM call fired
then discarded).

---

## Acceptance

- `AUDIT_FINDINGS.md` exists with every invariant traced (even "checked, holds" entries — negative
  results are findings too).
- Each P0/P1 finding has a minimal repro description and a proposed fix small enough to review.
- A follow-up fix pass is scoped as its own task list at the bottom of the findings doc,
  tagged with executor models per finding complexity.
