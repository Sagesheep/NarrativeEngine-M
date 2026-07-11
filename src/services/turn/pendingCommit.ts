/**
 * @refactor RF-001, RF-004, RF-006
 * @violations 4 (see architecture/reverse-engineering/0.15-architecture-violations/RAW_DATA.json)
 * @waves W0(advance)/W1(close); W0(advance)/W2(close)
 * @ports MessagingPort, CampaignContextPort, NotificationPort
 * @see architecture/phase3-refactor-planning/3.1-refactor-case-catalog.md
 * @see architecture/phase3-refactor-planning/3.6-traceability-matrix.md
 * @see REFACTOR-MAP.md
 */

import type { ChatMessage, NPCEntry, SceneStakes, PipelinePhase, StreamingStats, PayloadTrace } from '../../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import type { OpenAIMessage } from '../llm/llmService';
import { handlePostTurn } from './turnPostProcess';
import { classifySceneStakes } from './sceneStakesTag';
import { tierAllows } from './aiTier';
import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from '../payload';
import { messagingPort, npcCapability, archivePort, campaignContextPort, notificationPort } from '../../ports';
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
        addMessage: (msg) => messagingPort.appendMessage(msg),
        updateLastAssistant: (content) => messagingPort.updateLastAssistant(content),
        updateLastMessage: (patch) => {
            const msgs = messagingPort.getMessages();
            if (msgs.length > 0) messagingPort.updateLastMessage(patch);
        },
        updateContext: (patch) => campaignContextPort.applyContextPatch(patch),
        setArchiveIndex: (entries) => archivePort.replaceArchiveIndex(entries),
        updateNPC: (id, patch) => npcCapability.updateNPC(id, patch),
        addNPC: (npc) => npcCapability.registerNPC(npc),
        addNpcSuggestions: (names, ctx) => npcCapability.suggestNPCs(names, ctx),
        setCondensed: (upToIndex) => messagingPort.condenseHistory(upToIndex),
        setStreaming: () => {},
        setLastPayloadTrace: (trace: PayloadTrace[]) => messagingPort.setLastPayloadTrace(trace[0]),
        setSemanticFacts: (facts) => archivePort.replaceSemanticFacts(facts),
        setChapters: (chapters) => archivePort.replaceChapters(chapters),
        setPipelinePhase: (phase: PipelinePhase) => messagingPort.setPipelinePhase(phase),
        setStreamingStats: (stats: StreamingStats | null) => messagingPort.setStreamingStats(stats),
        setDivergenceRegister: (reg) => {
            archivePort.replaceDivergenceRegister(reg);
            if (activeCampaignId) {
                import('../../services/persistence/campaignStore')
                    .then(m => m.saveDivergenceRegister(activeCampaignId, reg))
                    .catch(e => console.warn('[Commit] saveDivergenceRegister failed:', e));
            }
        },
        updateMessageDivergence: (messageId, divergenceIds) => archivePort.flagMessageDivergence(messageId, divergenceIds),
        applyPressurePatch: (id, p) => npcCapability.applyPressure(id, p),
        setOnStageNpcIds: (ids) => npcCapability.setOnStageNPCs(ids),
    };
}

// ── commitPendingTurn ──────────────────────────────────────────────────
// Fires handlePostTurn with the visible variant's CURRENT (possibly edited)
// text. Guards against late swipe results. Reworded failure toast for the
// commit path.
export async function commitPendingTurn(): Promise<void> {
    const snapshot = pendingSnapshot;
    const store = messagingPort;
    const messages = messagingPort.getMessages();

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
        const utilityProvider = snapshot?.turnState.getUtilityEndpoint?.() ?? messagingPort.getActiveUtilityEndpoint();
        const aiTier = snapshot?.turnState.settings.aiTier ?? messagingPort.getSettings().aiTier;
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
    campaignContextPort.applyContextPatch({ lastSceneStakes: sceneStakes });

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
        await handlePostTurn(
            commitState,
            commitCallbacks,
            displayInput,
            activeCampaignId,
            npcLedger,
            text,
        );

        // Auto-condense check — moved to commit (was in the orchestrator completion callback).
        if (commitState.settings.autoCondenseEnabled) {
            const allMsgs = commitState.getMessages();
            if (shouldCondense(allMsgs, commitState.settings.contextLimit, commitState.condenser.condensedUpToIndex, getCondenseBudgetRatio(commitState.settings.condenseAggressiveness))) {
                const newIndex = computeTrimIndex(allMsgs, commitState.condenser.condensedUpToIndex);
                if (newIndex !== commitState.condenser.condensedUpToIndex) {
                    messagingPort.condenseHistory(newIndex);
                }
            }
        }
    } catch (err) {
        console.error('[Commit] handlePostTurn failed:', err);
        notificationPort.error('Turn committed but some archive updates may be missing. Your story is saved.');
    }

    // Clear the swipe set + pendingCommit marker — the bubble is now a
    // normal historical message.
    const freshMsgs = messagingPort.getMessages();
    const idx = freshMsgs.findIndex(m => m.id === pendingMsg.id);
    if (idx !== -1) {
        const updated = [...freshMsgs];
        const { swipeSet: _ss, pendingCommit: _pc, swipeActiveIndex: _si, retryable: _r, precontext: _pc2, ...rest } = updated[idx];
        updated[idx] = rest as ChatMessage;
        messagingPort.replaceMessages(updated);
        
        import('../../services/persistence/campaignStore').then(m => m.saveCampaignState(activeCampaignId, {
            context: messagingPort.getContext(),
            messages: updated,
            condenser: messagingPort.getCondenser(),
            pinnedExcerpts: messagingPort.getPinnedExcerpts(),
        })).catch(e => console.warn('[Commit] saveCampaignState failed:', e));
    }

    clearPendingTurnSnapshot();
}

