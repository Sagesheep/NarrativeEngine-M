import { useState, useRef, useEffect, useMemo } from 'react';
import {
    Loader2, Zap, Trash2,
    ChevronDown, X, Pin
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import type { PipelinePhase, StreamingStats, LLMProvider } from '../types';
import { runTurn } from '../services/turn';
import { GenerationProgress } from './GenerationProgress';
import { useMessageEditor } from './hooks/useMessageEditor';
import { useCondenser } from './hooks/useCondenser';
import { toast } from './Toast';
import { api } from '../services/apiClient';
import { MessageBubble } from './chat/MessageBubble';

import { PinnedMemoriesPanel } from './chat/PinnedMemoriesPanel';
import { CreateTroubleButton } from './chat/CreateTroubleButton';
import { CreateTroubleModal } from './chat/CreateTroubleModal';

import { NPCPressureInspector } from './NPCPressureInspector';
import { ChatInput } from './chat/ChatInput';
import { UtilityCallStrip } from './UtilityCallStrip';

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
        clearArchive,
        updateLastAssistant,
        updateContext,
        setCondensed,
        resetCondenser,
        activeCampaignId,
        deleteMessage,
        deleteMessagesFrom,
        getActiveStoryEndpoint,
        getActiveSummarizerEndpoint,
        getActiveUtilityEndpoint,
        getActiveAuxiliaryEndpoint,
        addMessage,
        updateNPC,
        addNPC,
        archiveNPC,
        restoreNPC,
        updateLastMessage,
        setTimeline,
        deepArmed,
        setDeepArmed,
        setDivergenceRegister,
        updateMessageDivergence,
        pendingArcSeed,
        setPendingArcSeed,
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
        clearArchive: s.clearArchive,
        updateLastAssistant: s.updateLastAssistant,
        updateContext: s.updateContext,
        setCondensed: s.setCondensed,
        resetCondenser: s.resetCondenser,
        activeCampaignId: s.activeCampaignId,
        deleteMessage: s.deleteMessage,
        deleteMessagesFrom: s.deleteMessagesFrom,
        getActiveStoryEndpoint: s.getActiveStoryEndpoint,
        getActiveSummarizerEndpoint: s.getActiveSummarizerEndpoint,
        getActiveUtilityEndpoint: s.getActiveUtilityEndpoint,
        getActiveAuxiliaryEndpoint: s.getActiveAuxiliaryEndpoint,
        addMessage: s.addMessage,
        updateNPC: s.updateNPC,
        addNPC: s.addNPC,
        archiveNPC: s.archiveNPC,
        restoreNPC: s.restoreNPC,
        updateLastMessage: s.updateLastMessage,
        setTimeline: s.setTimeline,
        deepArmed: s.deepArmed,
        setDeepArmed: s.setDeepArmed,
        setDivergenceRegister: s.setDivergenceRegister,
        updateMessageDivergence: s.updateMessageDivergence,
        pendingArcSeed: s.pendingArcSeed,
        setPendingArcSeed: s.setPendingArcSeed,
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

        const useDeepScan = deepArmed && !!settings.enableDeepArchiveSearch;
        setDeepArmed(false);

        if (!overrideText) {
            setInput('');
            resetTextareaHeight();
        }

        const arcSeed = useAppStore.getState().pendingArcSeed;
        if (arcSeed) setPendingArcSeed(null);
        const llmInput = arcSeed ? `${textToUse}\n\n[SYS: Introduce this arc naturally going forward — ${arcSeed}]` : textToUse;

        abortControllerRef.current = new AbortController();

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
            divergenceRegister: useAppStore.getState().divergenceRegister,
            onStageNpcIds: useAppStore.getState().onStageNpcIds,
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
            archiveNPC,
            restoreNPC,
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

        setForcedAIs([]);
        setLoadingStatus(null);
    };

    const {
        editingMessageId,
        startEditing,
        cancelEditing,
        handleEditSubmit,
        handleRegenerate,
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

    useEffect(() => {
        if (pipelinePhase === 'generating') {
            streamStartRef.current = Date.now();
        }
    }, [pipelinePhase]);

    useEffect(() => {
        if (pipelinePhase !== 'generating') {
            // eslint-disable-next-line react-hooks/set-state-in-effect
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

    const handleStop = () => {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setStreaming(false);
        setIsCheckingNotes(false);
        useAppStore.getState().setPipelinePhase('idle');
        useAppStore.getState().setStreamingStats(null);
    };

    const handleClearArchive = async () => {
        if (!activeCampaignId || !window.confirm('Delete archive?')) return;
        try {
            await api.archive.clear(activeCampaignId);
            clearArchive();
        } catch {
            toast.error('Failed to clear archive');
        }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
            const newHeight = Math.min(inputRef.current.scrollHeight, 240);
            inputRef.current.style.height = `${newHeight}px`;
        }
    };

    const visibleMessages = useMemo(() => messages.filter(msg => msg.role !== 'tool').slice(-visibleCount), [messages, visibleCount]);

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
                        <div className="text-center space-y-3">
                            <div className="text-4xl">⚔</div>
                            <p className="text-text-dim text-xs uppercase tracking-widest">
                                Awaiting transmission...
                            </p>
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
                        onDelete={deleteMessage}
                        showReasoning={settings.showReasoning ?? false}
                        debugMode={settings.debugMode ?? false}
                    />
                ))}

                {isCheckingNotes || isStreaming ? (
                    <div className="flex items-center gap-2 text-terminal/80 text-[10px] uppercase tracking-widest px-4 py-2 bg-terminal/5 rounded-sm border border-terminal/10 mb-4 mx-2">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="animate-pulse">{isCheckingNotes ? 'GM is checking archives...' : 'Transmission in progress...'}</span>
                    </div>
                ) : null}
                <div ref={bottomRef} />
            </div>

            <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto no-scrollbar">
                <button onClick={() => { if (window.confirm('Trim conversation history? This condenses older messages.')) triggerTrim(); }} disabled={messages.length < 6} className="shrink-0 flex items-center gap-1.5 bg-void border border-terminal/30 text-terminal text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all disabled:opacity-40 whitespace-nowrap overflow-hidden">
                    <Zap size={13} /> TRIM
                </button>
                <CreateTroubleButton />
                <button
                    onClick={() => setPinnedPanelOpen(true)}
                    className="relative shrink-0 flex items-center gap-1.5 bg-void border border-terminal/20 text-text-dim hover:text-terminal text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all hover:bg-terminal/5 hover:border-terminal/40 whitespace-nowrap overflow-hidden"
                    title="View pinned memories"
                >
                    <Pin size={13} /> PINS
                    {pinnedExcerpts.length > 0 && (
                        <span className="absolute -top-1 -right-1 min-w-[16px] h-4 bg-terminal text-void text-[9px] font-bold rounded-full flex items-center justify-center px-1">
                            {pinnedExcerpts.length}
                        </span>
                    )}
                </button>
                <button onClick={handleClearArchive} disabled={!activeCampaignId} className="shrink-0 flex items-center gap-1.5 bg-void border border-red-500/20 text-red-500/60 hover:text-red-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all hover:bg-red-500/5 hover:border-red-500/40 disabled:opacity-40 whitespace-nowrap overflow-hidden"><Trash2 size={13} /> CLEAR</button>
            </div>

            <PinnedMemoriesPanel open={pinnedPanelOpen} onClose={() => setPinnedPanelOpen(false)} />



            <NPCPressureInspector />

            <GenerationProgress phase={pipelinePhase} stats={streamingStats} />

            {loadingStatus && (
                <div className="py-1.5 px-4 bg-terminal/10 border-b border-terminal/20 flex items-center gap-2 animate-pulse">
                    <Loader2 size={10} className="animate-spin text-terminal" />
                    <span className="text-[9px] uppercase tracking-widest text-terminal font-bold">{loadingStatus}</span>
                </div>
            )}
            <UtilityCallStrip />

            {pendingArcSeed && (
                <div className="px-2 md:px-4 py-1 flex items-center gap-2 bg-amber-500/10 border-t border-amber-500/20">
                    <span className="text-[9px] uppercase tracking-widest text-amber-400 font-bold flex-1 truncate">⚡ Arc queued — fires on next send</span>
                    <button onClick={() => setPendingArcSeed(null)} className="text-amber-400/60 hover:text-amber-400 shrink-0"><X size={12} /></button>
                </div>
            )}

            <ChatInput
                input={input}
                isStreaming={isStreaming}
                onChange={handleInputChange}
                onSend={() => handleSend()}
                onStop={handleStop}
                inputRef={inputRef}
            />

            {showScrollFab && (
                <button onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })} className="fixed bottom-[calc(160px+env(safe-area-inset-bottom))] right-4 z-50 w-10 h-10 rounded-full bg-terminal text-surface shadow-lg flex items-center justify-center"><ChevronDown size={20} /></button>
            )}

            <CreateTroubleModal onSelect={(opt) => { setPendingArcSeed(opt); }} />
        </div>
    );
}
