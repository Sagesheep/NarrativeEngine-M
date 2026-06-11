# Plan 4 — God-Node Decoupling (gatherContext / llmCall / joinPromptSections)

**Executor:** OPUS, strictly one step at a time, build+tests green between every step.
**Graph evidence:** `llmCall()` 30 edges, `gatherContext()` 25, `joinPromptSections()` 23 —
the top three bridges across nearly every community in `graphify-out/GRAPH_REPORT.md`.

## Diagnosis (what's actually wrong, per node)

- **`gatherContext`** (turnContext.ts:171-528, 357 lines): one function runs 12 distinct retrieval
  stages (planner, query expansion, semantic search, rerank, lore RAG, rules RAG, archive funnel/flat,
  pinned chapters, deep scan, facts+timeline, recommender, NPC semantic recall) with hand-rolled
  sequencing, per-stage tier gates, per-stage error handling, and ad-hoc budgets. This is the real
  god node. Untestable in isolation → directly blocks Plan 3.
- **`llmCall`** (utils/llmCall.ts): high fan-in but a *good* abstraction — one typed entry point for
  utility calls. The problem is only that callers depend on the concrete function, so nothing can be
  tested without network mocking. Needs a **port**, not a rewrite.
- **`joinPromptSections`**: a string-joining utility with high fan-in. Harmless. **Leave it alone** —
  fan-in to a tiny pure function is not coupling. Explicitly out of scope.

## Target design

```
turnOrchestrator
   └─ runRetrievalPipeline(query: RetrievalQuery, ports: TurnPorts): Promise<RetrievalBundle>
        stages: RetrievalStage[]   // ordered, each independently testable
```

```ts
// turnTypes.ts additions
interface TurnPorts {
    utilityLLM: UtilityLLM;              // wraps llmCall — the ONE injection point
    storage: typeof offlineStorage;      // already injectable-ish
    embedder: { search: typeof semanticSearch; searchScored: typeof semanticSearchScored; ready(): boolean };
}

interface UtilityLLM {
    call(prompt: string, opts: UtilityCallOpts): Promise<string>;   // delegates to llmCall(provider, ...)
    endpoint(): LLMProvider | undefined;                            // replaces state.getUtilityEndpoint?.()
}

interface RetrievalStage {
    name: string;
    tierFeature?: Parameters<typeof tierAllows>[1];  // gate, checked by the runner not the stage
    run(q: RetrievalQuery, acc: RetrievalBundle, ports: TurnPorts): Promise<Partial<RetrievalBundle>>;
}
```

`RetrievalBundle` = today's `GatheredContext` minus `payloadResult`, plus the intermediate
candidates (`semanticLoreIds`, `semanticRuleIds`, planner result) that stages currently share
via local `let` variables. Payload building (`buildPayload`) stays OUTSIDE the pipeline —
it is assembly, not retrieval.

The runner owns the cross-cutting stuff stages currently each reimplement: tier gating,
try/catch-with-warn (kills the silent `catch {}` pattern — synergy with Plan 2 Invariant 4),
loading-status callbacks, and per-stage timing logs.

## Migration steps (each = one commit, behavior-identical)

**4.1 — `UtilityLLM` port (do this even if nothing else happens).** Add the interface + a
`realUtilityLLM(getEndpoint)` adapter. Change `gatherContext`'s internals to take it as a parameter
defaulting to the real adapter. No caller outside `turn/` changes. *Unblocks Plan 3.*

**4.2 — Characterization tests.** Before moving any code: tests pinning `gatherContext`'s observable
behavior for ~6 scenarios (no-embedder path, tier-low path, funnel path, funnel-timeout fallback path,
pinned chapters, recommender injection) using the new port with scripted responses. These tests are
the safety net for everything below; they should not change in 4.3–4.6.

**4.3 — Extract leaf stages** (no shared mutable state): `plannerStage`, `expandQueryStage`,
`factsTimelineStage`, `npcSemanticRecallStage` → `src/services/turn/stages/`. `gatherContext` calls them.

**4.4 — Extract the tangled middle**: `semanticCandidatesStage`, `rerankStage`, `loreStage`, `rulesStage`.
These share the candidate-ID variables — this is where `RetrievalBundle` becomes the carrier.

**4.5 — Extract archive recall**: funnel/flat/pinned/deep-scan as stages. Largest and riskiest step;
the funnel's `Promise.race` fallback and the pinned-chapter mutation of `archiveResult.scenes`
(turnContext.ts:390) must be reproduced exactly. Fix nothing here, even if Plan 2 flagged it —
behavior-identical first, fixes after.

**4.6 — Replace the body**: `gatherContext` becomes `runRetrievalPipeline(stages, ...)` + `buildPayload`.
Keep the export name and signature so callers (`turnOrchestrator`) don't change. Delete dead locals.

**4.7 — (Optional, separate decision) parallelism pass**: the stage list makes the existing
parallel groups explicit (planner ∥ expansion ∥ semantic-search already are; recommender could overlap
archive recall). Only after the eval harness (Plan 3) exists to prove no quality change.

## Risks

- **Hidden ordering dependencies**: stages read store state mid-flight (`state.getMessages()` is called
  3× at different times, deliberately — messages can change during awaits). Document each re-read in
  the stage contract; do not "optimize" to one read.
- **The 5 s funnel race**: a stage runner with uniform error handling must not accidentally await the
  losing funnel promise. Keep the race semantics inside the archive stage.
- **Scope creep**: every step will surface things worth fixing (Plan 2 will have catalogued them).
  Refuse. Behavior-identical means identical, including bugs.

## Acceptance

- Steps 4.1–4.6 each: `npm run build` + `npx vitest run` green, characterization tests untouched since 4.2.
- `gatherContext` body < ~60 lines; no stage file > ~150 lines.
- `graphify . --update` after completion — `gatherContext` should drop out of the top-3 god nodes.
