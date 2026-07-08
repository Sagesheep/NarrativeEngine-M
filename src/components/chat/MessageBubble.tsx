import { useState, useRef, useEffect, memo } from 'react';
import { Edit2, Trash2, Loader2, Terminal, Zap, Check, X, Pin, PinOff, ImagePlus, AlertCircle, XCircle, Volume2, Square, RotateCw, Play, Pause, RefreshCw, Rewind, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../../types';
import { EngineTraceView } from '../engine-trace/EngineTraceView';
import { ContentWithChips } from './ContentWithChips';
import { ToolCallChips } from './ToolCallChips';
import { PrecontextBox } from './PrecontextBox';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useBackHandler } from '../../hooks/useBackHandler';
import { appConfirm } from '../ConfirmSheet';
import { toast } from '../Toast';
import { illustrateMessage } from '../../services/image';
import { imageStorage } from '../../services/storage/imageStorage';
import { proseForTTS, chunkSentencesForTTS } from '../../services/tts/proseStripper';
import { speakChunks, speechSupported, type SpeakHandle } from '../../services/tts/speech';
import { hasSwipeSet, MAX_SWIPES } from '../../services/turn';

type MessageBubbleProps = {
    msg: ChatMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
    isEditing: boolean;
    onStartEdit: (msg: ChatMessage) => void;
    onCancelEdit: () => void;
    onSubmitEdit: (id: string, newContent: string) => void;
    onRegenerate: (id: string) => void;
    onDelete: (id: string) => void;
    showReasoning: boolean;
    debugMode: boolean;
    onTagDivergence?: (msg: ChatMessage) => void;
    /** Result of this message's tool_call, resolved from the matching `tool` role message. */
    toolResult?: string;
    /** Swipe Generation v1: called when the user taps 🔄 on the latest GM bubble. */
    onOpenSwipeSheet?: (messageId: string) => void;
    /** Swipe Generation v1: called when the user swipes left/right on the bubble. */
    onSwipeNavigate?: (messageId: string, direction: 'prev' | 'next') => void;
    /** Smart Retry v1: called when the user taps Retry on a failed/aborted bubble. */
    onRetry?: (messageId: string) => void;
};

type ImageAttachmentProps = {
    msg: ChatMessage;
};

function ImageAttachment({ msg }: ImageAttachmentProps) {
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const image = msg.image;

    // Hardware back closes the image lightbox before anything else.
    useBackHandler(lightboxOpen, () => setLightboxOpen(false));
    const readyToLoad = image?.status === 'ready' && activeCampaignId;

    useEffect(() => {
        if (!readyToLoad) return;
        let cancelled = false;
        imageStorage.get(activeCampaignId!, msg.id).then(url => {
            if (!cancelled) setImageUrl(url);
        });
        return () => { cancelled = true; };
    }, [readyToLoad, activeCampaignId, msg.id]);

    if (!image) return null;

    if (image.status === 'pending') {
        return (
            <div className="mt-3 flex items-center gap-2 py-2 px-3 bg-void-darker border border-border rounded text-text-dim">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-xs uppercase tracking-wider">Illustrating scene…</span>
            </div>
        );
    }

    if (image.status === 'error') {
        return (
            <div className="mt-3 flex items-center gap-2 py-2 px-3 bg-void-darker border border-red-500/30 rounded">
                <AlertCircle size={12} className="text-red-400 shrink-0" />
                <span className="text-[11px] text-red-400/80 truncate flex-1">{image.error || 'Illustration failed'}</span>
                <button
                    onClick={() => illustrateMessage(msg.id)}
                    className="text-[10px] uppercase tracking-wider text-text-dim hover:text-ice shrink-0"
                >
                    Retry
                </button>
            </div>
        );
    }

    if (imageUrl) {
        return (
            <>
                <div
                    className="mt-3 overflow-hidden rounded border border-border cursor-pointer hover:border-ice/40 transition-colors"
                    onClick={() => setLightboxOpen(true)}
                >
                    <img
                        src={imageUrl}
                        alt="Scene illustration"
                        className="w-full max-h-80 object-contain bg-void-darker"
                        loading="lazy"
                    />
                </div>
                {lightboxOpen && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
                        onClick={() => setLightboxOpen(false)}
                    >
                        <button
                            className="absolute top-4 right-4 p-2 bg-void-darker/80 border border-border rounded-full text-text-dim hover:text-text-primary transition-colors z-10"
                            onClick={() => setLightboxOpen(false)}
                        >
                            <XCircle size={24} />
                        </button>
                        <img
                            src={imageUrl}
                            alt="Scene illustration"
                            className="max-w-[calc(95*var(--app-vw))] max-h-[calc(90*var(--app-vh))] object-contain rounded"
                            onClick={e => e.stopPropagation()}
                        />
                    </div>
                )}
            </>
        );
    }

    return null;
}

