# Phase 8 — Extract ChatArea Hooks (HIGH RISK)

**AI Tier: Strong AI** (Opus 4.7 / GPT-5 / GLM-5.1)

> [!IMPORTANT]
> **Reconciled against live code on 2026-05-29 (phases 1–6 complete).** This doc predates several features that have since been added to ChatArea (forced-intervention AIs, pending arc seed / CreateTrouble, deep-archive arming, the explicit divergence-save wrap). Counts and the file path below were stale and are corrected. Verify against source before acting.

ChatArea is the heart of the user-facing turn loop: it subscribes to ~38 store fields (via one `useShallow` selector), manages 9 `useState` + 5 `useRef`, and orchestrates `runTurn` via ~16 callbacks plus an abort controller. A hook extraction here can plausibly compile clean but break: streaming, abort-mid-stream, edit-and-regenerate, scroll-during-stream, scene note banner, deep archive arming, divergence extraction/persistence, pinned memories, forced interventions, or the arc-seed queue.

**MANDATORY:** Runtime test the listed scenarios after extraction. Type-check alone is insufficient.

## Current state

`src/components/ChatArea.tsx` (439 lines) — **note: the file is at `src/components/ChatArea.tsx`, NOT `src/components/chat/`. The `chat/` subfolder holds its sub-components (`MessageBubble`, `ChatInput`, `PinnedMemoriesPanel`, `CreateTroubleButton/Modal`).**
- `handleSend()` (~lines 122–211, ~90 lines): builds the large `runTurn` input object + the ~16-callback object + abort controller. Includes arc-seed injection and deep-scan gating.
- 4 `useEffect` hooks: scroll-to-bottom on `messages.length`; reset `streamStartRef` on `pipelinePhase`; streaming-stats `setInterval` (500ms) on `pipelinePhase`; scroll listener that toggles `showScrollFab` at >400px from bottom.
- `handleStop`, `handleClearArchive` (uses `window.confirm`, NOT a dialog component), `handleInputChange` (textarea auto-grow).
- **`isStreaming` is LOCAL `useState` in ChatArea (line 103), not the store.** chatSlice also has its own `isStreaming`/`setStreaming` — but ChatArea uses its local one and passes `setStreaming` into `runTurn`. Don't accidentally cross these wires during extraction.
- The divergence-extraction callback (line 204) wraps the store action AND explicitly calls `saveDivergenceRegister` — this is the turn-path divergence persistence (see Phase 7 divergence note). Preserve it.
- Already uses `useMessageEditor` and `useCondenser` from `src/components/hooks/` (good base to build on). **New hooks should go in `src/components/hooks/`, matching the existing location — NOT `src/hooks/`.**

## Target structure

```
src/components/
  ChatArea.tsx              ← shell: wire store, hooks, sub-components (stays at components/, or move to chat/ — pick one and update imports)
src/components/chat/        ← (existing sub-component folder)
  MessageList.tsx           ← NEW: renders visibleMessages + load-more button
  ChatFooter.tsx            ← NEW: TRIM / CreateTrouble / PINS / CLEAR button bar
  ClearArchiveDialog.tsx    ← NEW: replaces the current window.confirm in handleClearArchive
src/components/hooks/       ← existing hooks live here (useMessageEditor, useCondenser)
  useTurnOrchestrator.ts    ← handleSend, handleStop, isStreaming(local), loadingStatus, isCheckingNotes, abortRef, forcedAIs, arc-seed wiring
  useScrollBehavior.ts      ← bottomRef, scrollContainerRef, showScrollFab
  useStreamingStats.ts      ← the 500ms polling loop + streamStartRef (extracted from the two phase-driven useEffects)
```

> **CORRECTION:** put new hooks in `src/components/hooks/` (where `useMessageEditor`/`useCondenser` already live), not `src/hooks/`. `src/hooks/` currently holds only `useRulesIndexer.ts`.

## useTurnOrchestrator shape

```ts
// src/hooks/useTurnOrchestrator.ts
export interface UseTurnOrchestratorArgs {
  // Inputs needed for runTurn — read from store or props
  // Keep this surface small: ideally just the user input + a few flags
}

export interface UseTurnOrchestratorResult {
  handleSend: (text: string) => Promise<void>;
  handleStop: () => void;
  isStreaming: boolean;
  isCheckingNotes: boolean;
  loadingStatus: string;
  streamingStats: { tokensPerSec: number; elapsedMs: number };
}

export function useTurnOrchestrator(): UseTurnOrchestratorResult {
  // Read everything needed from useAppStore inside the hook
  // Manage abortController via useRef
  // Encapsulate the runTurn callbacks (onCheckingNotes, addMessage, updateLastAssistant, etc.)
}
```

The hook owns:
- `isStreaming` (local), `isCheckingNotes`, `loadingStatus`, `forcedAIs` state
- `abortControllerRef`
- `runTurn` input + ~16-callback object construction (including the `saveDivergenceRegister` wrap and the `getState()`-based fresh reads for messages/semanticFacts/chapters/timeline/etc.)
- The arc-seed read/clear (`pendingArcSeed` → injected into `llmInput`) and deep-scan gating (`deepArmed && settings.enableDeepArchiveSearch`)
- Cleanup on unmount (abort in-flight stream)

> **CORRECTION:** the doc's claim that the hook should be "parameter-free, reading everything from the store" is mostly right, but note `handleSend` currently mixes store reads with `useAppStore.getState()` fresh reads (to avoid stale closures during a turn). Preserve that pattern — converting those `getState()` calls to selector subscriptions would reintroduce the staleness bugs they were added to fix. Streaming-stats polling is better split into its own `useStreamingStats` hook (it keys off `pipelinePhase`, not turn state).

