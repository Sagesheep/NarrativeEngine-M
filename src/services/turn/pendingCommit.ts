import type { ChatMessage, NPCEntry, SceneStakes, PipelinePhase, StreamingStats } from '../../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import type { OpenAIMessage } from '../llm/llmService';
import { handlePostTurn } from './turnPostProcess';
import { classifySceneStakes } from './sceneStakesTag';
import { tierAllows } from './aiTier';
import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from '../payload';
import { notify } from '../ports/notify';
import { storeAccess, type StoreState } from '../ports/store';
import { uid } from '../../utils/uid';

// ── In-memory snapshot ─────────────────────────────────────────────────
// Lost on crash — that's OK. Relaunch reconciliation rebuilds from the live
// store (no "next turn's messages" exist after a crash, so live == snapshot).
interface PendingTurnSnapshot {
    snapshotId: string;                 // uid() — matched by ChatMessage.precontext.capturedPayloadRef
    turnState: TurnState;               // ORIGINAL reference — do NOT rebuild from live
    messages: ChatMessage[];              // messages at swipe-1 completion time (frozen)
    cachedPayload: OpenAIMessage[];      // for swipes 2–5 (sanitizePayloadForApi(false))
    displayInput: string;                // user's display input for this turn
    activeCampaignId: string;            // campaign at turn time
    npcLedger: NPCEntry[];               // ledger at turn time
}

let pendingSnapshot: PendingTurnSnapshot | null = null;

export function capturePendingTurnSnapshot(
    state: TurnState,
    cachedPayload: OpenAIMessage[],
    displayInput: string,
): void {
    pendingSnapshot = {
        snapshotId: uid(),
        turnState: state,
        messages: [...state.getMessages()],
        cachedPayload: [...cachedPayload],
        displayInput,
        activeCampaignId: state.activeCampaignId ?? '',
        npcLedger: state.npcLedger,
    };
}

export function getActiveSnapshotId(): string | null {
    return pendingSnapshot?.snapshotId ?? null;
}

export function clearPendingTurnSnapshot(): void {
    pendingSnapshot = null;
}

export function getPendingTurnSnapshot(): PendingTurnSnapshot | null {
    return pendingSnapshot;
}

export function getCachedSwipePayload(): OpenAIMessage[] | null {
    return pendingSnapshot?.cachedPayload ?? null;
}

