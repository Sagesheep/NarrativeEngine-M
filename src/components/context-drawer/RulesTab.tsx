import { ScrollText } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { PayloadTraceView } from '../PayloadTraceView';
import { SceneNoteEditor } from '../SceneNoteEditor';
import { TokenCounter } from './TokenCounter';

const RULES_LIMIT = 5000;

export function RulesTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const settings = useAppStore((s) => s.settings);

    return (
        <div className="px-4 py-4 space-y-4">
            <div>
                <label className="flex items-center gap-2 text-[11px] text-ice uppercase tracking-wider mb-2">
                    <ScrollText size={13} />
                    Rules / Mechanics
                </label>
                <textarea
                    value={context.rulesRaw}
                    onChange={(e) => updateContext({ rulesRaw: e.target.value })}
                    placeholder="Paste game rules, mechanics, character stats..."
                    rows={6}
                    className="w-full bg-void border border-border px-3 py-2 text-[16px] md:text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y min-h-[120px] md:min-h-0"
                />
                <TokenCounter text={context.rulesRaw} limit={RULES_LIMIT} />
            </div>

            <div className="pt-4 border-t border-border/50">
                <SceneNoteEditor />
            </div>

            {settings.debugMode && (
                <div className="pt-4 border-t border-border">
                    <div className="text-[10px] text-terminal uppercase tracking-widest font-bold mb-2 flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
                        Diagnostics
                    </div>
                    <PayloadTraceView />
                </div>
            )}
        </div>
    );
}