ChatArea calls `const { handleSend, isStreaming, ... } = useTurnOrchestrator();` — that's it.

## useScrollBehavior shape

```ts
// src/hooks/useScrollBehavior.ts
export function useScrollBehavior(
  messages: ChatMessage[],
  isStreaming: boolean
): {
  bottomRef: RefObject<HTMLDivElement>;
  showScrollFab: boolean;
  scrollToBottom: () => void;
} {
  // Auto-scroll on new messages + streaming
  // Detect user-scrolled-up → show FAB
}
```

## ChatArea after extraction

> **NOTE (illustrative, not literal):** the snippet below references components that do NOT exist yet — `SceneNoteBanner` (currently inline amber JSX, lines 315–329), `ScrollFab` (currently an inline `<button>`, line 432), and props on `ChatInput` that differ from the real signature (`input`, `isStreaming`, `onChange`, `onSend`, `onStop`, `inputRef`). It also omits live features: `UtilityCallStrip`, `NPCPressureInspector`, `GenerationProgress`, `CreateTroubleButton/Modal`, the pending-arc-seed banner, and the load-older-messages control. Treat this as the shape to aim for, not a checklist of existing parts.

```tsx
export function ChatArea() {
  // UI state
  const [input, setInput] = useState('');
  const [pinnedPanelOpen, setPinnedPanelOpen] = useState(false);
  const [clearArchiveOpen, setClearArchiveOpen] = useState(false);
  
  // Store reads (only what this component renders directly)
  const messages = useAppStore(s => s.messages);
  const context = useAppStore(s => s.context);
  const pipelinePhase = useAppStore(s => s.pipelinePhase);
  
  // Domain hooks
  const turn = useTurnOrchestrator();
  const editor = useMessageEditor();
  const condenser = useCondenser();
  const scroll = useScrollBehavior(messages, turn.isStreaming);
  
  return (
    <div>
      <SceneNoteBanner context={context} />
      <MessageList
        messages={messages}
        isStreaming={turn.isStreaming}
        editor={editor}
      />
      <div ref={scroll.bottomRef} />
      {scroll.showScrollFab && <ScrollFab onClick={scroll.scrollToBottom} />}
      <ChatFooter
        onTrim={condenser.trim}
        onClearArchive={() => setClearArchiveOpen(true)}
        onTogglePins={() => setPinnedPanelOpen(p => !p)}
      />
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={() => turn.handleSend(input)}
        onStop={turn.handleStop}
        isStreaming={turn.isStreaming}
      />
      <ClearArchiveDialog open={clearArchiveOpen} onClose={() => setClearArchiveOpen(false)} />
      {pinnedPanelOpen && <PinnedMemoriesPanel />}
    </div>
  );
}
```

## Critical runtime tests (NOT optional)

After extraction, manually verify every scenario:

1. **Basic send:** Type a message → send → assistant streams → completes → message persists on reload.
2. **Abort mid-stream:** Send → click stop while streaming → stream halts → partial message saved.
3. **Edit and regenerate:** Click edit on past user message → modify → send → conversation truncates and regenerates.
4. **Condense:** Click TRIM → history condenses → next turn uses condensed context.
5. **Scroll behavior:** Scroll up during stream → FAB appears → click FAB → scrolls to bottom.
6. **Scene note banner:** Set a scene note in context → banner shows → clear note → banner hides.
7. **Deep archive search:** Arm deep search → send message → verify archive search runs.
8. **Divergence extraction:** Send a message that should trigger divergence → verify entry appears in MemoryTab.
9. **Pinned memories:** Pin a memory → open pins panel → memory visible → unpin → gone.
10. **Tool calls:** Send a message that triggers query_campaign_lore → tool message appears → assistant uses result.
11. **Clear archive confirmation:** Click CLEAR → dialog appears → confirm → archive cleared → cancel path also works.
12. **Streaming stats:** During streaming, verify tokens/sec display updates ~1×/sec.
13. **Race: rapid send:** Send → immediately try to send again → second send is ignored or queued correctly.
14. **Race: edit during stream:** Send → start editing past message while streaming → behavior is sane (probably: edit blocked until stream ends).

If ANY of these regress, revert.

## Verification

- [ ] `tsc --noEmit` exits 0
- [ ] `npm test` green
- [ ] All 14 runtime scenarios above verified manually
- [ ] No new console errors during any scenario
- [ ] Streaming feels visually identical (no jank, no extra flicker)

## Notes for the executing model

- The 15+ callbacks `runTurn` accepts are a sign that `runTurn` itself wants to be event-emitting rather than callback-driven. DO NOT refactor `runTurn` in this phase — out of scope. Just wrap the callbacks inside the hook.
- The `abortControllerRef` must live in the hook, NOT in ChatArea. If the user navigates away during streaming, the hook's cleanup should abort.
- React StrictMode double-renders effects in dev. Test extraction under StrictMode to catch double-fire bugs in the streaming stats polling.
- `useMessageEditor` and `useCondenser` already exist — don't rebuild them, just compose.
- If you find that extracting `useTurnOrchestrator` requires passing 10+ args, STOP and reconsider. The hook should be parameter-free, reading what it needs from the store internally.
- Ship as ONE PR. Sub-splitting risks broken intermediate states.
- Tag pre-merge commit as `pre-phase-8-baseline`.

## Rollback plan

If regressions appear post-merge:
1. Revert to `pre-phase-8-baseline`
2. Re-attempt with narrower scope (e.g. only extract `useScrollBehavior`, leave turn orchestration in ChatArea)
