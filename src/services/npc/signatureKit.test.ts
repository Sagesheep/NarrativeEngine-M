import { describe, it, expect, vi } from 'vitest';
import { sanitizeSignatureKit, renderSignatureKit, KIT_MAX_ENTRIES, KIT_ENTRY_MAXLEN } from './signatureKit';
import { assembleWorldBlocks } from '../payload/payloadWorldContext';
import { updateExistingNPCs } from './npcGeneration';
import type { LLMProvider, NPCEntry } from '../../types';

vi.mock('../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../utils/llmCall';
const mockLlmCall = vi.mocked(llmCall);

describe('sanitizeSignatureKit', () => {
    it('trims, drops blanks and caps entries and length', () => {
        const kit = sanitizeSignatureKit({
            equipment: ['  iron   spear ', '', ...Array.from({ length: 12 }, (_, i) => `item ${i}`)],
            abilities: ['x'.repeat(80)],
            element: '  fire ',
        })!;
        expect(kit.equipment[0]).toBe('iron spear');
        expect(kit.equipment).toHaveLength(KIT_MAX_ENTRIES);
        expect(kit.abilities[0]).toHaveLength(KIT_ENTRY_MAXLEN);
        expect(kit.element).toBe('fire');
    });

    it('an update replaces only the channel it sends', () => {
        const existing = { equipment: ['Excalibur'], abilities: ['fire magic'], element: 'fire' };
        expect(sanitizeSignatureKit({ equipment: ['iron spear'] }, existing))
            .toEqual({ equipment: ['iron spear'], abilities: ['fire magic'], element: 'fire' });
    });

    it('an empty kit is undefined; a non-object keeps the existing kit', () => {
        expect(sanitizeSignatureKit({ equipment: [''], abilities: [] })).toBeUndefined();
        const existing = { equipment: ['a'], abilities: [] };
        expect(sanitizeSignatureKit('nonsense', existing)).toBe(existing);
        expect(sanitizeSignatureKit(undefined)).toBeUndefined();
    });
});

describe('NPC updater and the kit', () => {
    const provider = { endpoint: 'http://mock-llm', modelName: 'mock-model' } as LLMProvider;
    const rick = {
        id: 'n1', name: 'Rick', isPC: false, pcRelation: 0, wants: { short: [], medium: [], long: '' },
        signatureKit: { equipment: ['Excalibur (holy longsword)'], abilities: ['fire magic'] },
    } as unknown as NPCEntry;

    it('shows the current kit to the model and merges a one-channel change', async () => {
        mockLlmCall.mockResolvedValue(JSON.stringify({ updates: [{ name: 'Rick', changes: { signatureKit: { equipment: ['iron spear'] } } }] }));
        const updateNPCStore = vi.fn();
        await updateExistingNPCs(provider, [], [rick], updateNPCStore);

        expect(String(mockLlmCall.mock.calls[0][1])).toContain('SignatureKit: gear=[Excalibur (holy longsword)] powers=[fire magic]');
        expect(updateNPCStore.mock.calls[0][1].signatureKit).toEqual({ equipment: ['iron spear'], abilities: ['fire magic'], element: undefined });
    });
});

describe('Signature Kit in the prompt', () => {
    it('renders gear, powers and element', () => {
        expect(renderSignatureKit({ equipment: ['Excalibur'], abilities: ['fire magic'], element: 'fire' }))
            .toBe('KIT: Excalibur | POWERS: fire magic | element: fire');
        expect(renderSignatureKit(undefined)).toBe('');
    });

    it("rides in an on-stage NPC's PLAY AS line", () => {
        const npc = {
            id: 'n1', name: 'Rick', aliases: '', status: 'Alive', faction: '', storyRelevance: '', disposition: '',
            goals: '', voice: '', appearance: '', personality: '', exampleOutput: '', affinity: 50,
            signatureKit: { equipment: ['Excalibur (holy longsword)'], abilities: [] },
        } as unknown as NPCEntry;
        const blocks = assembleWorldBlocks({
            context: {} as never, npcLedger: [npc], onStageNpcIds: ['n1'], userMessage: 'Rick draws his sword', history: [],
            addTrace: () => {},
        });
        const text = JSON.stringify(blocks);
        expect(text).toContain('KIT: Excalibur (holy longsword)');
    });
});