// Smart Retry v1: patch the user-message slot in the cached payload (soft-edit).
// Preserves engine appendages by splicing only the player-authored prefix —
// the caller passes the new FULL prompt text and the engine-tag patterns are
// applied here. This mutates the in-memory singleton directly; if no snapshot
// is active, the call is a no-op (the caller should fall back to full rewind).
export function patchCachedUserPrompt(newPromptText: string): void {
    if (!pendingSnapshot) return;
    const payload = pendingSnapshot.cachedPayload;
    let lastUserIdx = -1;
    for (let i = payload.length - 1; i >= 0; i--) {
        if (payload[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) return;
    const original = payload[lastUserIdx].content;
    if (typeof original !== 'string') return;

    // Engine tag patterns — must match the orchestrator's append points.
    const patterns: RegExp[] = [
        /\n\[RESOLVED ROLL — /,
        /\n\[LOOT DROP: /,
        /\n\[DICE FAIRNESS/i,
        /\n\[CHARACTER INTRO/i,
    ];
    let splitIdx = original.length;
    for (const pat of patterns) {
        const m = original.match(pat);
        if (m && m.index !== undefined && m.index < splitIdx) splitIdx = m.index;
    }
    const engineSuffix = original.slice(splitIdx);
    payload[lastUserIdx] = { ...payload[lastUserIdx], content: newPromptText.trim() + engineSuffix };
}

// ── Find the latest GM message with a pending commit ───────────────────
export function findPendingCommitMessage(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.pendingCommit) return m;
        // Only scan the tail — the pending message is always the latest GM bubble
        // (no scene-marker follows it because handlePostTurn was deferred).
        if (m.role === 'system' && m.name === 'scene-marker') break;
    }
    return null;
}

// Smart Retry v1: find the latest assistant message marked retryable (the story
// AI was aborted or failed final retry). Like findPendingCommitMessage but for
// the pre-commit failure state. Used by delete/regenerate handlers to clear
// the orphaned precontext + the in-memory snapshot when the turn is discarded.
export function findRetryableMessage(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.retryable) return m;
        if (m.role === 'system' && m.name === 'scene-marker') break;
    }
    return null;
}

// ── Build fresh callbacks from the live store for commit ────────────────
function buildCommitCallbacks(activeCampaignId: string): TurnCallbacks {
    return {
        onCheckingNotes: () => {},
        addMessage: (msg) => storeAccess().getState().addMessage(msg),
        updateLastAssistant: (content) => storeAccess().getState().updateLastAssistant(content),
        updateLastMessage: (patch) => {
            const msgs = storeAccess().getState().messages;
            if (msgs.length > 0) storeAccess().getState().updateLastMessage(patch);
        },
        updateContext: (patch) => storeAccess().getState().updateContext(patch),
        setArchiveIndex: (entries) => storeAccess().getState().setArchiveIndex(entries),
        updateNPC: (id, patch) => storeAccess().getState().updateNPC(id, patch),
        addNPC: (npc) => storeAccess().getState().addNPC(npc),
        addNpcSuggestions: (names, ctx) => storeAccess().getState().addNpcSuggestions(names, ctx),
        setCondensed: (upToIndex) => storeAccess().getState().setCondensed(upToIndex),
        setStreaming: () => {},
        setLastPayloadTrace: storeAccess().getState().setLastPayloadTrace,
        setSemanticFacts: (facts) => storeAccess().getState().setSemanticFacts(facts),
        setChapters: (chapters) => storeAccess().getState().setChapters(chapters),
        setPipelinePhase: (phase: PipelinePhase) => storeAccess().getState().setPipelinePhase(phase),
        setStreamingStats: (stats: StreamingStats | null) => storeAccess().getState().setStreamingStats(stats),
        setDivergenceRegister: (reg) => {
            storeAccess().getState().setDivergenceRegister(reg);
            if (activeCampaignId) {
                import('../../store/campaignStore')
                    .then(m => m.saveDivergenceRegister(activeCampaignId, reg))
                    .catch(e => console.warn('[Commit] saveDivergenceRegister failed:', e));
            }
        },
        updateMessageDivergence: (messageId, divergenceIds) => storeAccess().getState().updateMessageDivergence(messageId, divergenceIds),
        applyPressurePatch: (id, p) => storeAccess().getState().applyPressurePatch(id, p),
        setOnStageNpcIds: (ids) => storeAccess().getState().setOnStageNpcIds(ids),
    };
}

// ── commitPendingTurn ──────────────────────────────────────────────────
// Fires handlePostTurn with the visible variant's CURRENT (possibly edited)
// text. Guards against late swipe results. Reworded failure toast for the
// commit path.
export async function commitPendingTurn(): Promise<void> {
    const snapshot = pendingSnapshot;
    const store = storeAccess().getState();
    const messages = store.messages;

    const pendingMsg = findPendingCommitMessage(messages);
    if (!pendingMsg || !pendingMsg.swipeSet) {
        // No pending turn (normal first-turn case, or already committed).
        clearPendingTurnSnapshot();
        return;
    }

    const variantIdx = pendingMsg.swipeActiveIndex ?? 0;
    const variant = pendingMsg.swipeSet[variantIdx];
    if (!variant) {
        clearPendingTurnSnapshot();
        return;
    }

    // The visible variant's CURRENT text — read from the message content
    // (which reflects edits the user may have made while browsing).
    const text = pendingMsg.content;

    // Determine scene stakes from the chosen variant.
    let sceneStakes: SceneStakes = variant.sceneStakes;
    if (!variant.tagPresent) {
        const utilityProvider = snapshot?.turnState.getUtilityEndpoint?.() ?? store.getActiveUtilityEndpoint?.();
        const aiTier = snapshot?.turnState.settings.aiTier ?? store.settings.aiTier;
        if (utilityProvider && tierAllows(aiTier, 'sceneStakesClassify')) {
            try {
                const recentScene = (snapshot?.messages ?? messages).slice(-3).map(m => {
                    const role = m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
                    return `[${role}]: ${(m.content || '').slice(0, 500)}`;
                }).join('\n\n');
                sceneStakes = await classifySceneStakes(utilityProvider, recentScene + '\n\n' + text.slice(0, 1000));
            } catch (e) {
                console.warn('[Commit] scene-stakes fallback classify failed:', e);
            }
        }
    }

    // Update context with lastSceneStakes from the chosen variant (commit only).
    store.updateContext({ lastSceneStakes: sceneStakes });

    // Build the commit state — use the ORIGINAL TurnState reference but
    // override getMessages so the importance rater reads the snapshot,
    // never live getMessages() (a late commit must not see the next turn's messages).
    const commitState: TurnState = snapshot
        ? { ...snapshot.turnState, getMessages: () => snapshot.messages }
        : rebuildStateFromLiveStore(store);

    const commitCallbacks = buildCommitCallbacks(commitState.activeCampaignId ?? '');
    const displayInput = snapshot?.displayInput ?? '';
    const activeCampaignId = commitState.activeCampaignId!;
    const npcLedger = commitState.npcLedger;

    try {
        const { loadChapters } = await import('../../store/campaignStore');
        await handlePostTurn(
            commitState,
            commitCallbacks,
            displayInput,
            activeCampaignId,
            npcLedger,
            text,
            loadChapters,
        );

        // Auto-condense check — moved to commit (was in the orchestrator completion callback).
        if (commitState.settings.autoCondenseEnabled) {
            const allMsgs = commitState.getMessages();
            if (shouldCondense(allMsgs, commitState.settings.contextLimit, commitState.condenser.condensedUpToIndex, getCondenseBudgetRatio(commitState.settings.condenseAggressiveness))) {
                const newIndex = computeTrimIndex(allMsgs, commitState.condenser.condensedUpToIndex);
                if (newIndex !== commitState.condenser.condensedUpToIndex) {
                    storeAccess().getState().setCondensed(newIndex);
                }
            }
        }
    } catch (err) {
        console.error('[Commit] handlePostTurn failed:', err);
        notify.error('Turn committed but some archive updates may be missing. Your story is saved.');
    }

    // Clear the swipe set + pendingCommit marker — the bubble is now a
    // normal historical message.
    const freshStore = storeAccess().getState();
    const freshMsgs = freshStore.messages;
    const idx = freshMsgs.findIndex(m => m.id === pendingMsg.id);
    if (idx !== -1) {
        const updated = [...freshMsgs];
        const { swipeSet: _ss, pendingCommit: _pc, swipeActiveIndex: _si, retryable: _r, precontext: _pc2, ...rest } = updated[idx];
        updated[idx] = rest as ChatMessage;
        storeAccess().setState({ messages: updated });
        import('../../store/campaignStore').then(m => m.saveCampaignState(activeCampaignId, {
            context: storeAccess().getState().context,
            messages: updated,
            condenser: storeAccess().getState().condenser,
            pinnedExcerpts: storeAccess().getState().pinnedExcerpts,
        })).catch(e => console.warn('[Commit] saveCampaignState failed:', e));
    }

    clearPendingTurnSnapshot();
}

// ── Rebuild TurnState from the live store (crash recovery path) ────────
// Used when pendingCommit is true on launch but the in-memory snapshot was
// lost (WebView/renderer death). At relaunch, no "next turn's messages"
// exist, so reading live is safe — the snapshot invariant (don't see the
// next turn's messages) holds vacuously.
function rebuildStateFromLiveStore(store: StoreState): TurnState {
    return {
        input: '',
        displayInput: '',
        settings: store.settings,
        context: store.context,
        messages: store.messages,
        condenser: store.condenser,
        loreChunks: store.loreChunks,
        npcLedger: store.npcLedger,
        archiveIndex: store.archiveIndex,
        semanticFacts: store.semanticFacts,
        chapters: store.chapters ?? [],
        activeCampaignId: store.activeCampaignId,
        provider: store.getActiveStoryEndpoint(),
        getMessages: () => storeAccess().getState().messages,
        getFreshProvider: () => store.getActiveStoryEndpoint(),
        getFreshSummarizerProvider: () => {
            const s = store.getActiveSummarizerEndpoint?.();
            return (s?.endpoint && s?.modelName) ? s : undefined;
        },
        getUtilityEndpoint: () => store.getActiveUtilityEndpoint(),
        getFreshAuxiliaryProvider: () => {
            const aux = store.getActiveAuxiliaryEndpoint?.();
            return aux?.modelName ? aux : store.getActiveStoryEndpoint();
        },
        getExtractionProvider: () => {
            const hasEndpoint = (p?: { endpoint?: string; modelName?: string }) => !!(p?.endpoint && p?.modelName);
            const a = store.getActiveAuxiliaryEndpoint?.();
            if (hasEndpoint(a)) return a!;
            const s = store.getActiveSummarizerEndpoint?.();
            if (hasEndpoint(s)) return s!;
            return store.getActiveStoryEndpoint();
        },
        incrementBookkeepingTurnCounter: () => storeAccess().getState().incrementBookkeepingTurnCounter(),
        autoBookkeepingInterval: storeAccess().getState().autoBookkeepingInterval,
        resetBookkeepingTurnCounter: () => storeAccess().getState().resetBookkeepingTurnCounter(),
        timeline: store.timeline,
        pinnedChapterIds: storeAccess().getState().pinnedChapterIds,
        clearPinnedChapters: () => storeAccess().getState().clearPinnedChapters(),
        divergenceRegister: store.divergenceRegister,
        onStageNpcIds: store.onStageNpcIds,
        npcPressure: store.npcPressure,
        pinnedExcerpts: store.pinnedExcerpts,
    };
}

// ── Launch reconciliation ──────────────────────────────────────────────
// On app launch, if any message has pendingCommit=true, fire handlePostTurn
// with the then-visible variant's text, then clear the marker. Covers
// WebView/renderer death mid-browse.
export async function reconcilePendingCommitOnLaunch(): Promise<void> {
    const store = storeAccess().getState();
    const pendingMsg = findPendingCommitMessage(store.messages);
    if (!pendingMsg || !pendingMsg.swipeSet) return;

    console.log('[Reconcile] Found pendingCommit on launch — firing deferred handlePostTurn');
    await commitPendingTurn();
}

// ── Swipe-set helpers ──────────────────────────────────────────────────
// Check if a message is the latest GM message (eligible for 🔄)
export function isLatestGmMessage(messages: ChatMessage[], msgId: string): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant') return m.id === msgId;
        // Skip trailing system messages (scene-marker, timeskip-seam, etc.)
        if (m.role === 'system') continue;
        // If we hit a user message first, this isn't the latest GM
        if (m.role === 'user') return false;
    }
    return false;
}

// Check if a message has a browseable swipe set (pre-commit)
export function hasSwipeSet(msg: ChatMessage | undefined): boolean {
    return !!(msg && msg.swipeSet && msg.swipeSet.length > 0 && msg.pendingCommit);
}