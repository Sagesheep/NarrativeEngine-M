import { Edit2, RotateCcw, Trash2, Loader2, Terminal, Zap } from 'lucide-react';
import type { ChatMessage } from '../../types';
import { EngineTraceView } from '../engine-trace/EngineTraceView';
import { ContentWithChips } from './ContentWithChips';

type MessageBubbleProps = {
    msg: ChatMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
    onEdit: (msg: ChatMessage) => void;
    onRegenerate: (id: string) => void;
    onDelete: (id: string) => void;
    showReasoning: boolean;
    debugMode: boolean;
    onTagDivergence?: (msg: ChatMessage) => void;
};

export function MessageBubble({ msg, isStreaming, isLastMessage, onEdit, onRegenerate, onDelete, showReasoning, debugMode, onTagDivergence }: MessageBubbleProps) {
    const markdownContent = typeof msg.displayContent === 'string' ? msg.displayContent : (typeof msg.content === 'string' ? msg.content : '');
    let thinkingBlock = '';
    const thinkMatch = markdownContent.match(/<think>([\s\S]*?)<\/think>/i);
    const cleanContent = thinkMatch ? markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : markdownContent;
    if (thinkMatch) thinkingBlock = thinkMatch[1].trim();

    const isEnemy = msg.name === 'AI_ENEMY';
    const isNeutral = msg.name === 'AI_NEUTRAL';
    const isAlly = msg.name === 'AI_ALLY';

    const parsedArgs = (msg as { parsedArgs?: { summary?: unknown } }).parsedArgs;
    const hasSummary = !!(parsedArgs?.summary && Array.isArray(parsedArgs.summary));
    const hasDebugPayload = !!(debugMode && msg.debugPayload);

    return (
        <div className={`group flex animate-[msg-in_0.2s_ease-out] ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[95%] md:max-w-[75%] px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${
                msg.role === 'user' ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary' :
                msg.role === 'system' ? 'bg-ember/8 border-l-2 border-ember text-ember/80' :
                isEnemy ? 'bg-red-500/5 border-l-2 border-red-500 text-text-primary' :
                isNeutral ? 'bg-amber-500/5 border-l-2 border-amber-500 text-text-primary' :
                isAlly ? 'bg-emerald-500/5 border-l-2 border-emerald-500 text-text-primary' :
                'bg-void-lighter border-l-2 border-border text-text-primary'
            }`}>
                {msg.divergenceIds && msg.divergenceIds.length > 0 && (
                    <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" title="Divergence tracked" />
                )}
                <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-[2px] rounded z-10`}>
                    {msg.role !== 'system' && (
                        <button title="Edit" onClick={() => onEdit(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
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

                <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] uppercase tracking-widest ${msg.role === 'user' ? 'text-terminal' : msg.role === 'system' ? 'text-ember' : 'text-ice'}`}>
                        {msg.role === 'user' ? '► YOU' : msg.role === 'system' ? '◆ SYS' : isEnemy ? '◇ [ENEMY]' : isNeutral ? '◇ [NEUTRAL]' : isAlly ? '◇ [ALLY]' : '◇ GM'}
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
            </div>
        </div>
    );
}
