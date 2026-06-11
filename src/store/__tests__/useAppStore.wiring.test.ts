import { describe, it, expect, vi } from 'vitest';

// Guard for BUG-2 (Upgrade/FablePlans/01): the embedding scheduler can only
// see the store if useAppStore.ts calls registerStore() at import time. The
// scheduler's own suite tests the setter with a mock store; this test asserts
// the production wiring line itself, so deleting it fails CI instead of
// silently disabling the progress chip and the streaming pause again.
vi.mock('../../services/embedding/embeddingScheduler', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../services/embedding/embeddingScheduler')>();
    return { ...actual, registerStore: vi.fn() };
});

import { registerStore } from '../../services/embedding/embeddingScheduler';
import { useAppStore } from '../useAppStore';

describe('useAppStore → embeddingScheduler wiring', () => {
    it('registers the live store with the scheduler at import time', () => {
        expect(registerStore).toHaveBeenCalledWith(useAppStore);
    });
});
