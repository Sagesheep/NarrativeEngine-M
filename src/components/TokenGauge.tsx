import { useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { countTokens } from '../services/infrastructure';
import { countRegisterTokens } from '../services/campaign-state';

export function TokenGauge() {
    const { context, settings, divergenceRegister } = useAppStore(useShallow(s => ({
        context: s.context,
        settings: s.settings,
        divergenceRegister: s.divergenceRegister,
    })));

    const messageContents = useAppStore(useShallow(s => {
        const activeMessages = (s.condenser.condensedUpToIndex !== undefined && s.condenser.condensedUpToIndex >= 0)
            ? s.messages.slice(s.condenser.condensedUpToIndex + 1)
            : s.messages;
        return activeMessages.map(m => m.content || '');
    }));

    const systemText = useMemo(() => {
        const parts: string[] = [];
        if (context.loreRaw) parts.push(context.loreRaw);
        if (context.rulesRaw) parts.push(context.rulesRaw);
        if (context.starterActive && context.starter) parts.push(context.starter);
        if (context.continuePromptActive && context.continuePrompt) parts.push(context.continuePrompt);
        if (context.characterProfileActive && context.characterProfile) parts.push(`[CHARACTER PROFILE]\n${context.characterProfile}`);
        if (context.inventoryActive && context.inventory) parts.push(`[PLAYER INVENTORY]\n${context.inventory}`);
        return parts.join('\n\n');
    }, [context.loreRaw, context.rulesRaw, context.starter, context.starterActive, context.continuePrompt, context.continuePromptActive, context.characterProfile, context.characterProfileActive, context.inventory, context.inventoryActive]);

    const systemTokens = useMemo(() => countTokens(systemText), [systemText]);

    const divTokens = useMemo(() => {
        if (!divergenceRegister || divergenceRegister.entries.length === 0) return 0;
        return countRegisterTokens(divergenceRegister);
    }, [divergenceRegister]);

    const totalSystemTokens = systemTokens + divTokens;

    const historyText = useMemo(() => {
        return messageContents.join('');
    }, [messageContents]);

    const historyTokens = useMemo(() => countTokens(historyText), [historyText]);

    const total = settings.contextLimit;
    const remaining = Math.max(0, total - totalSystemTokens - historyTokens);

    const pctSystem = Math.min((totalSystemTokens / total) * 100, 100);
    const pctHistory = Math.min((historyTokens / total) * 100, 100 - pctSystem);
    const pctFree = 100 - pctSystem - pctHistory;

    return (
        <div className="flex items-center gap-3 flex-1 min-w-0 px-3">
            <span className="text-[10px] text-text-dim uppercase tracking-widest shrink-0">
                CTX
            </span>

            <div className="flex-1 h-3 bg-void-lighter border border-border relative overflow-hidden">
                <div
                    className="absolute inset-y-0 left-0 bg-ember transition-all duration-300"
                    style={{ width: `${pctSystem}%` }}
                />
                <div
                    className="absolute inset-y-0 bg-ice transition-all duration-300"
                    style={{ left: `${pctSystem}%`, width: `${pctHistory}%` }}
                />
                <div
                    className="absolute inset-y-0 bg-void-light transition-all duration-300"
                    style={{ left: `${pctSystem + pctHistory}%`, width: `${pctFree}%` }}
                />
            </div>

            <div className="flex gap-3 text-[10px] shrink-0">
                <span className="text-ember">SYS:{totalSystemTokens}{divTokens > 0 ? <span className="text-amber-400">+{divTokens}</span> : ''}</span>
                <span className="text-ice">HIS:{historyTokens}</span>
                <span className="text-text-dim">FREE:{remaining}</span>
            </div>
        </div>
    );
}

