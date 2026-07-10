# Architecture Review: Layer Boundary Violations (High Priority)

**Scope:** `src/services/`, `src/store/`, `src/components/`
**Recommendation:** Pause new feature work on these layers until the items below are addressed. Each week this ships on top of the current structure raises the cost of the fix.

## Summary

The project's directory layout (`services/`, `store/`, `components/`) suggests an intended layered architecture, but nothing currently enforces the boundaries between those layers. In practice, every layer imports directly from every other layer, in both directions. This makes the codebase harder to debug (a bug in one layer can originate from any other layer), riskier to change (swapping an implementation detail touches dozens of unrelated files), and effectively untestable in isolation (services can't be unit-tested without a live store/React tree).

## Findings

1. **Presentation imported directly by domain/state logic.** `src/components/Toast.tsx` (a UI component) is imported directly by 9 non-UI files: `services/turn/turnOrchestrator.ts`, `turnPostProcess.ts`, `pendingCommit.ts`, `services/image/index.ts`, `portrait.ts`, `services/campaign-state/divergenceRegister.ts`, and 3 store slices. The dependency arrow points the wrong way — domain logic knows about a specific UI implementation.

2. **`store` and `services` depend on each other in both directions**, with no clear ownership:
   - `services/turn/pendingCommit.ts` imports the entire `useAppStore` hook directly.
   - `services/lore/loreKeywordEnricher.ts` and `services/turn/turnPostProcess.ts` call into `campaignStore` directly.
   - `services/engine/engineRolls.ts` reads from `store/slices/settingsSlice` directly.

3. **Components bypass any intermediate layer.** 41 component files call `useAppStore` directly and 35 import from `services/*` directly — there's no controller/hook seam between UI and the rest of the system.

## Impact if left unaddressed

- Debugging a single-layer issue requires tracing the full dependency graph, not just the file in question.
- Any change to a shared implementation detail (e.g. the toast library, or the state management library) risks breaking unrelated files across every layer.
- Services can't be unit-tested in isolation — they implicitly depend on live store/React state.

## What's already in progress

Branch `refactor/layer-separation` has started the right fix: a ports/adapters pattern (`src/ports/*` as contracts, `src/adapters/*` as the only files allowed to know both a port and its concrete implementation), documented in `architecture/BOUNDARIES.md`. Current state of that work:

- Good: `NotificationPort` fully replaces the direct `Toast` imports; 8 ports are wired and consumed.
- Incomplete: `services/turn/pendingCommit.ts` (28 store operations) still bypasses the ports entirely — it's the last and largest leak.
- Not enforced: `scripts/gate.mjs`, which checks for boundary violations, isn't wired into `package.json` or CI, so nothing currently prevents a regression.
- Scope creep: unrelated work (i18n, NPC name-bank seed data, APK build CI) is mixed into the same commit history as the layering refactor, making the actual architectural change harder to review on its own.

## Recommended next steps

1. Land the ports/adapters work for `pendingCommit.ts` using the remaining ports (Archive, CampaignContext, Divergence).
2. Wire `scripts/gate.mjs` into an `npm run gate` script and into CI, so boundary violations fail the build instead of relying on manual review.
3. Split the unrelated commits (i18n, name-bank data, APK CI) out of the layering refactor's history so each can be reviewed and merged independently.

## Expected benefit once resolved

- A bug in `turn/` can be understood from its port contracts alone, without reading `store/` or `components/`.
- Swapping an implementation (toast library, state management library) touches one adapter, not dozens of call sites.
- Services become unit-testable against mock ports, without spinning up the store or a React tree.
- CI catches boundary regressions automatically instead of relying on manual review.
