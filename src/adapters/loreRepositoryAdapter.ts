/**
 * loreRepositoryAdapter — wires campaignStore behind the
 * LoreRepositoryPort.
 *
 * This is the *only* file allowed to import both:
 *   - `src/ports/loreRepository`  (the contract services depend on)
 *   - `src/store/campaignStore`   (the implementation)
 */

import { saveLoreChunks, getLoreChunks } from '../store/campaignStore';
import { registerLoreRepository, type LoreRepositoryPort } from '../ports/loreRepository';

export const loreRepositoryAdapter: LoreRepositoryPort = {
    saveLoreChunks: (id, chunks) => saveLoreChunks(id, chunks),
    getLoreChunks:  (id)         => getLoreChunks(id),
};

export function wireLoreRepository(): void {
    registerLoreRepository(loreRepositoryAdapter);
}
