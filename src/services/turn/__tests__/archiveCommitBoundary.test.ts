import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../apiClient';
import { backgroundQueue } from '../../infrastructure/backgroundQueue';
import { handlePostTurn } from '../turnPostProcess';
import type { TurnCallbacks, TurnState } from '../turnTypes';

afterEach(() => vi.restoreAllMocks());

describe('post-turn archive boundary', () => {
    it('propagates storage failure before mutating state or queuing post-processing', async () => {
        vi.spyOn(api.archive, 'append').mockRejectedValueOnce(new Error('Storage full'));
        const queue = vi.spyOn(backgroundQueue, 'push');
        const updateContext = vi.fn();
        const setArchiveIndex = vi.fn();
        const addMessage = vi.fn();
        await expect(handlePostTurn(
            { context: { agencyDigest: 'keep me', arcDigest: 'keep me' } } as TurnState,
            { updateContext, setArchiveIndex, addMessage } as unknown as TurnCallbacks,
            'player', 'camp', [], 'reply', async () => [], 'gm-1',
        )).rejects.toThrow('Storage full');
        expect(updateContext).not.toHaveBeenCalled();
        expect(setArchiveIndex).not.toHaveBeenCalled();
        expect(addMessage).not.toHaveBeenCalled();
        expect(queue).not.toHaveBeenCalled();
    });

    it('recovers an already durable scene without repeating post-turn effects', async () => {
        const append = vi.spyOn(api.archive, 'append').mockResolvedValueOnce({ sceneId: '001', sceneNumber: 1, timestamp: 1, created: false });
        vi.spyOn(api.archive, 'getIndex').mockResolvedValueOnce([]);
        const queue = vi.spyOn(backgroundQueue, 'push');
        const updateContext = vi.fn();
        const addMessage = vi.fn();
        await handlePostTurn(
            { getMessages: () => [] } as unknown as TurnState,
            { updateContext, addMessage, setArchiveIndex: vi.fn() } as unknown as TurnCallbacks,
            'player', 'camp', [], 'reply', async () => [], 'gm-1',
        );
        expect(append).toHaveBeenCalledWith('camp', 'player', 'reply', 'gm-1');
        expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'scene-marker-gm-1' }));
        expect(updateContext).not.toHaveBeenCalled();
        expect(queue).not.toHaveBeenCalled();
    });
});
