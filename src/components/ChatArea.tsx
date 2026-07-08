import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
    Loader2,
    ChevronDown, ChevronUp, X
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import type { PipelinePhase, StreamingStats, LLMProvider } from '../types';
import { runTurn, commitPendingTurn, findRetryableMessage } from '../services/turn';
import { TelemetryStrip } from './TelemetryStrip';
import { useMessageEditor } from './hooks/useMessageEditor';
import { useCondenser } from './hooks/useCondenser';
import { toast } from './Toast';
import { MessageBubble } from './chat/MessageBubble';

import { PinnedMemoriesPanel } from './chat/PinnedMemoriesPanel';

import { ChatInput } from './chat/ChatInput';
import { appConfirm } from './ConfirmSheet';
import { hapticLight } from '../utils/haptics';
import { ActionSpeedDial } from './chat/ActionSpeedDial';
import { RenameNpcModal } from './chat/RenameNpcModal';
import { PCCreationWizard } from './pc/PCCreationWizard';
import { RegenerateSheet } from './chat/RegenerateSheet';
import { useSwipeVariants } from './hooks/useSwipeVariants';
import { useRetryStoryAI } from './hooks/useRetryStoryAI';

export function ChatArea() {
    const {
        messages,
        settings,
        context,
        condenser,
        loreChunks,
        npcLedger,
        archiveIndex,
        setArchiveIndex,
        setChapters,
        setSemanticFacts,
        updateLastAssistant,
        updateContext,
        setCondensed,
        resetCondenser,
        activeCampaignId,
        deleteMessagesFrom,
        getActiveStoryEndpoint,
        getActiveSummarizerEndpoint,
        getActiveUtilityEndpoint,
        getActiveAuxiliaryEndpoint,
        addMessage,
            updateNPC,
            addNPC,
        updateLastMessage,
        setTimeline,
        deepArmed,
        setDeepArmed,
        armedRoll,
        setArmedRoll,
        armedLoot,
        clearArmedLoot,
        setDivergenceRegister,
        updateMessageDivergence,
        pinnedExcerpts,
    } = useAppStore(useShallow(s => ({
        messages: s.messages,
        settings: s.settings,
        context: s.context,
        condenser: s.condenser,
        loreChunks: s.loreChunks,
        npcLedger: s.npcLedger,
        archiveIndex: s.archiveIndex,
        setArchiveIndex: s.setArchiveIndex,
        setChapters: s.setChapters,
        setSemanticFacts: s.setSemanticFacts,
        updateLastAssistant: s.updateLastAssistant,
        updateContext: s.updateContext,
        setCondensed: s.setCondensed,
        resetCondenser: s.resetCondenser,
        activeCampaignId: s.activeCampaignId,
        deleteMessagesFrom: s.deleteMessagesFrom,
        getActiveStoryEndpoint: s.getActiveStoryEndpoint,
        getActiveSummarizerEndpoint: s.getActiveSummarizerEndpoint,
        getActiveUtilityEndpoint: s.getActiveUtilityEndpoint,
        getActiveAuxiliaryEndpoint: s.getActiveAuxiliaryEndpoint,
        addMessage: s.addMessage,
        updateNPC: s.updateNPC,
        addNPC: s.addNPC,
        updateLastMessage: s.updateLastMessage,
        setTimeline: s.setTimeline,
        deepArmed: s.deepArmed,
        setDeepArmed: s.setDeepArmed,
        armedRoll: s.armedRoll,
        setArmedRoll: s.setArmedRoll,
        armedLoot: s.armedLoot,
        clearArmedLoot: s.clearArmedLoot,
        setDivergenceRegister: s.setDivergenceRegister,
        updateMessageDivergence: s.updateMessageDivergence,
        pinnedExcerpts: s.pinnedExcerpts,
    })));

    const [input, setInput] = useState('');
    const [isStreaming, setStreaming] = useState(false);
    const [pinnedPanelOpen, setPinnedPanelOpen] = useState(false);
    const [isCheckingNotes, setIsCheckingNotes] = useState(false);
    const [visibleCount, setVisibleCount] = useState(10);
    const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
    const [forcedAIs, setForcedAIs] = useState<('enemy' | 'neutral' | 'ally')[]>([]);
    const [showScrollFab, setShowScrollFab] = useState(false);
    const [showPCCreator, setShowPCCreator] = useState(false);
    const [swipeSheetMessageId, setSwipeSheetMessageId] = useState<string | null>(null);

    // Swipe Generation v1: the hook must be keyed on the PENDING message id
    // (the latest GM message with a swipe set), NOT on whether the sheet is
    // open. The bubble's touch-swipe gestures call prevSwipe/generateSwipe
    // even when the sheet is closed. The sheet reads from the same hook via props.
    const pendingMessageId = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'assistant' && m.pendingCommit && m.swipeSet?.length) return m.id;
            if (m.role === 'system' && m.name === 'scene-marker') break;
        }
        return null;
    }, [messages]);

    const swipe = useSwipeVariants(pendingMessageId);
    const retry = useRetryStoryAI();

    const [streamingStats, setStreamingStatsLocal] = useState<StreamingStats | null>(null);
    const streamStartRef = useRef<number>(0);
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    const resetTextareaHeight = () => {
        if (inputRef.current) inputRef.current.style.height = '40px';
    };

    const handleSend = async (overrideText?: string) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming) return;

        // Claim the turn synchronously so taps can't fire duplicate turns and the Stop
        // button appears immediately (not only once runTurn starts streaming).
        setStreaming(true);
        const turnAbort = (abortControllerRef.current = new AbortController());

        if (turnAbort.signal.aborted) { setStreaming(false); return; }

        const useDeepScan = deepArmed && !!settings.enableDeepArchiveSearch;
        setDeepArmed(false);

        // Consume the armed dice mode (cleared whether or not a roll was set this turn).
        const useArmedRoll = armedRoll;
        setArmedRoll(null);

        // Loot Engine WO-05: consume the armed loot drop (cleared whether or not
        // one was set this turn). Mirrors the dice capture-and-clear above.
        const useArmedLoot = armedLoot;
        clearArmedLoot();

        if (!overrideText) {
            setInput('');
            resetTextareaHeight();
        }

        const llmInput = textToUse;

        try {
            // Swipe Generation v1: commit any pending swipe turn BEFORE the next
            // turn's gatherContext (handlePostTurn clears agencyDigest/arcDigest
            // and appends the archive scene the next payload builds against).
            // Ordering: commit is awaited before runTurn starts.
            await commitPendingTurn();
            // Smart Retry v1: clear stale `retryable` on any old bubble before the
            // new turn starts. The snapshot was just nulled by commitPendingTurn's
            // no-pending-message branch, so any prior Retry button is now dead —
            // hide it so the user doesn't tap a button that can't resolve.
            const staleRetry = findRetryableMessage(useAppStore.getState().messages);
            if (staleRetry) {
                useAppStore.getState().updateMessage(staleRetry.id, { retryable: undefined, precontext: undefined });
            }
            await runTurn({
            input: llmInput,
            displayInput: textToUse,
            settings,
            context,
            messages: useAppStore.getState().messages,
            condenser,
            loreChunks,
            npcLedger,
            archiveIndex,
            semanticFacts: useAppStore.getState().semanticFacts,
            chapters: useAppStore.getState().chapters,
            activeCampaignId,
            provider: getActiveStoryEndpoint(),
            getMessages: () => useAppStore.getState().messages,
            getFreshProvider: () => getActiveStoryEndpoint(),
            getFreshSummarizerProvider: () => {
                const s = getActiveSummarizerEndpoint?.();
                return (s?.endpoint && s?.modelName) ? s : undefined;
            },
            getUtilityEndpoint: () => getActiveUtilityEndpoint(),
            getFreshAuxiliaryProvider: () => {
                const aux = getActiveAuxiliaryEndpoint?.();
                return aux?.modelName ? aux : getActiveStoryEndpoint();
            },
            getExtractionProvider: () => {
                const hasEndpoint = (p?: LLMProvider) => !!(p?.endpoint && p?.modelName);
                const a = getActiveAuxiliaryEndpoint?.();
                if (hasEndpoint(a)) return a!;
                const s = getActiveSummarizerEndpoint?.();
                if (hasEndpoint(s)) return s!;
                return getActiveStoryEndpoint();
            },
            forcedInterventions: forcedAIs,
            incrementBookkeepingTurnCounter: () => useAppStore.getState().incrementBookkeepingTurnCounter(),
            autoBookkeepingInterval: useAppStore.getState().autoBookkeepingInterval,
            resetBookkeepingTurnCounter: () => useAppStore.getState().resetBookkeepingTurnCounter(),
            timeline: useAppStore.getState().timeline,
            pinnedChapterIds: useAppStore.getState().pinnedChapterIds,
            clearPinnedChapters: () => useAppStore.getState().clearPinnedChapters(),
            deepContextSearch: useDeepScan,
            armedRoll: useArmedRoll,
            armedLoot: useArmedLoot,
            divergenceRegister: useAppStore.getState().divergenceRegister,
            onStageNpcIds: useAppStore.getState().onStageNpcIds,
            pinnedExcerpts: useAppStore.getState().pinnedExcerpts,
        }, {
            onCheckingNotes: setIsCheckingNotes,
            addMessage,
            updateLastAssistant,
            updateLastMessage: (patch) => {
                if (messages.length > 0) updateLastMessage(patch);
            },
            updateContext,
            setArchiveIndex,
            updateNPC,
        addNPC,
        addNpcSuggestions: (names: string[], context?: string) => useAppStore.getState().addNpcSuggestions(names, context),
            setCondensed,
            setStreaming,
            setLoadingStatus,
            setLastPayloadTrace: useAppStore.getState().setLastPayloadTrace,
            setSemanticFacts,
            setChapters,
            setPipelinePhase: (phase: PipelinePhase) => useAppStore.getState().setPipelinePhase(phase),
            setStreamingStats: (stats: StreamingStats | null) => useAppStore.getState().setStreamingStats(stats),
            setDivergenceRegister: (reg) => { setDivergenceRegister(reg); if (activeCampaignId) import('../store/campaignStore').then(m => m.saveDivergenceRegister(activeCampaignId, reg)); },
            updateMessageDivergence: updateMessageDivergence,
            setOnStageNpcIds: (ids) => useAppStore.getState().setOnStageNpcIds(ids),
        }, abortControllerRef.current!);
        } finally {
            setForcedAIs([]);
            setLoadingStatus(null);
        }
    };

    const {
        editingMessageId,
        startEditing,
        cancelEditing,
        handleEditSubmit,
        handleRegenerate,
        handleDeleteOutput,
    } = useMessageEditor({
        messages,
        activeCampaignId,
        archiveIndex,
        condenser,
        setArchiveIndex,
        setChapters,
        setTimeline,
        resetCondenser,
        deleteMessagesFrom,
        onAfterEdit: (text) => handleSend(text),
        onAfterRegenerate: (text) => handleSend(text),
    });

    const {
        triggerCondense: triggerTrim,
    } = useCondenser({
        messages,
        condenser,
        setCondensed,
        resetCondenser,
    });


    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const keyboardVisible = useAppStore(s => s.keyboardVisible);

    useEffect(() => {
        if (pipelinePhase === 'generating') {
            streamStartRef.current = Date.now();
        }
    }, [pipelinePhase]);

    // When the soft keyboard opens, keep the latest message in view (the nav bar
    // disappears and the viewport shrinks, so the tail would otherwise be hidden).
    useEffect(() => {
        if (keyboardVisible) {
            requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }));
        }
    }, [keyboardVisible]);

    useEffect(() => {
        if (pipelinePhase !== 'generating') {
            setStreamingStatsLocal(null);
            return;
        }
        const interval = setInterval(() => {
            const msgs = useAppStore.getState().messages;
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== 'assistant') return;
            const tokens = Math.round(last.content.length / 4);
            const elapsed = Date.now() - streamStartRef.current;
            const speed = elapsed > 0 ? (tokens / (elapsed / 1000)) : 0;
            setStreamingStatsLocal({ tokens, elapsed, speed });
        }, 500);
        return () => clearInterval(interval);
    }, [pipelinePhase]);

    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const handleScroll = () => {
            const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            setShowScrollFab(distFromBottom > 400);
        };
        el.addEventListener('scroll', handleScroll, { passive: true });
        return () => el.removeEventListener('scroll', handleScroll);
    }, []);

    const scrollToPrevMessage = () => {
        const container = scrollContainerRef.current;
        if (!container) return;
        const els = Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-message-id]'));
        if (!els.length) return;
        const cTop = container.getBoundingClientRect().top;
        const threshold = 4;
        // step up to the message whose top sits just above the viewport top
        let target: HTMLElement | null = null;
        for (const el of els) {
            if (el.getBoundingClientRect().top - cTop < -threshold) target = el;
            else break;
        }
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else container.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleStop = () => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setStreaming(false);
        setIsCheckingNotes(false);
        useAppStore.getState().setPipelinePhase('idle');
        useAppStore.getState().setStreamingStats(null);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
            const newHeight = Math.min(inputRef.current.scrollHeight, 240);
            inputRef.current.style.height = `${newHeight}px`;
        }
    };

    const stableDeleteMessage = useCallback((id: string) => handleDeleteOutput(id), [handleDeleteOutput]);

    const visibleMessages = useMemo(() => messages.filter(msg => msg.role !== 'tool').slice(-visibleCount), [messages, visibleCount]);

    // Map tool_call_id -> result content, sourced from the (filtered-out) `tool` role
    // messages, so each assistant bubble can surface what its tool call returned.
    const toolResultById = useMemo(() => {
        const map = new Map<string, string>();
        for (const m of messages) {
            if (m.role === 'tool' && m.tool_call_id) map.set(m.tool_call_id, m.content);
        }
        return map;
    }, [messages]);

    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative md:pb-0">
            {context.sceneNoteActive && (
                <div className="absolute top-0 left-0 right-0 z-20 px-4 py-1.5 bg-amber/90 backdrop-blur-sm border-b border-amber/40 flex items-center justify-between text-[10px] text-void-dark font-bold uppercase tracking-widest animate-in slide-in-from-top duration-300">
                    <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-void-dark animate-pulse" />
                        Active Scene Note: {context.sceneNote.slice(0, 50)}{context.sceneNote.length > 50 ? '...' : ''}
                    </div>
                    <button
                        onClick={() => updateContext({ sceneNoteActive: false })}
                        className="hover:opacity-60 transition-opacity"
                        title="Dismiss banner"
                    >
                        <X size={12} strokeWidth={3} />
                    </button>
                </div>
            )}

            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3 relative">
                {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center space-y-4">
                            <div className="text-4xl">⚔</div>
                            <p className="text-text-dim text-xs uppercase tracking-widest">
                                Awaiting transmission...
                            </p>
                            <div className="space-y-2">
                                <button
                                    onClick={() => setShowPCCreator(true)}
                                    className="block w-full px-6 py-2.5 bg-terminal/20 text-terminal border border-terminal/30 rounded hover:bg-terminal/30 transition-colors text-[11px] uppercase tracking-widest"
                                >
                                    Create Character
                                </button>
                                {(() => {
                                    const auxProvider = useAppStore.getState().getActiveAuxiliaryEndpoint?.();
                                    return auxProvider ? (
                                        <p className="text-[9px] text-text-dim">
                                            Or type a message to begin — you can create a character later from the NPC ledger.
                                        </p>
                                    ) : (
                                        <p className="text-[9px] text-text-dim">
                                            Type a message to begin. Configure an auxiliary AI in settings for guided character creation.
                                        </p>
                                    );
                                })()}
                            </div>
                        </div>
                    </div>
                )}

                {messages.length > visibleCount && (
                    <div className="flex justify-center py-2">
                        <button
                            onClick={() => setVisibleCount(p => p + 20)}
                            className="text-xs text-terminal/70 hover:text-terminal bg-terminal/10 hover:bg-terminal/20 px-4 py-2 rounded transition-colors border border-terminal/10"
                        >
                            ↑ Load older messages... ({messages.length - visibleCount} hidden)
                        </button>
                    </div>
                )}

                {visibleMessages.map((msg, idx) => (
                    <MessageBubble
                        key={msg.id}
                        msg={msg}
                        isStreaming={isStreaming}
                        isLastMessage={idx === visibleMessages.length - 1}
                        isEditing={editingMessageId === msg.id}
                        onStartEdit={startEditing}
                        onCancelEdit={cancelEditing}
                        onSubmitEdit={handleEditSubmit}
                        onRegenerate={handleRegenerate}
                        onDelete={stableDeleteMessage}
                        showReasoning={settings.showReasoning ?? false}
                        debugMode={settings.debugMode ?? false}
                        toolResult={msg.tool_calls?.[0] ? toolResultById.get(msg.tool_calls[0].id) : undefined}
                        onOpenSwipeSheet={(id) => setSwipeSheetMessageId(id)}
                        onSwipeNavigate={(_id, direction) => {
                            // Touch-swipe on the bubble navigates EXISTING filled slots.
                            // New variants are generated only via the Generate button in the
                            // sheet (with optional guidance), not by swiping past the end.
                            hapticLight();
                            if (direction === 'prev') swipe.prevSwipe();
                            else swipe.nextSwipe();
                        }}
                        onRetry={(id) => retry.retryStoryAI(id)}
                    />
                ))}

                {isCheckingNotes || isStreaming ? (
                    <div className="flex items-center gap-2 text-terminal/80 text-[10px] uppercase tracking-widest px-4 py-2 bg-terminal/5 rounded-sm border border-terminal/10 mb-4 mx-2">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="animate-pulse">
                            {isCheckingNotes
                                ? 'GM is checking archives...'
                                : pipelinePhase === 'gathering-context' || pipelinePhase === 'building-prompt'
                                    ? 'GM is gathering context...'
                                    : 'Transmission in progress...'}
                        </span>
                    </div>
                ) : null}
                <div ref={bottomRef} />
            </div>

            <PinnedMemoriesPanel open={pinnedPanelOpen} onClose={() => setPinnedPanelOpen(false)} />

            {messages.length > 1 && (
                <div className="relative z-40">
                    <div className="absolute bottom-full right-3 mb-2 flex flex-col gap-2">
                        <button
                            onClick={scrollToPrevMessage}
                            title="Jump to previous message"
                            className="w-11 h-11 rounded-full bg-terminal text-surface shadow-lg flex items-center justify-center"
                        >
                            <ChevronUp size={20} />
                        </button>
                        {showScrollFab && (
                            <button
                                onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
                                title="Jump to latest message"
                                className="w-11 h-11 rounded-full bg-terminal text-surface shadow-lg flex items-center justify-center"
                            >
                                <ChevronDown size={20} />
                            </button>
                        )}
                    </div>
                </div>
            )}

            <TelemetryStrip phase={pipelinePhase} stats={streamingStats} loadingStatus={loadingStatus} />


            <ChatInput
                input={input}
                isStreaming={isStreaming}
                onChange={handleInputChange}
                onSend={() => handleSend()}
                onStop={handleStop}
                inputRef={inputRef}
                leading={
                    <ActionSpeedDial
                        onTrim={async () => { if (await appConfirm({ title: 'Trim history', body: 'Trim conversation history? This condenses older messages.', confirmLabel: 'Trim' })) triggerTrim(); }}
                        pinnedCount={pinnedExcerpts.length}
                        onOpenPins={() => setPinnedPanelOpen(true)}
                        trimDisabled={messages.length < 6}
                    />
                }
            />

            <RenameNpcModal />

            {showPCCreator && (
                <PCCreationWizard
                    onComplete={(result) => {
                        useAppStore.getState().updateNPC(result.npcEntry.id, { ...result.npcEntry });
                        useAppStore.getState().updateContext({
                            characterProfile: result.characterProfile,
                            characterProfileActive: true,
                            characterProfileUserDisabled: false,
                        });
                        setShowPCCreator(false);
                        toast.success(`Character "${result.npcEntry.name}" created!`);
                    }}
                    onCancel={() => setShowPCCreator(false)}
                />
            )}

            <RegenerateSheet
                messageId={swipeSheetMessageId}
                onClose={() => setSwipeSheetMessageId(null)}
                swipeGenLoading={swipe.swipeGenLoading}
                generateSwipe={swipe.generateSwipe}
                nextSwipe={swipe.nextSwipe}
                prevSwipe={swipe.prevSwipe}
                getSessionOffset={swipe.getSessionOffset}
                setSessionOffset={swipe.setSessionOffset}
                getSwipeTemperature={swipe.getSwipeTemperature}
            />
        </div>
    );
}
