import type { LoreChunk } from '../../types';
import { embeddingStorage } from '../storage/embeddingStorage';
import { getCurrentModelId } from '../embedding';
import { enqueueProgressiveWithExistingCheck } from '../embedding/embeddingScheduler';

export type IndexingProgress = {
    phase: 'embedding' | 'orphan-cleanup' | 'done';
    current: number;
    total: number;
};

export function deriveDefaultLoreMeta(chunk: LoreChunk): ('vector' | 'keyword' | 'always')[] {
    if (chunk.activationModes) return chunk.activationModes;
    if (chunk.ragMode) return [chunk.ragMode];
    if (chunk.alwaysInclude || chunk.priority >= 9) return ['always'];
    return ['vector', 'keyword'];
}

/**
 * Returns `['vector', 'keyword']` when `modes` is the legacy unhinted default of
 * `['vector']`-only; otherwise returns `modes` unchanged.
 *
 * Older builds had the chunker emit vector-only as the no-hint default, so every
 * imported chunk persisted a single 'vector' mode and never picked up keyword
 * matching — the user had to toggle keyword on by hand. The intended default has
 * always been both. This upgrades those stale chunks in place. Explicit
 * `<!-- rag: vector -->` hints (ragMode === 'vector') and user-toggled chunks are
 * left alone by the callers via their own guards.
 */
export function upgradeVectorOnlyDefault(
    modes: ('vector' | 'keyword' | 'always')[] | undefined
): ('vector' | 'keyword' | 'always')[] | undefined {
    if (modes && modes.length === 1 && modes[0] === 'vector') {
        return ['vector', 'keyword'];
    }
    return modes;
}

export async function indexLore(
    campaignId: string,
    chunks: LoreChunk[],
    onProgress?: (progress: IndexingProgress) => void
): Promise<void> {
    if (!campaignId || chunks.length === 0) return;

    const modelId = getCurrentModelId();
    const existingIds = new Set(
        (await embeddingStorage.getAll(campaignId, 'lore')).map(e => e.id)
    );

    const currentChunkIds = new Set(chunks.map(c => c.id));

    const toEmbed: LoreChunk[] = [];
    for (const chunk of chunks) {
        if (!existingIds.has(chunk.id) || chunk.embeddedModelId !== modelId) {
            toEmbed.push(chunk);
        }
    }

    for (const chunk of toEmbed) {
        chunk.embeddedModelId = modelId;
    }

    onProgress?.({ phase: 'embedding', current: 0, total: toEmbed.length });

    const vectorChunks = toEmbed.filter(c => {
        const modes = deriveDefaultLoreMeta(c);
        return modes.includes('vector');
    });

    if (vectorChunks.length > 0) {
        await enqueueProgressiveWithExistingCheck({
            campaignId,
            type: 'lore',
            chunks: vectorChunks.map(c => ({
                id: c.id,
                content: c.content,
                modes: deriveDefaultLoreMeta(c),
                priority: c.priority,
            })),
        });
    }

    onProgress?.({ phase: 'orphan-cleanup', current: 0, total: existingIds.size });
    let orphanCount = 0;
    for (const existingId of existingIds) {
        if (!currentChunkIds.has(existingId)) {
            await embeddingStorage.deleteByTypeAndId(campaignId, 'lore', existingId).catch(() => {});
            orphanCount++;
        }
        onProgress?.({ phase: 'orphan-cleanup', current: orphanCount, total: existingIds.size });
    }

    console.log(`[LoreIndexer] Queued ${vectorChunks.length} chunks for progressive embedding, cleaned ${orphanCount} orphans`);
    onProgress?.({ phase: 'done', current: chunks.length, total: chunks.length });
}