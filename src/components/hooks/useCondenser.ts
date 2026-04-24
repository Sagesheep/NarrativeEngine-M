import { useState, useRef } from 'react';
import type { ChatMessage, LLMProvider } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { condenseHistory } from '../../services/condenser';
import { runSaveFilePipeline } from '../../services/saveFileEngine';
import { api } from '../../services/apiClient';
import { toast } from '../Toast';

interface UseCondenserDeps {
    activeCampaignId: string | null;
    isStreaming: boolean;
    messages: ChatMessage[];
    condenser: { condensedSummary: string; condensedUpToIndex: number; isCondensing: boolean };
    settings: { contextLimit: number };
    context: any;
    npcLedger: any[];
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondensing: (v: boolean) => void;
    resetCondenser: () => void;
    updateContext: (patch: any) => void;
    setArchiveIndex: (entries: any[]) => void;
    setSemanticFacts: (facts: any[]) => void;
    getActiveSummarizerEndpoint: () => LLMProvider | undefined;
    getActiveStoryEndpoint: () => LLMProvider | undefined;
}

export function useCondenser(deps: UseCondenserDeps) {
    const condenseAbortRef = useRef<AbortController | null>(null);
    const [editingSummary, setEditingSummary] = useState(false);
    const [summaryDraft, setSummaryDraft] = useState('');
    const [condensePhase, setCondensePhase] = useState<'save' | 'compress' | null>(null);

    const triggerCondense = async () => {
        if (deps.condenser.isCondensing) return;
        deps.setCondensing(true);
        condenseAbortRef.current = new AbortController();
        try {
            const provider = deps.getActiveSummarizerEndpoint() ?? deps.getActiveStoryEndpoint();
            if (!provider) return;
            const currentCtx = deps.context;
            const uncondensed = deps.messages.slice(deps.condenser.condensedUpToIndex + 1);

            setCondensePhase('save');
            try {
                const saveResult = await runSaveFilePipeline(provider as LLMProvider, uncondensed, currentCtx);
                if (saveResult.canonSuccess) deps.updateContext({ canonState: saveResult.canonState });
                if (saveResult.indexSuccess) deps.updateContext({ headerIndex: saveResult.headerIndex });
                if (saveResult.coreMemorySlots) deps.updateContext({ coreMemorySlots: saveResult.coreMemorySlots });
            } catch {
                toast.warning('Save pipeline failed — continuing with condensation');
            }

            setCondensePhase('compress');
            const freshCtx = deps.context;
            const result = await condenseHistory(
                provider,
                deps.messages,
                freshCtx,
                deps.condenser.condensedUpToIndex,
                deps.condenser.condensedSummary,
                deps.activeCampaignId || '',
                deps.npcLedger.map(n => n.name),
                deps.settings.contextLimit,
                condenseAbortRef.current.signal
            );
            deps.setCondensed(result.summary, result.upToIndex);

            if (deps.activeCampaignId) {
                const fresh = await api.archive.getIndex(deps.activeCampaignId);
                deps.setArchiveIndex(fresh);
                const freshFacts = await api.facts.get(deps.activeCampaignId).catch(() => []);
                deps.setSemanticFacts(freshFacts);
            }
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                console.error('[Condenser]', err);
                toast.error('Condenser failed');
            }
        } finally {
            setCondensePhase(null);
            deps.setCondensing(false);
            condenseAbortRef.current = null;
        }
    };

    const handleRetcon = () => {
        if (!confirm('Retcon: Delete all messages and keep only the summary?')) return;
        const sysMsg: ChatMessage = {
            id: Date.now().toString(36),
            role: 'system',
            content: deps.condenser.condensedSummary,
            timestamp: Date.now(),
        };
        useAppStore.setState({ messages: [sysMsg] });
        deps.setCondensed('', 0);
        setEditingSummary(false);
    };

    return {
        triggerCondense,
        condenseAbortRef,
        condensePhase,
        editingSummary,
        setEditingSummary,
        summaryDraft,
        setSummaryDraft,
        handleRetcon,
    };
}