/**
 * Clickable sentence list for TTS playback navigation.
 * Each sentence is clickable (jumps playback to that chunk). The active sentence
 * is highlighted; past sentences are dimmed. No word-level highlight — walking
 * UX is audio-first, screen is glanced at most.
 */
function SentenceList({
    sentences,
    activeIdx,
    finished,
    onSentenceClick,
}: {
    sentences: string[];
    activeIdx: number;
    finished?: boolean;
    onSentenceClick?: (sentenceIndex: number) => void;
}) {
    return (
        <div className={`text-[11px] leading-relaxed ${finished ? 'text-text-dim/50' : 'text-text-primary'}`}>
            {sentences.map((sent, si) => {
                const isPast = activeIdx >= 0 && si < activeIdx;
                const isActive = si === activeIdx && !finished;
                return (
                    <span
                        key={si}
                        onClick={() => onSentenceClick?.(si)}
                        className={[
                            'cursor-pointer rounded px-0.5 transition-colors hover:bg-ice/20 hover:text-ice',
                            isPast || finished ? 'text-text-dim/40' : '',
                            isActive ? 'text-ice font-bold' : '',
                        ].join(' ')}
                    >
                        {sent}{' '}
                    </span>
                );
            })}
        </div>
    );
}

/**
 * SwipeIndicator — shows "2/5" position and prev/next chevrons for the
 * latest GM message's swipe set. Touch-swipe left/right on the bubble
 * navigates; the chevrons are tap targets for desktop / accessibility.
 */
function SwipeIndicator({
    msg,
    onPrev,
    onNext,
}: {
    msg: ChatMessage;
    onPrev: () => void;
    onNext: () => void;
}) {
    const swipeSet = msg.swipeSet;
    if (!swipeSet) return null;
    const current = (msg.swipeActiveIndex ?? 0) + 1;
    const total = Math.max(swipeSet.length, MAX_SWIPES);
    const atFirst = (msg.swipeActiveIndex ?? 0) === 0;
    // Disabled at the last FILLED slot — the chevron only navigates existing
    // slots. New variants are created via the Generate button in the sheet.
    const atLast = (msg.swipeActiveIndex ?? 0) >= swipeSet.length - 1;
    const isStreaming = swipeSet[msg.swipeActiveIndex ?? 0]?.streaming === true;

    return (
        <div className="mt-2 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-text-dim select-none">
            <button
                onClick={onPrev}
                disabled={atFirst}
                className="p-0.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                title="Previous variant"
            >
                <ChevronLeft size={12} />
            </button>
            <span className="font-mono text-text-dim/80">
                {isStreaming ? '…' : current}/{total}
            </span>
            <button
                onClick={onNext}
                disabled={atLast}
                className="p-0.5 rounded text-text-dim hover:text-ice disabled:opacity-30 disabled:pointer-events-none transition-colors"
                title="Next variant"
            >
                <ChevronRight size={12} />
            </button>
        </div>
    );
}

