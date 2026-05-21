import { useState, useRef, useEffect } from 'react';
import { Edit2, RotateCcw, Trash2, Loader2, Terminal, Zap, Check, X } from 'lucide-react';
import type { ChatMessage } from '../../types';
import { EngineTraceView } from '../engine-trace/EngineTraceView';
import { ContentWithChips } from './ContentWithChips';

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
};

export function MessageBubble({
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
    onTagDivergence
}: MessageBubbleProps) {
    const markdownContent = typeof msg.displayContent === 'string' ? msg.displayContent : (typeof msg.content === 'string' ? msg.content : '');
    let thinkingBlock = '';
    const thinkMatch = markdownContent.match(/<think>([\s\S]*?)<\/think>/i);
    const cleanContent = thinkMatch ? markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : markdownContent;
    if (thinkMatch) thinkingBlock = thinkMatch[1].trim();

    const parsedArgs = (msg as { parsedArgs?: { summary?: unknown } }).parsedArgs;
    const hasSummary = !!(parsedArgs?.summary && Array.isArray(parsedArgs.summary));
    const hasDebugPayload = !!(debugMode && msg.debugPayload);

    const [editText, setEditText] = useState(msg.displayContent || msg.content);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const bubbleRef = useRef<HTMLDivElement>(null);

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
        <div className={`group flex animate-[msg-in_0.2s_ease-out] ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
                ref={bubbleRef}
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

                {/* Floating action row - hidden during editing or when streaming */}
                {!isEditing && (
                    <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-[2px] rounded z-10`}>
                        {msg.role !== 'system' && !isStreaming && (
                            <button title="Edit" onClick={() => onStartEdit(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                <Edit2 size={10} />
                            </button>
                        )}
                        {msg.role === 'assistant' && (
                            <button title="Regenerate" onClick={() => onRegenerate(msg.id)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                <RotateCcw size={10} />
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
                            <span className={`text-[10px] uppercase tracking-widest ${msg.role === 'user' ? 'text-terminal' : msg.role === 'system' ? 'text-ember' : 'text-ice'}`}>
                                {msg.role === 'user' ? '► YOU' : msg.role === 'system' ? '◆ SYS' : '◇ GM'}
                            </span>
                            <span className="text-[9px] text-text-dim">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        </div>

                        <div
                            className="gm-prose prose-sm leading-relaxed overflow-hidden"
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
                            <ContentWithChips content={cleanContent} />
                        </div>

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
                    </>
                )}
            </div>
        </div>
    );
}
