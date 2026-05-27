import { useCallback, useMemo } from 'react';
import type { ChatMessage } from '../../types';
import { computeTrimIndex, getVerbatimWindow } from '../../services/payload';

interface UseCondenserDeps {
    messages: ChatMessage[];
    condenser: { condensedUpToIndex: number };
    setCondensed: (upToIndex: number) => void;
    resetCondenser: () => void;
}

export function useCondenser(deps: UseCondenserDeps) {
    const triggerCondense = useCallback(() => {
        if (deps.messages.length <= getVerbatimWindow()) return;
        const newIndex = computeTrimIndex(deps.messages, deps.condenser.condensedUpToIndex);
        if (newIndex === deps.condenser.condensedUpToIndex) return;
        deps.setCondensed(newIndex);
    }, [deps.messages, deps.condenser.condensedUpToIndex, deps.setCondensed]);

    return useMemo(() => ({
        triggerCondense,
    }), [
        triggerCondense,
    ]);
}