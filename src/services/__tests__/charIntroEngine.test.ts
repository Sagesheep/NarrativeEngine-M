import { describe, it, expect } from 'vitest';
import { rollCharacterIntroEngine } from '../engine';
import type { GameContext, CharacterIntroEntry, ChatMessage } from '../../types';

const makeContext = (overrides?: Partial<GameContext>): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: { identity: {}, activeTraits: [] },
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    characterProfileUserDisabled: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    npcIntroConfig: {
        initialDC: 196,
        dcReduction: 2,
        characters: [],
    },
    npcIntroEngineActive: true,
    npcIntroDC: 196,
    ...overrides,
} as GameContext);

const makeMessages = (contents: string[]): ChatMessage[] =>
    contents.map((c, i) => ({
        id: `msg-${i}`,
        role: 'assistant' as const,
        content: c,
        timestamp: Date.now(),
    }));

describe('rollCharacterIntroEngine', () => {
    it('returns empty tag when config has no characters', async () => {
        const ctx = makeContext();
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.tag).toBe('');
    });

    it('returns empty tag when engine is disabled', async () => {
        const chars: CharacterIntroEntry[] = [{ name: 'Bram', type: 'wandering' }];
        const ctx = makeContext({
            npcIntroEngineActive: false,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.tag).toBe('');
    });

    it('decays DC when roll does not fire', async () => {
        const chars: CharacterIntroEntry[] = [{ name: 'Bram', type: 'wandering' }];
        const ctx = makeContext({
            npcIntroDC: 196,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.tag).toBe('');
        expect(result.newDC).toBeLessThanOrEqual(194);
    });

    it('does not reduce DC below 5', async () => {
        const chars: CharacterIntroEntry[] = [{ name: 'Bram', type: 'wandering' }];
        const ctx = makeContext({
            npcIntroDC: 6,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.newDC).toBeGreaterThanOrEqual(5);
    });

    it('fires when DC is 1 (guaranteed trigger)', async () => {
        const chars: CharacterIntroEntry[] = [{ name: 'Bram', type: 'wandering' }];
        const ctx = makeContext({
            npcIntroDC: 1,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.tag).toContain('INTRODUCE CHARACTER');
        expect(result.tag).toContain('Bram');
        expect(result.newDC).toBe(196);
    });

    it('excludes already-seen NPCs', async () => {
        const chars: CharacterIntroEntry[] = [{ name: 'Bram', type: 'wandering' }];
        const ctx = makeContext({
            npcIntroDC: 1,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, ['Bram'], []);
        expect(result.tag).toBe('');
        expect(result.newDC).toBe(1);
    });

    it('filters location-bound NPCs when no utility provider', async () => {
        const chars: CharacterIntroEntry[] = [
            { name: 'Cynthia', type: 'location', location: 'City A' },
        ];
        const ctx = makeContext({
            npcIntroDC: 1,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.tag).toBe('');
    });

    it('picks wandering NPC without utility provider', async () => {
        const chars: CharacterIntroEntry[] = [
            { name: 'Secret Merchant', type: 'wandering' },
        ];
        const ctx = makeContext({
            npcIntroDC: 1,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.tag).toContain('Secret Merchant');
    });

    it('applies boost weighting when boost keywords found in recent messages', async () => {
        const chars: CharacterIntroEntry[] = [
            { name: 'Bram', type: 'wandering+boosted', boostKeywords: ['fight', 'brawl'] },
        ];
        const ctx = makeContext({
            npcIntroDC: 1,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const msgs = makeMessages(['A great brawl breaks out in the tavern!']);
        const result = await rollCharacterIntroEngine(ctx, [], msgs);
        expect(result.tag).toContain('Bram');
    });

    it('skips when all candidates are seen', async () => {
        const chars: CharacterIntroEntry[] = [
            { name: 'Bram', type: 'wandering' },
            { name: 'Cynthia', type: 'location', location: 'City A' },
        ];
        const ctx = makeContext({
            npcIntroDC: 1,
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, ['Bram', 'Cynthia'], []);
        expect(result.tag).toBe('');
        expect(result.newDC).toBe(1);
    });

    it('uses provided DC values over defaults', async () => {
        const chars: CharacterIntroEntry[] = [{ name: 'Test', type: 'wandering' }];
        const ctx = makeContext({
            npcIntroDC: 999,
            npcIntroConfig: { initialDC: 999, dcReduction: 3, characters: chars },
        });
        const result = await rollCharacterIntroEngine(ctx, [], []);
        expect(result.newDC).toBeLessThanOrEqual(999);
        expect(result.newDC).toBeGreaterThanOrEqual(5);
    });
});