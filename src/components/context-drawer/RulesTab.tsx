import { ScrollText, Settings2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { PayloadTraceView } from '../PayloadTraceView';
import { LootDropTraceView } from '../LootDropTraceView';
import { SceneNoteEditor } from '../SceneNoteEditor';
import { TokenCounter } from './TokenCounter';
import { countTokens } from '../../services/infrastructure';

const RULES_LIMIT = 5000;

export function RulesTab({ onOpenManager }: { onOpenManager?: () => void }) {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const settings = useAppStore((s) => s.settings);

    const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
    const contextLimit = settings.contextLimit || 8192;
    const rulesBudget = Math.floor(contextLimit * rulesBudgetPct);
    const threshold = Math.floor(rulesBudget * 1.2);
    const tokenCount = countTokens(context.rulesRaw);
    const ragActive = tokenCount > threshold;

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
                <div className="flex items-center justify-between mt-1">
                    <TokenCounter text={context.rulesRaw} limit={RULES_LIMIT} />
                    <span className={`text-[9px] font-mono ml-2 ${ragActive ? 'text-terminal' : 'text-text-dim'}`}>
                        {tokenCount.toLocaleString()}/{threshold} tok {ragActive ? '● RAG' : '● verbatim'}
                    </span>
                </div>
                {ragActive && (
                    <div className="mt-2 flex items-center justify-between">
                        <span className="text-[9px] text-terminal-dim">
                            RAG active — chunks retrieved per turn (budget: {rulesBudget} tok)
                        </span>
                        {onOpenManager && (
                            <button
                                onClick={onOpenManager}
                                className="flex items-center gap-1 text-[9px] text-terminal hover:text-text-primary transition-colors"
                            >
                                <Settings2 size={10} />
                                Manage chunks
                            </button>
                        )}
                    </div>
                )}
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
                    <div className="space-y-3">
                        <PayloadTraceView />
                        <LootDropTraceView compact />
                    </div>
                </div>
            )}
        </div>
    );
}