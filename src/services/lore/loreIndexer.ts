import type { LoreChunk } from '../../types';
import { embeddingStorage } from '../storage/embeddingStorage';
import { embedText, getCurrentModelId } from '../embedding';

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

    // Determine which chunks need embedding (new or model changed)
    const toEmbed: LoreChunk[] = [];
    for (const chunk of chunks) {
        if (!existingIds.has(chunk.id) || chunk.embeddedModelId !== modelId) {
            toEmbed.push(chunk);
        }
    }

    onProgress?.({ phase: 'embedding', current: 0, total: toEmbed.length });

    let embeddedCount = 0;
    for (const chunk of toEmbed) {
        try {
            const vec = await embedText(chunk.content.slice(0, 500));
            if (vec) {
                await embeddingStorage.store(campaignId, chunk.id, Array.from(vec), 'lore', modelId);
            }
            chunk.embeddedModelId = modelId;
        } catch (e) {
            console.warn(`[LoreIndexer] Embed failed for ${chunk.id}:`, e);
        }
        embeddedCount++;
        onProgress?.({ phase: 'embedding', current: embeddedCount, total: toEmbed.length });
    }

    // Orphan cleanup: delete embeddings for chunks that no longer exist
    onProgress?.({ phase: 'orphan-cleanup', current: 0, total: existingIds.size });
    let orphanCount = 0;
    for (const existingId of existingIds) {
        if (!currentChunkIds.has(existingId)) {
            // existingIds already contains any stored #wN sub-chunk ids verbatim, so an
            // exact-id delete covers both base chunks and window sub-chunks.
            await embeddingStorage.deleteByTypeAndId(campaignId, 'lore', existingId).catch(() => {});
            orphanCount++;
        }
        onProgress?.({ phase: 'orphan-cleanup', current: orphanCount, total: existingIds.size });
    }

    console.log(`[LoreIndexer] Indexed ${toEmbed.length} chunks, cleaned ${orphanCount} orphans`);
    onProgress?.({ phase: 'done', current: chunks.length, total: chunks.length });
}