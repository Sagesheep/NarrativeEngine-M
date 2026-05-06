import { useState, useRef, useEffect } from 'react';
import { 
    Save, Loader2, Zap, Scroll, Trash2, Square,
    ChevronDown, ChevronUp, X
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { PipelinePhase, StreamingStats, ChatMessage } from '../types';
import { runTurn } from '../services/turnOrchestrator';
import { GenerationProgress } from './GenerationProgress';
import { useMessageEditor } from './hooks/useMessageEditor';
import { useCondenser } from './hooks/useCondenser';
import { api } from '../services/apiClient';
import { set } from 'idb-keyval';
import { toast } from './Toast';
import { MessageBubble } from './chat/MessageBubble';
import { CondensedMemoryPanel } from './chat/CondensedMemoryPanel';
import { NPCPressureInspector } from './NPCPressureInspector';
import { ChatInput } from './chat/ChatInput';
import { extractDivergences, mergeEntries, EMPTY_REGISTER } from '../services/divergenceRegister';

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
        setCondensing,
        resetCondenser,
        activeCampaignId,
        deleteMessage,
        deleteMessagesFrom,
        getActiveStoryEndpoint,
        getActiveSummarizerEndpoint,
        getActiveUtilityEndpoint,
        addMessage,
        updateNPC,
        addNPC,
        archiveNPC,
        restoreNPC,
        updateLastMessage,
        setTimeline,
        deepArmed,
        setDeepArmed,
        divergenceRegister,
        setDivergenceRegister,
        updateMessageDivergence,
    } = useAppStore();

    const [input, setInput] = useState('');
    const [isStreaming, setStreaming] = useState(false);
    const [isCheckingNotes, setIsCheckingNotes] = useState(false);
    const [visibleCount, setVisibleCount] = useState(10);
    const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
    const [forcedAIs, setForcedAIs] = useState<('enemy' | 'neutral' | 'ally')[]>([]);
    const [showScrollFab, setShowScrollFab] = useState(false);
    const [showCondensedPanel, setShowCondensedPanel] = useState(false);
    const [streamingStats, setStreamingStatsLocal] = useState<StreamingStats | null>(null);
    const [isSaving, setIsSaving] = useState(false);
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

        abortControllerRef.current = new AbortController();

        await runTurn({
            input: textToUse,
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
            getFreshSummarizerProvider: () => getActiveSummarizerEndpoint?.() ?? getActiveStoryEndpoint(),
            getUtilityEndpoint: () => getActiveUtilityEndpoint(),
            forcedInterventions: forcedAIs,
            incrementBookkeepingTurnCounter: () => useAppStore.getState().incrementBookkeepingTurnCounter(),
            autoBookkeepingInterval: useAppStore.getState().autoBookkeepingInterval,
            resetBookkeepingTurnCounter: () => useAppStore.getState().resetBookkeepingTurnCounter(),
            timeline: useAppStore.getState().timeline,
            pinnedChapterIds: useAppStore.getState().pinnedChapterIds,
            clearPinnedChapters: () => useAppStore.getState().clearPinnedChapters(),
            deepContextSearch: useDeepScan,
            divergenceRegister: useAppStore.getState().divergenceRegister,
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
            setCondensing,
            setStreaming,
            setLoadingStatus,
            setLastPayloadTrace: useAppStore.getState().setLastPayloadTrace,
            setSemanticFacts,
            setChapters,
            setPipelinePhase: (phase: PipelinePhase) => useAppStore.getState().setPipelinePhase(phase),
            setStreamingStats: (stats: StreamingStats | null) => useAppStore.getState().setStreamingStats(stats),
            setDivergenceRegister: (reg) => { setDivergenceRegister(reg); if (activeCampaignId) import('../store/campaignStore').then(m => m.saveDivergenceRegister(activeCampaignId, reg)); },
            updateMessageDivergence: updateMessageDivergence,
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
        input,
        setInput,
        inputRef: inputRef as React.RefObject<HTMLTextAreaElement>,
        resetTextareaHeight,
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
        triggerCondense,
        condenseAbortRef,
        condensePhase,
        saveProgress,
        editingSummary,
        setEditingSummary,
        summaryDraft,
        setSummaryDraft,
        handleRetcon,
    } = useCondenser({
        activeCampaignId,
        isStreaming,
        messages,
        condenser,
        settings,
        context,
        npcLedger,
        setCondensed,
        setCondensing,
        resetCondenser,
        updateContext,
        setArchiveIndex,
        setSemanticFacts,
        getActiveSummarizerEndpoint: () => getActiveSummarizerEndpoint?.() ?? getActiveStoryEndpoint(),
        getActiveStoryEndpoint: () => getActiveStoryEndpoint(),
    });

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

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

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
            const newHeight = Math.min(inputRef.current.scrollHeight, 240);
            inputRef.current.style.height = `${newHeight}px`;
        }
    };

    const handleForceSave = () => {
        setIsSaving(true);
        const state = useAppStore.getState();
        if (state.activeCampaignId) {
            try {
                set(`nn_settings`, { settings: state.settings, activeCampaignId: state.activeCampaignId });
                set(`nn_campaign_${state.activeCampaignId}_state`, { context: state.context, messages: state.messages, condenser: state.condenser });
                set(`nn_campaign_${state.activeCampaignId}_npcs`, state.npcLedger);
                toast.success('Campaign saved');
            } catch {
                toast.error('Save failed');
            }
        }
        setTimeout(() => setIsSaving(false), 2000);
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

    const handleTagDivergence = async (msg: ChatMessage) => {
        if (!activeCampaignId) return;
        const provider = getActiveStoryEndpoint();
        if (!provider) { toast.error('No story AI endpoint configured'); return; }

        toast.info('Scanning for divergences...');
        try {
            const clickedIdx = messages.findIndex(m => m.id === msg.id);
            if (clickedIdx === -1) { toast.error('Message not found'); return; }
            const startIdx = Math.max(0, clickedIdx - 10);
            const windowMessages = messages.slice(startIdx, clickedIdx + 1);

            const archiveIndexData = await api.archive.getIndex(activeCampaignId);
            const { buildSceneMap: buildSceneMapFn } = await import('../services/divergenceRegister');
            const { sceneIdsByMessageId } = buildSceneMapFn(archiveIndexData, messages);

            const sceneText = windowMessages.map(m => {
                const sid = sceneIdsByMessageId[m.id] || 'manual';
                return `[Scene #${sid}][${m.role.toUpperCase()}]: ${m.content || ''}`;
            }).join('\n\n');

            const clickedSceneId = sceneIdsByMessageId[msg.id] || 'manual';
            const currentRegister = divergenceRegister || EMPTY_REGISTER;

            const { entries } = await extractDivergences(
                provider,
                sceneText,
                clickedSceneId,
                currentRegister,
                { forceExtract: true, multiScene: true }
            );
            if (entries.length > 0) {
                const merged = mergeEntries(currentRegister, entries, clickedSceneId);
                setDivergenceRegister(merged);
                updateMessageDivergence(msg.id, entries.map(e => e.id));
                const { saveDivergenceRegister } = await import('../store/campaignStore');
                await saveDivergenceRegister(activeCampaignId, merged);
                toast.success(`${entries.length} divergence${entries.length > 1 ? 's' : ''} captured`);
            } else {
                toast.info('No divergences found');
            }
        } catch (err) {
            console.warn('[TagDivergence] failed:', err);
            toast.error('Divergence scan failed');
        }
    };

    const visibleMessages = messages.filter(msg => msg.role !== 'tool').slice(-visibleCount);

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

            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3">
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
                        onEdit={startEditing}
                        onRegenerate={handleRegenerate}
                        onDelete={deleteMessage}
                        showReasoning={settings.showReasoning ?? false}
                        debugMode={settings.debugMode ?? false}
                        onTagDivergence={handleTagDivergence}
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
                <button onClick={handleForceSave} disabled={isSaving} className="flex items-center gap-1.5 bg-void border border-emerald-500/30 text-emerald-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all">
                    {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} SAVE
                </button>
                {(settings.enableLegacyCondenser !== false) && (condenser.isCondensing ? (
                    <button onClick={() => condenseAbortRef.current?.abort()} className="flex items-center gap-1.5 bg-void border border-amber-500/30 text-amber-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all">
                        <Square size={13} /> STOP
                    </button>
                ) : (
                    <button onClick={triggerCondense} disabled={messages.length < 6} className="flex items-center gap-1.5 bg-void border border-terminal/30 text-terminal text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all">
                        <Zap size={13} /> CONDENSE
                    </button>
                ))}
                <button onClick={() => setShowCondensedPanel(p => !p)} className={`flex items-center gap-1.5 bg-void border ${showCondensedPanel ? 'border-terminal text-terminal' : 'border-ice/30 text-ice'} text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all`}>
                    {showCondensedPanel ? <ChevronUp size={13} /> : <ChevronDown size={13} />} MEMORY
                </button>

                <button onClick={() => api.archive.open(activeCampaignId || '')} className="flex items-center gap-1.5 bg-void border border-ice/30 text-ice text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded ml-auto transition-all hover:bg-ice/5"><Scroll size={13} /> ARCHIVE</button>
                <button onClick={handleClearArchive} disabled={!activeCampaignId} className="flex items-center gap-1.5 bg-void border border-red-500/20 text-red-500/60 hover:text-red-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all hover:bg-red-500/5 hover:border-red-500/40"><Trash2 size={13} /> CLEAR</button>
            </div>

            <CondensedMemoryPanel
                condenser={condenser}
                editingSummary={editingSummary}
                summaryDraft={summaryDraft}
                showCondensedPanel={showCondensedPanel}
                onToggle={() => setShowCondensedPanel(false)}
                onStartEdit={() => { setSummaryDraft(condenser.condensedSummary); setEditingSummary(true); }}
                onCancelEdit={() => setEditingSummary(false)}
                onSaveEdit={() => { setCondensed(summaryDraft, condenser.condensedUpToIndex); setEditingSummary(false); }}
                onSetDraft={setSummaryDraft}
                onRetcon={handleRetcon}
                onReset={() => { resetCondenser(); setEditingSummary(false); }}
                divergenceRegister={divergenceRegister}
                onSetDivergenceRegister={setDivergenceRegister}
                tokenBudget={settings.divergenceTokenBudget ?? 2000}
                provider={getActiveStoryEndpoint()}
                onSaveDivergence={() => {
                    if (activeCampaignId) {
                        import('../store/campaignStore').then(m => m.saveDivergenceRegister(activeCampaignId, useAppStore.getState().divergenceRegister));
                    }
                }}
            />

            <NPCPressureInspector />

            <GenerationProgress phase={pipelinePhase} stats={streamingStats} />

            {condenser.isCondensing && (
                <div className="py-1.5 px-4 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between">
                    <div className="flex items-center gap-2 animate-pulse">
                        <Loader2 size={10} className="animate-spin text-amber-500" />
                        <span className="text-[9px] uppercase tracking-widest text-amber-500 font-bold">
                            {condensePhase === 'save'
                                ? saveProgress
                                    ? `Archiving session state... (${saveProgress.phase} ${saveProgress.batch}/${saveProgress.totalBatches})`
                                    : 'Archiving session state...'
                                : condensePhase === 'extract'
                                    ? 'Scanning for divergences...'
                                    : 'Compressing history...'}
                        </span>
                    </div>
                    <button
                        onClick={() => condenseAbortRef.current?.abort()}
                        className="text-[9px] text-amber-500/60 hover:text-amber-500 uppercase tracking-wider transition-colors"
                    >
                        Stop
                    </button>
                </div>
            )}

            {loadingStatus && (
                <div className="py-1.5 px-4 bg-terminal/10 border-b border-terminal/20 flex items-center gap-2 animate-pulse">
                    <Loader2 size={10} className="animate-spin text-terminal" />
                    <span className="text-[9px] uppercase tracking-widest text-terminal font-bold">{loadingStatus}</span>
                </div>
            )}

            <ChatInput
                input={input}
                isStreaming={isStreaming}
                isCondensing={condenser.isCondensing}
                editingMessageId={editingMessageId}
                onChange={handleInputChange}
                onSend={() => handleSend()}
                onStop={handleStop}
                onEditSubmit={handleEditSubmit}
                onCancelEdit={cancelEditing}
                inputRef={inputRef}
            />

            {showScrollFab && (
                <button onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })} className="fixed bottom-[calc(160px+env(safe-area-inset-bottom))] right-4 z-50 w-10 h-10 rounded-full bg-terminal text-surface shadow-lg flex items-center justify-center"><ChevronDown size={20} /></button>
            )}
        </div>
    );
}
