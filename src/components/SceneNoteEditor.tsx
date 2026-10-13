import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { StickyNote, Trash2 } from 'lucide-react';
import { SCENE_NOTE_DEFAULT_DEPTH, SCENE_NOTE_MAX_DEPTH } from '../services/payload/sceneNote';

/**
 * Scene Note — the campaign's one prompt injection (like SillyTavern's author's
 * note). Placed at its depth on every reply, retry and swipe request; never
 * saved into the chat (services/payload/sceneNote.ts).
 */
export const SceneNoteEditor: React.FC = () => {
    const context = useAppStore(s => s.context);
    const updateContext = useAppStore(s => s.updateContext);
    const depth = context.sceneNoteDepth ?? SCENE_NOTE_DEFAULT_DEPTH;
    const hasText = !!context.sceneNote?.trim();

    const handleClear = () => {
        updateContext({
            sceneNote: '',
            sceneNoteActive: false
        });
    };

    return (
        <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-[11px] text-amber uppercase tracking-wider">
                    <StickyNote size={13} />
                    Scene Note
                </label>
                <div className="flex items-center gap-3">
                    {context.sceneNote && (
                        <button
                            onClick={handleClear}
                            className="text-[11px] md:text-[9px] text-text-dim hover:text-red-400 flex items-center gap-1.5 uppercase transition-colors px-2 md:px-0 min-h-[32px] md:min-h-0"
                            title="Clear scene note"
                        >
                            <Trash2 size={12} className="md:w-[10px] md:h-[10px]" />
                            Clear
                        </button>
                    )}
                    <button
                        onClick={() => updateContext({ sceneNoteActive: !context.sceneNoteActive })}
                        disabled={!hasText}
                        role="switch"
                        aria-checked={context.sceneNoteActive}
                        aria-label="Scene note on"
                        className={`relative w-12 h-6 shrink-0 rounded-full transition-colors disabled:opacity-40 ${context.sceneNoteActive ? 'bg-terminal' : 'bg-border'}`}
                    >
                        <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${context.sceneNoteActive ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                    </button>
                </div>
            </div>

            <textarea
                value={context.sceneNote}
                onChange={(e) => updateContext({ sceneNote: e.target.value, sceneNoteActive: !!e.target.value })}
                placeholder="Standing instructions for the GM: tone, content, style, or what's going on in this scene (e.g. 'Keep descriptions explicit and detailed', 'The NPC is being evasive')..."
                rows={4}
                className={`w-full bg-void border px-3 py-2 text-[16px] md:text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y transition-all min-h-[120px] md:min-h-0 ${context.sceneNoteActive ? 'border-terminal/50' : 'border-border'
                    }`}
            />

            <div className="flex items-center gap-4 bg-void-lighter border border-border p-3 md:p-2 rounded min-h-[56px] md:min-h-0">
                <div className="flex-1 flex flex-col gap-1.5">
                    <label className="text-[10px] md:text-[9px] text-text-dim uppercase tracking-wider">Depth</label>
                    <input
                        type="range"
                        min="0"
                        max={SCENE_NOTE_MAX_DEPTH}
                        step="1"
                        value={depth}
                        onChange={(e) => updateContext({ sceneNoteDepth: parseInt(e.target.value) })}
                        className="w-full accent-amber cursor-pointer h-6 md:h-4"
                        aria-label="Scene note depth"
                    />
                    <span className="text-[9px] text-text-dim/60">0 = right after your latest message (strongest). Higher = further back.</span>
                </div>
                <div className="text-center min-w-[40px]">
                    <div className="text-sm md:text-xs font-bold text-amber">{depth}</div>
                    <div className="text-[9px] md:text-[8px] text-text-dim uppercase tracking-tight">msgs</div>
                </div>
            </div>

            <p className="text-[9px] text-text-dim/50 italic">
                {context.sceneNoteActive && hasText
                    ? `✓ Sent with every reply and swipe, ${depth === 0 ? 'after your latest message' : `${depth} message${depth === 1 ? '' : 's'} from the end`}. Not saved in the chat.`
                    : 'Off. Nothing is sent.'}
            </p>
        </div>
    );
};
