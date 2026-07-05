import { describe, it, expect, vi } from 'vitest';
import type { TurnState, TurnCallbacks } from '../turnTypes';
import type { NPCEntry, GameContext, AppSettings, LLMProvider, CharacterProfileState, Archetype } from '../../../types';
import { autoEnableCharacterProfile } from '../turnPostProcess';

const provider: LLMProvider = { id: 'u', endpoint: 'http://x', modelName: 'm', apiKey: '' } as never;

function makeNPC(overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'n1',
        name: 'Alden',
        isPC: false,
        ...overrides,
    } as NPCEntry;
}

function makeState(over: Partial<TurnState> = {}): TurnState {
    return {
        input: '',
        displayInput: '',
        settings: { aiTier: 'pro', contextLimit: 8192, rulesBudgetPct: 0.10, utilityTimeoutSeconds: 45 } as AppSettings,
        context: {
            characterProfileActive: false,
            characterProfileUserDisabled: false,
            characterProfile: { identity: {}, activeTraits: [] } as CharacterProfileState,
        } as unknown as GameContext,
        messages: [],
        condenser: { condensedUpToIndex: 0 },
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [],
        semanticFacts: [],
        chapters: [],
        activeCampaignId: 'camp1',
        provider,
        getMessages: () => [],
        getFreshProvider: () => provider,
        incrementBookkeepingTurnCounter: () => 1,
        autoBookkeepingInterval: 5,
        resetBookkeepingTurnCounter: () => {},
        timeline: [],
        pinnedChapterIds: [],
        clearPinnedChapters: vi.fn(),
        ...over,
    } as unknown as TurnState;
}

function makeCallbacks(): TurnCallbacks & { _patches: Partial<GameContext>[] } {
    const cb: any = { _patches: [] };
    cb.updateContext = vi.fn((patch: Partial<GameContext>) => { cb._patches.push(patch); });
    return cb;
}

function lastPatch(cb: ReturnType<typeof makeCallbacks>): any {
    return cb._patches[cb._patches.length - 1];
}

describe('B3 — autoEnableCharacterProfile for chat-made PCs', () => {
    it('flips characterProfileActive true and seeds identity.name from the PC', () => {
        const pc = makeNPC({ id: 'pc1', name: 'Kael Brightblade', isPC: true, archetype: 'bulwark' });
        const state = makeState({ npcLedger: [pc] });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        expect(cb.updateContext).toHaveBeenCalledOnce();
        const patch = lastPatch(cb);
        expect(patch.characterProfileActive).toBe(true);
        expect(patch.characterProfile.identity.name).toBe('Kael Brightblade');
        expect(patch.characterProfile.identity.archetype).toBe('bulwark');
        expect(patch.characterProfile.activeTraits).toEqual([]);
    });

    it('seeds archetype from the PC entry when identity has none', () => {
        const pc = makeNPC({ id: 'pc1', name: 'Mira', isPC: true, archetype: 'caster' as Archetype });
        const state = makeState({ npcLedger: [pc] });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        const patch = lastPatch(cb);
        expect(patch.characterProfile.identity.archetype).toBe('caster');
    });

    it('leaves characterProfileActive false when there is no isPC NPC', () => {
        const npc = makeNPC({ id: 'n1', name: 'Barkeep', isPC: false });
        const state = makeState({ npcLedger: [npc] });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        expect(cb.updateContext).not.toHaveBeenCalled();
    });

    it('is a no-op when characterProfileActive is already true (no identity clobber)', () => {
        const pc = makeNPC({ id: 'pc1', name: 'Kael', isPC: true });
        const existingProfile: CharacterProfileState = {
            identity: { name: 'Already Set', race: 'elf', class: 'wizard', level: 5 },
            activeTraits: [{ id: 't1', category: 'party_facts', text: 'owns a horse', subject: 'pc', sceneEstablished: 1 } as any],
        };
        const state = makeState({
            npcLedger: [pc],
            context: { characterProfileActive: true, characterProfile: existingProfile } as unknown as GameContext,
        });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        expect(cb.updateContext).not.toHaveBeenCalled();
    });

    it('preserves an existing identity.name (does not overwrite with the PC name)', () => {
        const pc = makeNPC({ id: 'pc1', name: 'Kael', isPC: true, archetype: 'bulwark' });
        const existingProfile: CharacterProfileState = {
            identity: { name: 'Existing Name', race: 'human' },
            activeTraits: [],
        };
        const state = makeState({
            npcLedger: [pc],
            context: { characterProfileActive: false, characterProfile: existingProfile } as unknown as GameContext,
        });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        const patch = lastPatch(cb);
        expect(patch.characterProfileActive).toBe(true);
        expect(patch.characterProfile.identity.name).toBe('Existing Name'); // preserved
        expect(patch.characterProfile.identity.race).toBe('human'); // preserved
        expect(patch.characterProfile.identity.archetype).toBe('bulwark'); // seeded (was undefined)
    });

    it('preserves existing activeTraits and legacyNotes when seeding identity', () => {
        const pc = makeNPC({ id: 'pc1', name: 'Kael', isPC: true });
        const existingProfile: CharacterProfileState = {
            identity: {},
            activeTraits: [{ id: 't1', category: 'party_facts', text: 'owns a sword', subject: 'pc' } as any],
            legacyNotes: 'old flat string',
        };
        const state = makeState({
            npcLedger: [pc],
            context: { characterProfileActive: false, characterProfile: existingProfile } as unknown as GameContext,
        });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        const patch = lastPatch(cb);
        expect(patch.characterProfile.activeTraits).toHaveLength(1);
        expect(patch.characterProfile.activeTraits[0].text).toBe('owns a sword');
        expect(patch.characterProfile.legacyNotes).toBe('old flat string');
    });

    it('defaults characterProfile when it is undefined on the context', () => {
        const pc = makeNPC({ id: 'pc1', name: 'Kael', isPC: true });
        const state = makeState({
            npcLedger: [pc],
            context: { characterProfileActive: false, characterProfile: undefined } as unknown as GameContext,
        });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        const patch = lastPatch(cb);
        expect(patch.characterProfileActive).toBe(true);
        expect(patch.characterProfile.identity.name).toBe('Kael');
        expect(patch.characterProfile.activeTraits).toEqual([]);
    });

    it('respects characterProfileUserDisabled and does not flip active even with a PC present', () => {
        const pc = makeNPC({ id: 'pc1', name: 'Kael', isPC: true });
        const state = makeState({
            npcLedger: [pc],
            context: {
                characterProfileActive: false,
                characterProfileUserDisabled: true,
                characterProfile: { identity: {}, activeTraits: [] } as CharacterProfileState,
            } as unknown as GameContext,
        });
        const cb = makeCallbacks();

        autoEnableCharacterProfile(state, cb, state.npcLedger);

        expect(cb.updateContext).not.toHaveBeenCalled();
    });
});