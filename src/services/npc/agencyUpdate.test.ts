import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateExistingNPCs } from './npcGeneration';
import { buildDriftAlert } from './npcBehaviorDirective';
import type { NPCEntry, LLMProvider, ChatMessage } from '../../types';

vi.mock('../llm/llmCall', () => ({
    llmCall: vi.fn()
}));

import { llmCall } from '../llm/llmCall';
const mockLlmCall = vi.mocked(llmCall);

describe('agencyUpdate — updateExistingNPCs & buildDriftAlert', () => {
    const provider = { endpoint: 'http://mock-llm', modelName: 'mock-model' } as LLMProvider;
    const history: ChatMessage[] = [];

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('no legacy writes: drops drives and affinity from the patch', async () => {
        const npc = {
            id: 'npc-kael',
            name: 'Kael',
            isPC: false,
            pcRelation: 0,
            wants: { short: [], medium: [], long: '' }
        } as unknown as NPCEntry;

        const updateNPCStore = vi.fn();

        // Model wrongly responds with "drives" and "affinity"
        mockLlmCall.mockResolvedValue(JSON.stringify({
            updates: [
                {
                    name: 'Kael',
                    changes: {
                        drives: { coreWant: 'Should be dropped' },
                        affinity: 80,
                        status: 'Alive'
                    }
                }
            ]
        }));

        await updateExistingNPCs(provider, history, [npc], updateNPCStore);

        expect(updateNPCStore).toHaveBeenCalledTimes(1);
        const patch = updateNPCStore.mock.calls[0][1];
        expect(patch.drives).toBeUndefined();
        expect(patch.affinity).toBeUndefined();
        expect(patch.status).toBe('Alive');
    });

    it('wants revision: updates medium/long wants, preserves short wants', async () => {
        const npc = {
            id: 'npc-kael',
            name: 'Kael',
            isPC: false,
            wants: {
                short: ['eat', 'sleep'],
                medium: ['find a sword'],
                long: 'rule the valley'
            }
        } as unknown as NPCEntry;

        const updateNPCStore = vi.fn();

        mockLlmCall.mockResolvedValue(JSON.stringify({
            updates: [
                {
                    name: 'Kael',
                    changes: {
                        wants: {
                            short: ['this should be ignored'],
                            medium: ['find a magic sword', 'defeat the dragon'],
                            long: 'rule the empire'
                        }
                    }
                }
            ]
        }));

        await updateExistingNPCs(provider, history, [npc], updateNPCStore);

        expect(updateNPCStore).toHaveBeenCalledTimes(1);
        const patch = updateNPCStore.mock.calls[0][1];
        expect(patch.wants).toBeDefined();
        expect(patch.wants.short).toEqual(['eat', 'sleep']); // preserved
        expect(patch.wants.medium).toEqual(['find a magic sword', 'defeat the dragon']); // updated
        expect(patch.wants.long).toBe('rule the empire'); // updated
    });

    it('relationship is engine-owned: the "tones" channel moves the band; AI-sent pcRelation is ignored', async () => {
        const alden = { id: 'n1', name: 'Alden', isPC: false, pcRelation: 0, relationMeter: 0 } as unknown as NPCEntry;
        const bram = { id: 'n2', name: 'Bram', isPC: false, pcRelation: 1 } as unknown as NPCEntry;

        const updateNPCStore = vi.fn();

        mockLlmCall.mockResolvedValue(JSON.stringify({
            // Bram: the model tries to set the band directly — this must be discarded.
            updates: [{ name: 'Bram', changes: { pcRelation: 3 } }],
            // Alden: a 'bonding' tone is the deterministic +100 step → band 0 → +1.
            tones: [{ name: 'Alden', tone: 'bonding' }],
        }));

        await updateExistingNPCs(provider, history, [alden, bram], updateNPCStore);

        const aldenPatch = updateNPCStore.mock.calls.find(c => c[0] === 'n1')![1];
        expect(aldenPatch.pcRelation).toBe(1); // moved by the engine via the tone meter

        const bramPatch = updateNPCStore.mock.calls.find(c => c[0] === 'n2')![1];
        expect(bramPatch.pcRelation).toBeUndefined(); // AI-supplied band stripped (engine-owned)
    });

    it('hex delta: boldness +1 moves it; absolute-looking overwrite is neutralized to max ±1 step', async () => {
        const npc1 = {
            id: 'n1',
            name: 'Alden',
            isPC: false,
            personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 }
        } as unknown as NPCEntry;

        const npc2 = {
            id: 'n2',
            name: 'Bram',
            isPC: false,
            personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 }
        } as unknown as NPCEntry;

        const updateNPCStore = vi.fn();

        mockLlmCall.mockResolvedValue(JSON.stringify({
            updates: [
                {
                    name: 'Alden',
                    changes: { personalityHex: { boldness: 1 } }
                },
                {
                    name: 'Bram',
                    changes: { personalityHex: { drive: 3, diligence: 1, boldness: -2, warmth: 0, empathy: 0, composure: 0 } }
                }
            ]
        }));

        await updateExistingNPCs(provider, history, [npc1, npc2], updateNPCStore);

        expect(updateNPCStore).toHaveBeenCalledTimes(2);

        const aldenPatch = updateNPCStore.mock.calls.find(c => c[0] === 'n1')![1];
        expect(aldenPatch.personalityHex.boldness).toBe(1);

        const bramPatch = updateNPCStore.mock.calls.find(c => c[0] === 'n2')![1];
        // drive: delta 3 -> clamped to +1 -> final 1
        // diligence: delta 1 -> clamped to +1 -> final 1
        // boldness: delta -2 -> clamped to -1 -> final -1
        expect(bramPatch.personalityHex).toEqual({
            drive: 1,
            diligence: 1,
            boldness: -1,
            warmth: 0,
            empathy: 0,
            composure: 0
        });
    });

    it('SHIFT emitted: a hex-update entry and a tone-driven band move share one previousSnapshot', async () => {
        const npc = {
            id: 'n1',
            name: 'Alden',
            isPC: false,
            pcRelation: 0,
            relationMeter: 0,
            personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 }
        } as unknown as NPCEntry;

        const updateNPCStore = vi.fn();

        mockLlmCall.mockResolvedValue(JSON.stringify({
            // hex drift in the rare "updates" channel + a 'bonding' tone (deterministic +100 → band 0→+1)
            updates: [{ name: 'Alden', changes: { personalityHex: { boldness: 1 } } }],
            tones: [{ name: 'Alden', tone: 'bonding' }],
        }));

        await updateExistingNPCs(provider, history, [npc], updateNPCStore);

        expect(updateNPCStore).toHaveBeenCalledTimes(1); // tone folds into the update entry
        const patch = updateNPCStore.mock.calls[0][1];

        expect(patch.pcRelation).toBe(1); // engine-owned band move
        expect(patch.previousSnapshot).toBeDefined();
        expect(patch.previousSnapshot.pcRelation).toBe(0);
        expect(patch.previousSnapshot.personalityHex).toEqual({ drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 });

        // Simulate applying the patch to the npc
        const updatedNpc: NPCEntry = {
            ...npc,
            ...patch,
            personalityHex: patch.personalityHex,
            previousSnapshot: patch.previousSnapshot
        };

        const alert = buildDriftAlert(updatedNpc);
        expect(alert).toContain('SHIFT:');
        expect(alert).toContain('boldness Measured → Bold');
        expect(alert).toContain('feeling toward PC Neutral → Friendly');
    });

    it('legacy NPC fallback: un-migrated NPC skips hex parse instead of crashing', async () => {
        const npc = {
            id: 'n1',
            name: 'Alden',
            isPC: false,
            // no personalityHex
            pcRelation: undefined
        } as unknown as NPCEntry;

        const updateNPCStore = vi.fn();

        mockLlmCall.mockResolvedValue(JSON.stringify({
            updates: [
                {
                    name: 'Alden',
                    changes: { personalityHex: { boldness: 1 }, status: 'Alive' }
                }
            ]
        }));

        // Should not crash and should delete/ignore the personalityHex update since the NPC has no baseline personalityHex
        await updateExistingNPCs(provider, history, [npc], updateNPCStore);

        expect(updateNPCStore).toHaveBeenCalledTimes(1);
        const patch = updateNPCStore.mock.calls[0][1];
        expect(patch.personalityHex).toBeUndefined();
        expect(patch.status).toBe('Alive');
    });
});