// ── Rebuild TurnState from the live store (crash recovery path) ────────
// Used when pendingCommit is true on launch but the in-memory snapshot was
// lost (WebView/renderer death). At relaunch, no "next turn's messages"
// exist, so reading live is safe — the snapshot invariant (don't see the
// next turn's messages) holds vacuously.
function rebuildStateFromLiveStore(store: typeof messagingPort): TurnState {
    return {
        input: '',
        displayInput: '',
        settings: messagingPort.getSettings(),
        context: messagingPort.getContext(),
        messages: messagingPort.getMessages(),
        condenser: messagingPort.getCondenser(),
        loreChunks: messagingPort.getLoreChunks(),
        npcLedger: messagingPort.getNpcLedger(),
        archiveIndex: messagingPort.getArchiveIndex(),
        semanticFacts: messagingPort.getSemanticFacts(),
        chapters: messagingPort.getChapters() ?? [],
        activeCampaignId: messagingPort.getActiveCampaignId(),
        provider: messagingPort.getActiveStoryEndpoint(),
        getMessages: () => messagingPort.getMessages(),
        getFreshProvider: () => messagingPort.getActiveStoryEndpoint(),
        getFreshSummarizerProvider: () => {
            const s = messagingPort.getActiveSummarizerEndpoint();
            return (s?.endpoint && s?.modelName) ? s : undefined;
        },
        getUtilityEndpoint: () => store.getActiveUtilityEndpoint(),
        getFreshAuxiliaryProvider: () => {
            const aux = messagingPort.getActiveAuxiliaryEndpoint();
            return aux?.modelName ? aux : messagingPort.getActiveStoryEndpoint();
        },
        getExtractionProvider: () => {
            const hasEndpoint = (p?: { endpoint?: string; modelName?: string }) => !!(p?.endpoint && p?.modelName);
            const a = messagingPort.getActiveAuxiliaryEndpoint();
            if (hasEndpoint(a)) return a!;
            const s = messagingPort.getActiveSummarizerEndpoint();
            if (hasEndpoint(s)) return s!;
            return messagingPort.getActiveStoryEndpoint();
        },
        incrementBookkeepingTurnCounter: () => messagingPort.incrementBookkeepingTurnCounter(),
        autoBookkeepingInterval: messagingPort.getAutoBookkeepingInterval(),
        resetBookkeepingTurnCounter: () => messagingPort.resetBookkeepingTurnCounter(),
        timeline: messagingPort.getTimeline(),
        pinnedChapterIds: messagingPort.getPinnedChapterIds(),
        clearPinnedChapters: () => messagingPort.clearPinnedChapters(),
        divergenceRegister: messagingPort.getDivergenceRegister(),
        onStageNpcIds: messagingPort.getOnStageNpcIds(),
        npcPressure: messagingPort.getNpcPressure(),
        pinnedExcerpts: messagingPort.getPinnedExcerpts(),
    };
}

// ── Launch reconciliation ──────────────────────────────────────────────
// On app launch, if any message has pendingCommit=true, fire handlePostTurn
// with the then-visible variant's text, then clear the marker. Covers
// WebView/renderer death mid-browse.
export async function reconcilePendingCommitOnLaunch(): Promise<void> {
    
    const pendingMsg = findPendingCommitMessage(messagingPort.getMessages());
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