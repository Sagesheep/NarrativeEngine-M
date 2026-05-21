import { Send, Square } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

type ChatInputProps = {
    input: string;
    isStreaming: boolean;
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onSend: () => void;
    onStop: () => void;
    inputRef: React.RefObject<HTMLTextAreaElement | null>;
};

export function ChatInput({
    input,
    isStreaming,
    onChange,
    onSend,
    onStop,
    inputRef,
}: ChatInputProps) {
    const settings = useAppStore(s => s.settings);

    return (
        <div className="flex-shrink-0 bg-void border-t border-border">
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
                        placeholder="What do you do?"
                        className="flex-1 bg-transparent px-2 py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5"
                    />
                    <button
                        onClick={isStreaming ? onStop : onSend}
                        disabled={!isStreaming && !input.trim()}
                        className={`h-[32px] w-[40px] rounded transition-all flex items-center justify-center shrink-0 ${
                            isStreaming ? 'text-amber-500 hover:bg-amber-500/10' :
                            'text-terminal hover:bg-terminal/10'
                        }`}>
                        {isStreaming ? <Square size={16} fill="currentColor" /> : <Send size={16} />}
                    </button>
                </div>
            </div>
        </div>
    );
}