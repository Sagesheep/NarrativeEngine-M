import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLlmCall = vi.fn();
vi.mock('../../../utils/llmCall', () => ({ llmCall: (...args: unknown[]) => mockLlmCall(...args) }));

import { assignStateKeys } from '../stateKeyAssigner';
import { EMPTY_REGISTER } from '../divergenceRegister';
import type { DivergenceEntry, LLMProvider } from '../../../types';

const provider = { id: 'p', label: 'p', endpoint: 'http://x', apiKey: '', modelName: 'm' } as LLMProvider;
const entry = (id: string, sceneRef: string, over: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id, chapterId: 'CH01', category: 'npc_events', text: `fact ${id}`, sceneRef,
    npcIds: [], pinned: false, source: 'auto', ...over,
});

describe('assignStateKeys', () => {
    beforeEach(() => mockLlmCall.mockReset());

    it('keeps only valid keys for facts in the batch, and skips already-keyed or replaced facts', async () => {
        mockLlmCall.mockResolvedValue(JSON.stringify({ keys: [
            { id: 'a', stateKey: 'NPC:npc_1:Location' },
            { id: 'b', stateKey: 'npc:npc_1:mood' },
            { id: 'ghost', stateKey: 'npc:npc_1:location' },
        ] }));
        const register = { ...EMPTY_REGISTER, entries: [
            entry('a', '002'),
            entry('b', '003'),
            entry('keyed', '001', { stateKey: 'item:moon-key:holder', text: 'Mira holds the moon key' }),
            entry('old', '001', { status: 'superseded' }),
        ] };
        const updates = await assignStateKeys(register, [], provider, { cancelled: false }, () => {});
        expect(updates).toEqual([{ id: 'a', stateKey: 'npc:npc_1:location' }]);

        const prompt = mockLlmCall.mock.calls[0][1] as string;
        expect(prompt).toContain('item:moon-key:holder = Mira holds the moon key');
        expect(prompt).toContain('a|002|fact a');
        expect(prompt).not.toContain('keyed|001');
        expect(prompt).not.toContain('old|001');
    });

    it('carries keys chosen in one batch into the next', async () => {
        const entries = Array.from({ length: 101 }, (_, i) => entry(`f${i}`, String(i).padStart(3, '0')));
        mockLlmCall
            .mockResolvedValueOnce(JSON.stringify({ keys: [{ id: 'f0', stateKey: 'npc:npc_1:location' }] }))
            .mockResolvedValueOnce(JSON.stringify({ keys: [] }));
        await assignStateKeys({ ...EMPTY_REGISTER, entries }, [], provider, { cancelled: false }, () => {});
        expect(mockLlmCall).toHaveBeenCalledTimes(2);
        expect(mockLlmCall.mock.calls[1][1]).toContain('npc:npc_1:location = fact f0');
    });
});