export const MessageBubble = memo(function MessageBubble({
    msg,
    isStreaming,
    isLastMessage,
    isEditing,
    onStartEdit,
    onCancelEdit,
    onSubmitEdit,
    onRegenerate,
    onDelete,
    showReasoning,
    debugMode,
    onTagDivergence,
    toolResult,
    onOpenSwipeSheet,
    onSwipeNavigate,
    onRetry
}: MessageBubbleProps) {
    const markdownContent = typeof msg.displayContent === 'string' ? msg.displayContent : (typeof msg.content === 'string' ? msg.content : '');
    let thinkingBlock = '';
    const thinkMatch = markdownContent.match(/<think>([\s\S]*?)<\/think>/i);
    const cleanContent = thinkMatch ? markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : markdownContent;
    if (thinkMatch) thinkingBlock = thinkMatch[1].trim();
    else if (msg.reasoning_content) thinkingBlock = msg.reasoning_content.trim();

    const parsedArgs = (msg as { parsedArgs?: { summary?: unknown } }).parsedArgs;
    const hasSummary = !!(parsedArgs?.summary && Array.isArray(parsedArgs.summary));
    const hasDebugPayload = !!(debugMode && msg.debugPayload);

    const [editText, setEditText] = useState(msg.displayContent || msg.content);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);

    // ── Swipe Generation v1: touch-swipe gesture handling ──
    // Only the latest GM message (with a swipe set) responds to horizontal
    // swipes. A swipe left → next variant, right → previous. The threshold
    // is generous so a normal vertical scroll never triggers a swipe.
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);
    const SWIPE_THRESHOLD = 50;  // px horizontal travel before it counts as a swipe

    const handleTouchStart = (e: React.TouchEvent) => {
        if (!hasSwipeSet(msg)) return;
        const t = e.touches[0];
        touchStartX.current = t.clientX;
        touchStartY.current = t.clientY;
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        if (!hasSwipeSet(msg) || touchStartX.current === null || touchStartY.current === null) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartX.current;
        const dy = t.clientY - touchStartY.current;
        touchStartX.current = null;
        touchStartY.current = null;
        // Only trigger on predominantly horizontal swipes
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;
        if (dx < 0) {
            onSwipeNavigate?.(msg.id, 'next');
        } else {
            onSwipeNavigate?.(msg.id, 'prev');
        }
    };

    // ── TTS playback (Web Speech API) — chunked + click-to-jump + controllable ──
    const ttsEnabled = useAppStore(s => s.settings.ttsEnabled);
    const ttsRate = useAppStore(s => s.settings.ttsRate ?? 1);
    const [ttsPlaying, setTtsPlaying] = useState(false);
    const [ttsPaused, setTtsPaused] = useState(false);
    const [ttsFinished, setTtsFinished] = useState(false);
    const [activeSentenceIdx, setActiveSentenceIdx] = useState(-1);
    const [totalChunks, setTotalChunks] = useState(0);
    const speakHandleRef = useRef<SpeakHandle | null>(null);
    const initialSkipRef = useRef<number | null>(null);
    const rateRef = useRef(ttsRate);
    useEffect(() => { rateRef.current = ttsRate; }, [ttsRate]);

    const canSpeak = msg.role === 'assistant'
        && !isEditing
        && !!ttsEnabled
        && speechSupported()
        && !!markdownContent.trim();

    const stopPlayback = () => {
        if (speakHandleRef.current) {
            speakHandleRef.current.stop();
            speakHandleRef.current = null;
        }
        setTtsPlaying(false);
        setTtsPaused(false);
        setTtsFinished(false);
        setActiveSentenceIdx(-1);
    };

    const handleSpeak = () => {
        // If currently playing, stop (toggle behaviour — matches mainApp).
        if (ttsPlaying) {
            stopPlayback();
            return;
        }
        const clean = proseForTTS(markdownContent);
        if (!clean) return;
        const chunks = chunkSentencesForTTS(clean);
        if (!chunks.length) return;

        setTotalChunks(chunks.length);
        setTtsPaused(false);
        setTtsFinished(false);
        setActiveSentenceIdx(-1);

        const startAt = initialSkipRef.current ?? 0;
        initialSkipRef.current = null;

        const handle = speakChunks(
            chunks,
            { rate: rateRef.current, startAt },
            {
                onChunkStart: (idx) => setActiveSentenceIdx(idx),
                onFinish: () => {
                    speakHandleRef.current = null;
                    setTtsPlaying(false);
                    setTtsFinished(true);
                    setActiveSentenceIdx(-1);
                },
                onError: (err) => {
                    speakHandleRef.current = null;
                    setTtsPlaying(false);
                    toast.warning(`Read aloud failed: ${err}`);
                },
            },
        );
        speakHandleRef.current = handle;
        setTtsPlaying(true);
    };

    const handlePauseResume = () => {
        const h = speakHandleRef.current;
        if (!h) return;
        if (ttsPaused) {
            h.resume();
            setTtsPaused(false);
        } else {
            h.pause();
            setTtsPaused(true);
        }
    };

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (speakHandleRef.current) {
                speakHandleRef.current.stop();
                speakHandleRef.current = null;
            }
        };
    }, []);

    const handleSpeedChange = (delta: number) => {
        const newRate = Math.min(2, Math.max(0.5, Math.round((rateRef.current + delta) * 10) / 10));
        useAppStore.getState().updateSettings({ ttsRate: newRate });
    };

    const sentences = canSpeak && (ttsPlaying || ttsFinished) ? chunkSentencesForTTS(proseForTTS(markdownContent)) : [];

    const fullMessagePin = useAppStore(useShallow(s => s.pinnedExcerpts.find(p => p.isFullMessage && p.sourceMessageId === msg.id)));
    const hasPinBadge = useAppStore(useShallow(s => s.pinnedExcerpts.some(p => p.sourceMessageId === msg.id)));
    const addPinnedExcerpt = useAppStore(s => s.addPinnedExcerpt);
    const removePinnedExcerpt = useAppStore(s => s.removePinnedExcerpt);

    const handlePinToggle = () => {
        if (fullMessagePin) {
            removePinnedExcerpt(fullMessagePin.id);
        } else {
            const text = msg.displayContent || msg.content;
            const result = addPinnedExcerpt(msg.id, text, true);
            if (!result.ok) {
                toast.warning(result.reason);
            }
        }
    };

    // Sync draft state only when entering edit mode
    useEffect(() => {
        if (isEditing) {
            setEditText(msg.displayContent || msg.content);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isEditing]);

    // Handle scroll into view, focus and auto-grow height on mount
    useEffect(() => {
        if (isEditing && textareaRef.current) {
            requestAnimationFrame(() => {
                const textarea = textareaRef.current;
                if (!textarea) return;
                textarea.focus();
                // Cursor at the end of the text
                const length = textarea.value.length;
                textarea.setSelectionRange(length, length);

                // Center the bubble in viewport (prevents keyboard occlusion)
                bubbleRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });

                // Set initial auto-grow height
                textarea.style.height = 'auto';
                textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
            });
        }
    }, [isEditing]);

    const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setEditText(e.target.value);
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
        }
    };

    const handleSave = () => {
        if (editText.trim() === '' || isStreaming) return;
        onSubmitEdit(msg.id, editText);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancelEdit();
        }
    };

    return (
        <div
            data-message-id={msg.id}
            className={`group flex animate-[msg-in_0.2s_ease-out] ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
            <div
                ref={bubbleRef}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
                className={`px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative transition-all duration-200 ${
                    isEditing ? 'w-full max-w-[95%] md:max-w-[85%]' : 'max-w-[95%] md:max-w-[75%]'
                } ${
                    msg.role === 'user' ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary' :
                    msg.role === 'system' ? 'bg-ember/8 border-l-2 border-ember text-ember/80' :
                    'bg-void-lighter border-l-2 border-border text-text-primary'
                }`}
            >
                {msg.divergenceIds && msg.divergenceIds.length > 0 && !isEditing && (
                    <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" title="Divergence tracked" />
                )}

                {/* Pin badge — visible whenever any excerpt references this bubble */}
                {hasPinBadge && !isEditing && (
                    <div
                        className={`absolute -top-1.5 ${msg.role === 'user' ? '-right-1.5' : '-left-1.5'} w-3.5 h-3.5 flex items-center justify-center bg-terminal/20 border border-terminal/50 rounded-full z-20`}
                        title="Has pinned memory"
                    >
                        <Pin size={7} className="text-terminal" />
                    </div>
                )}

                {/* Floating action row - visible on hover (desktop) or tap (mobile) */}
                {!isEditing && (
                    <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 bg-void-darker border border-border p-[2px] rounded z-10 opacity-100`}>
                        {msg.role !== 'system' && !isStreaming && (
                            <button title="Edit" onClick={() => onStartEdit(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                <Edit2 size={10} />
                            </button>
                        )}
                        {msg.role === 'assistant' && hasSwipeSet(msg) && onOpenSwipeSheet && (
                            <button
                                title="Browse variants (swipe)"
                                onClick={() => onOpenSwipeSheet(msg.id)}
                                className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded"
                            >
                                <RefreshCw size={10} />
                            </button>
                        )}
                        {msg.role === 'assistant' && !hasSwipeSet(msg) && (
                            <button
                                title="Rewind to here (destructive — regenerates from this point)"
                                onClick={async () => {
                                    if (await appConfirm({
                                        title: 'Rewind to here',
                                        body: 'Rewind to this message? This regenerates the turn from here — the current GM reply and everything after it is discarded.',
                                        confirmLabel: 'Rewind',
                                        danger: true,
                                    })) {
                                        onRegenerate(msg.id);
                                    }
                                }}
                                className="text-text-dim hover:text-amber-400 p-1 bg-void-lighter rounded"
                            >
                                <Rewind size={10} />
                            </button>
                        )}
                        {msg.role === 'assistant' && !isStreaming && !(msg.image?.status === 'pending') && (
                            <button
                                title="Illustrate scene"
                                onClick={() => illustrateMessage(msg.id)}
                                className={`p-1 bg-void-lighter rounded transition-colors ${
                                    msg.image?.status === 'ready' ? 'text-ice hover:text-ice/60' : 'text-text-dim hover:text-ice'
                                }`}
                            >
                                <ImagePlus size={10} />
                            </button>
                        )}
                        {canSpeak && (
                            <button
                                title={ttsPlaying ? 'Stop' : ttsFinished ? 'Replay' : 'Read aloud'}
                                onClick={handleSpeak}
                                className={`p-1 bg-void-lighter rounded transition-colors ${ttsPlaying ? 'text-ice' : 'text-text-dim hover:text-ice'}`}
                            >
                                {ttsPlaying ? <Square size={10} /> : ttsFinished ? <RotateCw size={10} /> : <Volume2 size={10} />}
                            </button>
                        )}
                        {canSpeak && ttsPlaying && (
                            <button
                                title={ttsPaused ? 'Resume' : 'Pause'}
                                onClick={handlePauseResume}
                                className="p-1 bg-void-lighter rounded text-text-dim hover:text-ice"
                            >
                                {ttsPaused ? <Play size={10} /> : <Pause size={10} />}
                            </button>
                        )}
                        {msg.role === 'assistant' && onTagDivergence && (
                            <button
                                title="Tag as Divergence"
                                onClick={() => onTagDivergence(msg)}
                                className={`text-text-dim hover:text-amber-400 p-1 bg-void-lighter rounded ${
                                    (msg.divergenceIds && msg.divergenceIds.length > 0) ? 'text-amber-400' : ''
                                }`}
                            >
                                <Zap size={10} />
                            </button>
                        )}
                        {msg.role !== 'system' && (
                            <button
                                title={fullMessagePin ? 'Unpin message' : 'Pin message'}
                                onClick={handlePinToggle}
                                className={`p-1 bg-void-lighter rounded transition-colors ${
                                    fullMessagePin ? 'text-terminal hover:text-terminal/60' : 'text-text-dim hover:text-terminal'
                                }`}
                            >
                                {fullMessagePin ? <PinOff size={10} /> : <Pin size={10} />}
                            </button>
                        )}
                        <button title="Delete" onClick={() => onDelete(msg.id)} className="text-text-dim hover:text-red-400 p-1 bg-void-lighter rounded">
                            <Trash2 size={10} />
                        </button>
                    </div>
                )}

                {isEditing ? (
                    <div className="flex flex-col gap-2">
                        {/* Header toolbar */}
                        <div className="flex items-center justify-between pb-1.5 border-b border-border/20">
                            <span className={`text-[10px] uppercase tracking-widest ${msg.role === 'user' ? 'text-terminal' : 'text-ice'}`}>
                                {msg.role === 'user' ? '► EDITING YOU' : '◇ EDITING GM'}
                            </span>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={onCancelEdit}
                                    aria-label="Cancel edit"
                                    title="Cancel"
                                    className="w-10 h-10 flex items-center justify-center bg-void border border-border text-text-dim hover:text-red-400 hover:border-red-500/30 active:scale-95 rounded transition-all shrink-0 cursor-pointer"
                                >
                                    <X size={16} />
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={editText.trim() === '' || isStreaming}
                                    aria-label={msg.role === 'user' ? "Resubmit turn" : "Save changes"}
                                    title={msg.role === 'user' ? "Resubmit" : "Save"}
                                    className={`w-10 h-10 flex items-center justify-center rounded active:scale-95 transition-all shrink-0 cursor-pointer ${
                                        msg.role === 'user'
                                            ? 'bg-terminal/20 border border-terminal/40 text-terminal hover:bg-terminal/30 disabled:opacity-40 disabled:pointer-events-none'
                                            : 'bg-ice/20 border border-ice/40 text-ice hover:bg-ice/30 disabled:opacity-40 disabled:pointer-events-none'
                                    }`}
                                >
                                    {msg.role === 'user' ? <Zap size={16} className="text-terminal" /> : <Check size={16} className="text-ice" />}
                                </button>
                            </div>
                        </div>

                        {/* Textarea editor */}
                        <textarea
                            ref={textareaRef}
                            value={editText}
                            onChange={handleTextareaChange}
                            onKeyDown={handleKeyDown}
                            className={`w-full min-h-[100px] bg-void-darker p-2.5 border rounded-sm text-[16px] md:text-sm font-mono leading-relaxed resize-none outline-none transition-all ${
                                msg.role === 'user'
                                    ? 'border-terminal/30 focus:border-terminal focus:ring-1 focus:ring-terminal/30'
                                    : 'border-ice/30 focus:border-ice focus:ring-1 focus:ring-ice/30'
                            }`}
                            placeholder="Type message content..."
                        />

                        {/* Hint row (desktop only) */}
                        <div className="hidden md:flex justify-between items-center text-[9px] uppercase tracking-wider text-text-dim/50 px-1 select-none">
                            <span>{msg.role === 'user' ? 'Resubmitting rolls back session' : 'Editing updates GM response in place'}</span>
                            <span>Ctrl+Enter to save • Esc to cancel</span>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] uppercase tracking-widest ${
                                msg.role === 'user' ? 'text-terminal' :
                                msg.role === 'system' ? 'text-ember' :
                                'text-ice'
                            }`}>
                                {msg.role === 'user' ? '► YOU' : msg.role === 'system' ? '◆ SYS' : '◇ GM'}
                            </span>
                            <span className="text-[9px] text-text-dim">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        </div>

                        <ToolCallChips toolCalls={msg.tool_calls} toolResult={toolResult} />

                        {msg.precontext && (
                            <PrecontextBox summary={msg.precontext.summary} />
                        )}

                        <div
                            className={`gm-prose prose-sm leading-relaxed overflow-hidden`}
                            {...(msg.role === 'assistant' ? { 'data-lore-checkable': 'true', 'data-message-id': msg.id } : {})}
                        >
                            {thinkingBlock && showReasoning && (
                                <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden group/think">
                                    <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                                        <Loader2 size={10} className={isStreaming && isLastMessage ? "animate-spin" : ""} />
                                        Cognitive Process
                                    </summary>
                                    <div className="p-3 text-[11px] text-text-dim/80 italic border-t border-terminal/10 bg-void-darker/50">
                                        {thinkingBlock}
                                    </div>
                                </details>
                            )}
                            <ContentWithChips content={cleanContent} streaming={isStreaming && isLastMessage} />
                        </div>

                        {msg.retryable && !isStreaming && onRetry && (
                            <div className="mt-2 mb-1 flex items-center gap-2 py-2 px-3 bg-void-darker border border-amber-500/30 rounded">
                                <AlertCircle size={12} className="text-amber-400 shrink-0" />
                                <span className="text-[11px] text-amber-400/80 truncate flex-1">Story AI halted — context preserved</span>
                                <button
                                    onClick={() => onRetry(msg.id)}
                                    className="text-[10px] uppercase tracking-wider text-text-dim hover:text-amber-300 shrink-0 flex items-center gap-1"
                                >
                                    <RotateCw size={10} />
                                    Retry
                                </button>
                            </div>
                        )}

                        {hasSwipeSet(msg) && (
                            <SwipeIndicator
                                msg={msg}
                                onPrev={() => onSwipeNavigate?.(msg.id, 'prev')}
                                onNext={() => onSwipeNavigate?.(msg.id, 'next')}
                            />
                        )}

                        {canSpeak && (ttsPlaying || ttsFinished) && (
                            <div className="mt-2 mb-1 rounded border border-ice/30 bg-ice/5 max-h-[140px] overflow-y-auto relative">
                                <div className="sticky top-0 z-10 bg-void-darker/95 backdrop-blur-sm border-b border-ice/20 px-2 py-1 flex items-center gap-1 justify-between flex-wrap">
                                    <span className="flex items-center gap-1.5 text-[9px] text-ice/70 uppercase tracking-widest shrink-0">
                                        {ttsFinished ? <RotateCw size={9} /> : ttsPaused ? <Pause size={9} /> : <Volume2 size={9} />}
                                        {ttsFinished ? 'Finished' : ttsPaused ? 'Paused' : 'Reading'}
                                    </span>
                                    {totalChunks > 0 && (
                                        <span className="text-[9px] text-text-dim/60 normal-case tracking-normal shrink-0 mr-1">
                                            ▶ {ttsFinished ? totalChunks : (activeSentenceIdx >= 0 ? activeSentenceIdx + 1 : 0)}/{totalChunks}
                                        </span>
                                    )}
                                    <div className="flex items-center gap-1 ml-auto">
                                        {ttsPlaying && (
                                            <button title={ttsPaused ? 'Resume' : 'Pause'} onClick={handlePauseResume} className="text-text-dim hover:text-ice px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                                                {ttsPaused ? <><Play size={9} /> Resume</> : <><Pause size={9} /> Pause</>}
                                            </button>
                                        )}
                                        <div className="w-px h-3 bg-border/40 mx-0.5" />
                                        <button title="Slower" onClick={() => handleSpeedChange(-0.1)} className="text-text-dim hover:text-ice px-1 py-0.5 rounded text-[9px] font-bold">
                                            ½×
                                        </button>
                                        <span className="text-[9px] text-text-dim font-mono w-8 text-center">{(rateRef.current).toFixed(1)}×</span>
                                        <button title="Faster" onClick={() => handleSpeedChange(0.1)} className="text-text-dim hover:text-ice px-1 py-0.5 rounded text-[9px] font-bold">
                                            2×
                                        </button>
                                        {ttsFinished && (
                                            <>
                                                <div className="w-px h-3 bg-border/40 mx-0.5" />
                                                <button title="Replay" onClick={handleSpeak} className="text-ice hover:text-ice px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                                                    <Play size={9} /> Replay
                                                </button>
                                            </>
                                        )}
                                        <div className="w-px h-3 bg-border/40 mx-0.5" />
                                        <button title="Stop" onClick={stopPlayback} className="text-text-dim hover:text-red-400 px-1 py-0.5 rounded flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider">
                                            <Trash2 size={9} />
                                        </button>
                                    </div>
                                </div>
                                <div className="px-2 py-1.5">
                                    <SentenceList
                                        sentences={sentences}
                                        activeIdx={activeSentenceIdx}
                                        finished={ttsFinished}
                                        onSentenceClick={(si) => {
                                            if (ttsPlaying) {
                                                // Jump mid-playback: stop and restart from this chunk.
                                                if (speakHandleRef.current) {
                                                    speakHandleRef.current.stop();
                                                    speakHandleRef.current = null;
                                                }
                                                initialSkipRef.current = si;
                                                handleSpeak();
                                            } else {
                                                initialSkipRef.current = si;
                                                handleSpeak();
                                            }
                                        }}
                                    />
                                </div>
                            </div>
                        )}

                        {hasSummary && (
                            <div className="mt-4 bg-terminal/5 border border-terminal/20 rounded p-3 relative overflow-hidden group/summary animate-in fade-in zoom-in duration-300">
                                <div className="absolute top-0 right-0 p-1.5 opacity-20"><Terminal size={12} className="text-terminal" /></div>
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-1 h-3 bg-terminal animate-pulse" />
                                    <span className="text-[9px] font-black uppercase tracking-[0.2em] text-terminal/80">System Analysis Result</span>
                                </div>
                                <ul className="space-y-2">
                                    {(parsedArgs!.summary! as unknown[]).map((s, i) => (
                                        <li key={i} className="text-[11px] text-text-dim/90 flex gap-2 leading-snug">
                                            <span className="text-terminal opacity-50 font-mono mt-0.5">▸</span>
                                            <span>{typeof s === 'string' ? s : String(s)}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {hasDebugPayload && (
                             <EngineTraceView payload={msg.debugPayload} />
                         )}

                        <ImageAttachment msg={msg} />
                    </>
                )}
            </div>
        </div>
    );
});
