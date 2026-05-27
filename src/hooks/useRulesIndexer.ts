import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { indexRules, computeRulesThreshold } from '../services/lore';
import { countTokens } from '../services/infrastructure';

export function useRulesIndexer() {
    const rulesRaw = useAppStore((s) => s.context.rulesRaw);
    const rulesChunkMeta = useAppStore((s) => s.context.rulesChunkMeta);
    const updateContext = useAppStore((s) => s.updateContext);
    const activeCampaignId = useAppStore((s) => s.activeCampaignId);
    const settings = useAppStore((s) => s.settings);
    const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
    const contextLimit = settings.contextLimit || 8192;
    const autoGenerate = settings.autoGenerateRuleKeywords ?? true;
    const getUtilityEndpoint = useAppStore((s) => s.getActiveUtilityEndpoint);

    const lastIndexedHash = useRef<string>('');
    const indexingRef = useRef(false);
    const rulesChunkMetaRef = useRef(rulesChunkMeta);
    rulesChunkMetaRef.current = rulesChunkMeta;

    const runIndex = useCallback(async () => {
        if (!activeCampaignId || !rulesRaw || indexingRef.current) return;

        const threshold = computeRulesThreshold(contextLimit, rulesBudgetPct);
        const tokenCount = countTokens(rulesRaw);
        if (tokenCount <= threshold) return;

        const hash = `${rulesRaw.length}_${tokenCount}_${rulesRaw.slice(0, 200)}`;
        if (hash === lastIndexedHash.current) return;

        indexingRef.current = true;
        lastIndexedHash.current = hash;

        try {
            const utilityEndpoint = getUtilityEndpoint();
            const result = await indexRules(
                activeCampaignId,
                rulesRaw,
                rulesChunkMetaRef.current,
                utilityEndpoint?.endpoint ? utilityEndpoint : undefined,
                autoGenerate,
            );
            updateContext({ rulesChunkMeta: result.chunkMeta });
            console.log(`[RulesIndexer] Auto-indexed ${result.chunks.length} rule chunks(s)`);
        } catch (e) {
            console.warn('[RulesIndexer] Auto-indexing failed:', e);
        } finally {
            indexingRef.current = false;
        }
    }, [activeCampaignId, rulesRaw, rulesBudgetPct, contextLimit, autoGenerate, getUtilityEndpoint, updateContext]);

    useEffect(() => {
        const timer = setTimeout(() => {
            runIndex();
        }, 3000);
        return () => clearTimeout(timer);
    }, [runIndex]);
}