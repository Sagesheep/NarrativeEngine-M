import { Send, Check, Square, Edit2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

type ChatInputProps = {
    input: string;
    isStreaming: boolean;
    isCondensing: boolean;
    editingMessageId: string | null;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onSend: () => void;
    onStop: () => void;
    onEditSubmit: () => void;
    onCancelEdit: () => void;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
};

export function ChatInput({
    input,
    isStreaming,
    isCondensing,
    editingMessageId,
    onChange,
    onSend,
    onStop,
    onEditSubmit,
    onCancelEdit,
    inputRef,
}: ChatInputProps) {
    const settings = useAppStore(s => s.settings);

    return (
        <div className="flex-shrink-0 bg-void border-t border-border">
            {editingMessageId && (
                <div className="bg-terminal/10 border-b border-border px-4 py-2 flex items-center justify-between text-terminal text-[11px] font-bold uppercase">
                    <Edit2 size={12}/> Editing
                    <button onClick={onCancelEdit}><X size={12}/></button>
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
                    <textarea
                        ref={inputRef}
                        value={input}
                        onChange={onChange}
                        disabled={isCondensing}
                        placeholder={isCondensing ? 'Condensing history...' : editingMessageId ? 'Edit...' : 'What do you do?'}
                        className="flex-1 bg-transparent px-2 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5 disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                    <button
                        onClick={isStreaming ? onStop : (editingMessageId ? onEditSubmit : onSend)}
                        disabled={!isStreaming && !input.trim()}
                        className={`h-[32px] w-[40px] rounded transition-all flex items-center justify-center shrink-0 ${
                            isStreaming ? 'text-amber-500 hover:bg-amber-500/10' :
                            'text-terminal hover:bg-terminal/10'
                        }`}>
                        {isStreaming ? <Square size={16} fill="currentColor" /> : (editingMessageId ? <Check size={16} /> : <Send size={16} />)}
                    </button>
                </div>
            </div>
        </div>
    );
}