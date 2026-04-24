import React, { useState, useRef, useEffect } from 'react';
import { 
    Send, Save, Loader2, Zap, Scroll, Edit2, RotateCcw, Trash2, Check, X, Square, 
    Terminal, Dice5, ChevronDown, ChevronUp
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../store/useAppStore';
import type { PipelinePhase, StreamingStats } from '../types';
import { runTurn } from '../services/turnOrchestrator';
import { GenerationProgress } from './GenerationProgress';
import { useMessageEditor } from './hooks/useMessageEditor';
import { useCondenser } from './hooks/useCondenser';
import { api } from '../services/apiClient';
import { set } from 'idb-keyval';
import { toast } from './Toast';

function renderContentWithChips(content: string) {
    const parts = content.split(/(\[[\s\S]*?\])/g);
    return parts.map((part, i) => {
        if (part.startsWith('[') && part.endsWith(']')) {
            const tag = part.slice(1, -1);
            const isDice = tag.includes('D20:') || tag.includes('DICE OUTCOMES:');
            const isEvent = tag.includes('EVENT:') || tag.includes('SURPRISE') || tag.includes('ENCOUNTER');
            const isWorld = tag.includes('WORLD_EVENT');

            return (
                <span
                    key={i}
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 mx-0.5 my-0.5 rounded border text-[10px] font-black uppercase tracking-widest leading-none align-middle shadow-sm transition-all hover:scale-105 active:scale-95 cursor-default select-none ${
                    isDice ? 'bg-terminal/10 border-terminal/30 text-terminal' :
                        isEvent ? 'bg-amber-500/10 border-amber-500/30 text-amber-500' :
                            isWorld ? 'bg-red-500/10 border-red-500/30 text-red-500' :
                                'bg-ice/10 border-ice/30 text-ice'
                    }`}
                >
                    {isDice ? <Dice5 size={10} strokeWidth={3} /> : <Terminal size={10} strokeWidth={3} />}
                    {tag}
                </span>
            );
        }
        return (
            <div key={i} className="text-text-primary/90 leading-relaxed">
                <ReactMarkdown
                    components={{
                        strong: ({children}) => <strong className="text-terminal font-black">{children}</strong>,
                        em: ({children}) => <em className="text-ice italic opacity-90">{children}</em>
                    }}
                >
                    {part}
                </ReactMarkdown>
            </div>
        );
    });
}

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
        updateLastMessage,
        setTimeline,
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
    const [deepArmed, setDeepArmed] = useState(false);
    const streamStartRef = useRef<number>(0);
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const resetTextareaHeight = () => {
        if (inputRef.current) inputRef.current.style.height = '40px';
    };

    const handleSendPressStart = () => {
        if (!settings.enableDeepArchiveSearch || isStreaming) return;
        longPressTimer.current = setTimeout(() => {
            setDeepArmed(true);
        }, 500);
    };

    const handleSendPressEnd = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
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
            setCondensed,
            setCondensing,
            setStreaming,
            setLoadingStatus,
            setLastPayloadTrace: useAppStore.getState().setLastPayloadTrace,
            setSemanticFacts,
            setChapters,
            setPipelinePhase: (phase: PipelinePhase) => useAppStore.getState().setPipelinePhase(phase),
            setStreamingStats: (stats: StreamingStats | null) => useAppStore.getState().setStreamingStats(stats),
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
        inputRef,
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
            } catch (e) {
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
        } catch (err) {
            toast.error('Failed to clear archive');
        }
    };

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

            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3 nav-clearance">
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

                {messages.slice(-visibleCount).filter(msg => msg.role !== 'tool').map((msg) => {
                    const markdownContent = typeof msg.displayContent === 'string' ? msg.displayContent : (typeof msg.content === 'string' ? msg.content : '');
                    let thinkingBlock = '';
                    const thinkMatch = markdownContent.match(/<think>([\s\S]*?)<\/think>/i);
                    const cleanContent = thinkMatch ? markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : markdownContent;
                    if (thinkMatch) thinkingBlock = thinkMatch[1].trim();

                    const isEnemy = msg.name === 'AI_ENEMY';
                    const isNeutral = msg.name === 'AI_NEUTRAL';
                    const isAlly = msg.name === 'AI_ALLY';

                    return (
                        <div key={msg.id} className={`group flex animate-[msg-in_0.2s_ease-out] ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[95%] md:max-w-[75%] px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${
                                msg.role === 'user' ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary' :
                                msg.role === 'system' ? 'bg-ember/8 border-l-2 border-ember text-ember/80' :
                                isEnemy ? 'bg-red-500/5 border-l-2 border-red-500 text-text-primary' :
                                isNeutral ? 'bg-amber-500/5 border-l-2 border-amber-500 text-text-primary' :
                                isAlly ? 'bg-emerald-500/5 border-l-2 border-emerald-500 text-text-primary' :
                                'bg-void-lighter border-l-2 border-border text-text-primary'
                            }`}>
                                <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-[2px] rounded z-10`}>
                                    {msg.role !== 'system' && (
                                        <button title="Edit" onClick={() => startEditing(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                            <Edit2 size={10} />
                                        </button>
                                    )}
                                    {msg.role === 'assistant' && (
                                        <button title="Regenerate" onClick={() => handleRegenerate(msg.id)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                            <RotateCcw size={10} />
                                        </button>
                                    )}
                                    <button title="Delete" onClick={() => deleteMessage(msg.id)} className="text-text-dim hover:text-red-400 p-1 bg-void-lighter rounded">
                                        <Trash2 size={10} />
                                    </button>
                                </div>

                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-[10px] uppercase tracking-widest ${msg.role === 'user' ? 'text-terminal' : msg.role === 'system' ? 'text-ember' : 'text-ice'}`}>
                                        {msg.role === 'user' ? '► YOU' : msg.role === 'system' ? '◆ SYS' : isEnemy ? '◇ [ENEMY]' : isNeutral ? '◇ [NEUTRAL]' : isAlly ? '◇ [ALLY]' : '◇ GM'}
                                    </span>
                                    <span className="text-[9px] text-text-dim">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                                </div>

                                <div className="gm-prose prose-sm leading-relaxed overflow-hidden">
                                    {thinkingBlock && settings.showReasoning && (
                                        <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden group/think">
                                            <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                                                <Loader2 size={10} className={isStreaming && msg.id === messages[messages.length - 1].id ? "animate-spin" : ""} />
                                                Cognitive Process
                                            </summary>
                                            <div className="p-3 text-[11px] text-text-dim/80 italic border-t border-terminal/10 bg-void-darker/50">
                                                {thinkingBlock}
                                            </div>
                                        </details>
                                    )}
                                    {renderContentWithChips(cleanContent)}
                                </div>

                                {(msg as any).parsedArgs?.summary && Array.isArray((msg as any).parsedArgs.summary) && (
                                    <div className="mt-4 bg-terminal/5 border border-terminal/20 rounded p-3 relative overflow-hidden group/summary animate-in fade-in zoom-in duration-300">
                                        <div className="absolute top-0 right-0 p-1.5 opacity-20"><Terminal size={12} className="text-terminal" /></div>
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="w-1 h-3 bg-terminal animate-pulse" />
                                            <span className="text-[9px] font-black uppercase tracking-[0.2em] text-terminal/80">System Analysis Result</span>
                                        </div>
                                        <ul className="space-y-2">
                                            {((msg as any).parsedArgs.summary as any[]).map((s, i) => (
                                                <li key={i} className="text-[11px] text-text-dim/90 flex gap-2 leading-snug">
                                                    <span className="text-terminal opacity-50 font-mono mt-0.5">▸</span>
                                                    <span>{typeof s === 'string' ? s : String(s)}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {settings.debugMode && msg.debugPayload && (
                                    <details className="mt-3 border-t border-border/10 pt-3 group/debug">
                                        <summary className="cursor-pointer text-[9px] text-text-dim/30 hover:text-terminal transition-colors uppercase tracking-[0.3em] list-none flex items-center gap-1.5">
                                            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                                            Engine Trace Data
                                        </summary>
                                        <pre className="mt-2 bg-void p-2 text-[9px] font-mono text-terminal/60 overflow-x-auto rounded border border-terminal/5 whitespace-pre-wrap break-all">{JSON.stringify(msg.debugPayload, null, 2)}</pre>
                                    </details>
                                )}
                            </div>
                        </div>
                    );
                })}

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
                {condenser.isCondensing ? (
                    <button onClick={() => condenseAbortRef.current?.abort()} className="flex items-center gap-1.5 bg-void border border-amber-500/30 text-amber-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all">
                        <Square size={13} /> STOP
                    </button>
                ) : (
                    <button onClick={triggerCondense} disabled={messages.length < 6} className="flex items-center gap-1.5 bg-void border border-terminal/30 text-terminal text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all">
                        <Zap size={13} /> CONDENSE
                    </button>
                )}
                <button onClick={() => setShowCondensedPanel(p => !p)} className={`flex items-center gap-1.5 bg-void border ${showCondensedPanel ? 'border-terminal text-terminal' : 'border-ice/30 text-ice'} text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all`}>
                    {showCondensedPanel ? <ChevronUp size={13} /> : <ChevronDown size={13} />} MEMORY
                </button>

                <button onClick={() => api.archive.open(activeCampaignId || '')} className="flex items-center gap-1.5 bg-void border border-ice/30 text-ice text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded ml-auto transition-all hover:bg-ice/5"><Scroll size={13} /> ARCHIVE</button>
                <button onClick={handleClearArchive} disabled={!activeCampaignId} className="flex items-center gap-1.5 bg-void border border-red-500/20 text-red-500/60 hover:text-red-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all hover:bg-red-500/5 hover:border-red-500/40"><Trash2 size={13} /> CLEAR</button>
            </div>

            {showCondensedPanel && (
                <div className="px-2 md:px-4 pb-1">
                    <div className="bg-void-lighter border border-terminal/20 rounded p-3">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] text-terminal uppercase tracking-widest font-bold">Condensed Memory</span>
                            <div className="flex items-center gap-1">
                                {editingSummary ? (
                                    <>
                                        <button onClick={() => { setCondensed(summaryDraft, condenser.condensedUpToIndex); setEditingSummary(false); }} className="text-[9px] text-terminal hover:underline px-1">Save</button>
                                        <button onClick={() => setEditingSummary(false)} className="text-[9px] text-text-dim hover:underline px-1">Cancel</button>
                                    </>
                                ) : (
                                    <>
                                        <button onClick={() => { setSummaryDraft(condenser.condensedSummary); setEditingSummary(true); }} className="text-[9px] text-terminal hover:underline px-1">Edit</button>
                                        <button onClick={handleRetcon} className="text-[9px] text-amber-500 hover:underline px-1">Retcon</button>
                                        <button onClick={() => { resetCondenser(); setEditingSummary(false); }} className="text-[9px] text-red-400 hover:underline px-1">Reset</button>
                                        <button onClick={() => { setShowCondensedPanel(false); setEditingSummary(false); }} className="text-[9px] text-text-dim hover:underline px-1"><X size={10} /></button>
                                    </>
                                )}
                            </div>
                        </div>
                        {editingSummary ? (
                            <textarea value={summaryDraft} onChange={e => setSummaryDraft(e.target.value)} className="w-full bg-void border border-border rounded px-2 py-1 text-xs text-text-primary font-mono resize-y min-h-[60px] max-h-[200px]" />
                        ) : (
                            <div className="text-[11px] text-text-dim/80 font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                                {condenser.condensedSummary || <span className="italic opacity-50">No condensed summary yet</span>}
                            </div>
                        )}
                    </div>
                </div>
            )}

            <GenerationProgress phase={pipelinePhase} stats={streamingStats} />

            <div className="flex-shrink-0 bg-void border-t border-border">
                {editingMessageId && <div className="bg-terminal/10 border-b border-border px-4 py-2 flex items-center justify-between text-terminal text-[11px] font-bold uppercase"><Edit2 size={12}/> Editing <button onClick={cancelEditing}><X size={12}/></button></div>}

                {condenser.isCondensing && (
                    <div className="py-1.5 px-4 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between">
                        <div className="flex items-center gap-2 animate-pulse">
                            <Loader2 size={10} className="animate-spin text-amber-500" />
                            <span className="text-[9px] uppercase tracking-widest text-amber-500 font-bold">
                                {condensePhase === 'save' ? 'Archiving session state...' : 'Compressing history...'}
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

                <div className="px-2 sm:px-4 pb-1 pt-1">
                    <div className="flex gap-1 border border-border bg-void focus-within:border-terminal items-center p-1 rounded-sm">
                        <div className="relative shrink-0 ml-1">
                            <select value={settings.activePresetId} onChange={(e) => useAppStore.getState().setActivePreset(e.target.value)} 
                                className="h-[32px] bg-surface border border-border text-text-dim pl-2 pr-6 text-[10px] font-bold uppercase transition-colors appearance-none rounded focus:border-terminal overflow-hidden max-w-[100px]">
                                {settings.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <svg className="absolute right-1.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-text-dim pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        <textarea ref={inputRef} value={input} onChange={handleInputChange} 
                            disabled={condenser.isCondensing}
                            placeholder={condenser.isCondensing ? 'Condensing history...' : editingMessageId ? 'Edit...' : 'What do you do?'}
                            className="flex-1 bg-transparent px-2 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5 disabled:opacity-40 disabled:cursor-not-allowed" />
                        <button
                            onClick={isStreaming ? handleStop : (editingMessageId ? handleEditSubmit : () => handleSend())}
                            onMouseDown={!isStreaming && !editingMessageId ? handleSendPressStart : undefined}
                            onMouseUp={!isStreaming && !editingMessageId ? handleSendPressEnd : undefined}
                            onMouseLeave={!isStreaming && !editingMessageId ? handleSendPressEnd : undefined}
                            onTouchStart={!isStreaming && !editingMessageId ? handleSendPressStart : undefined}
                            onTouchEnd={!isStreaming && !editingMessageId ? handleSendPressEnd : undefined}
                            disabled={!isStreaming && !input.trim()}
                            title={deepArmed ? 'Deep Archive Search armed — release to send' : undefined}
                            className={`h-[32px] w-[40px] rounded transition-all flex items-center justify-center shrink-0 ${
                                isStreaming ? 'text-amber-500 hover:bg-amber-500/10' :
                                deepArmed ? 'text-amber-400 bg-amber-400/20 animate-pulse' :
                                'text-terminal hover:bg-terminal/10'
                            }`}>
                            {isStreaming ? <Square size={16} fill="currentColor" /> : (editingMessageId ? <Check size={16} /> : <Send size={16} />)}
                        </button>
                    </div>
                </div>
            </div>

            {showScrollFab && (
                <button onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })} className="fixed bottom-[calc(160px+env(safe-area-inset-bottom))] right-4 z-50 w-10 h-10 rounded-full bg-terminal text-surface shadow-lg flex items-center justify-center"><ChevronDown size={20} /></button>
            )}
        </div>
    );
}
