import { useEffect, useRef, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { indexLore, deriveDefaultLoreMeta } from '../services/lore/loreIndexer';
import { saveLoreChunks } from '../store/campaignStore';

export function useLoreIndexer() {
    const loreChunks = useAppStore((s) => s.loreChunks);
    const activeCampaignId = useAppStore((s) => s.activeCampaignId);
    const setLoreChunks = useAppStore((s) => s.setLoreChunks);

    const lastIndexedHash = useRef<string>('');
    const indexingRef = useRef(false);
    const loreChunksRef = useRef(loreChunks);
    loreChunksRef.current = loreChunks;

    const runIndex = useCallback(async () => {
        if (!activeCampaignId || loreChunksRef.current.length === 0 || indexingRef.current) return;

        const chunks = loreChunksRef.current;
        const totalTokens = chunks.reduce((sum, c) => sum + c.tokens, 0);
        const hash = `${chunks.length}_${totalTokens}_${chunks[0]?.id ?? ''}`;
        if (hash === lastIndexedHash.current) return;

        indexingRef.current = true;
        lastIndexedHash.current = hash;

        try {
            const needsMetaUpdate = chunks.some(c => !c.activationModes);
            await indexLore(activeCampaignId, chunks);

            if (needsMetaUpdate) {
                const updated = chunks.map(c => ({
                    ...c,
                    activationModes: c.activationModes ?? deriveDefaultLoreMeta(c),
                }));
                setLoreChunks(updated);
                await saveLoreChunks(activeCampaignId, updated);
            }

            console.log(`[LoreIndexer] Auto-indexed ${chunks.length} lore chunk(s)`);
        } catch (e) {
            console.warn('[LoreIndexer] Auto-indexing failed:', e);
        } finally {
            indexingRef.current = false;
        }
    }, [activeCampaignId, setLoreChunks]);

    useEffect(() => {
        const timer = setTimeout(() => {
            runIndex();
        }, 3000);
        return () => clearTimeout(timer);
    }, [runIndex]);
}