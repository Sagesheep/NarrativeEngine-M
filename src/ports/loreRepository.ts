/**
 * LoreRepositoryPort — persistence seam for lore chunks.
 *
 * Services that need to persist lore chunks (loreKeywordEnricher,
 * useLoreIndexer) used to import saveLoreChunks directly from
 * store/campaignStore — a runtime leak (services → store).
 *
 * This port flips the arrow. Services depend on the contract, not
 * the implementation. The app wires the real implementation
 * (campaignStore) behind the port at boot via the adapter.
 *
 * ── Layer rule ──────────────────────────────────────────────────
 *   services/*  →  may import ports/loreRepository  ✓
 *   store/*     →  must NOT be imported by services
 *   adapters/*  →  the only place that knows both sides
 */

import type { LoreChunk } from '../types';

export interface LoreRepositoryPort {
    saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void>;
    getLoreChunks(campaignId: string): Promise<LoreChunk[]>;
}

// ── Default no-op sink until the real adapter is registered ────
// Throws on use so a forgotten wire() call surfaces immediately
// in dev rather than silently dropping data.

let _impl: LoreRepositoryPort | null = null;

export function registerLoreRepository(impl: LoreRepositoryPort): void {
    _impl = impl;
}

function impl(): LoreRepositoryPort {
    if (!_impl) {
        throw new Error(
            'LoreRepositoryPort not wired. Call registerLoreRepository() ' +
            'from app bootstrap before any service uses it.'
        );
    }
    return _impl;
}

export const loreRepository: LoreRepositoryPort = {
    saveLoreChunks: (id, chunks) => impl().saveLoreChunks(id, chunks),
    getLoreChunks:  (id)         => impl().getLoreChunks(id),
};
