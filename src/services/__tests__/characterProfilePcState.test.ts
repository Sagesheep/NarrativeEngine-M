import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CharacterProfileState, ChatMessage, LLMProvider } from '../../types';

vi.mock('../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../utils/llmCall';
import { scanCharacterProfile, scanCharacterProfileWithPcState } from '../campaign-state/characterProfileParser';

const mockLlm = vi.mocked(llmCall);
const provider = { endpoint: 'http://s', modelName: 'deepseek' } as LLMProvider;
const profile: CharacterProfileState = { identity: { name: 'Makoto', appearance: 'image-look', portraitSeed: 7 }, activeTraits: [] };
const chat = [{ id: '1', role: 'user', content: 'I cut my hair.' }] as ChatMessage[];
const update = { appearance: { changed: true, basis: 'completed_change', evidence: 'I cut my hair.', value: 'short hair' } };

beforeEach(() => mockLlm.mockReset());

describe('profile scan with PC current state', () => {
    it('adds the PC section + slot instructions and returns the raw pcStateUpdate', async () => {
        mockLlm.mockResolvedValue(JSON.stringify({ identity: { name: 'Makoto' }, activeTraits: [], pcStateUpdate: update }));
        const r = await scanCharacterProfileWithPcState(provider, chat, profile, 'Appearance: shaggy hair');
        const prompt = String(mockLlm.mock.calls[0][1]);
        expect(prompt).toContain('=== PLAYER CHARACTER CURRENT STATE ===\nAppearance: shaggy hair');
        expect(prompt).toContain('player_correction');
        expect(prompt).toContain('"pcStateUpdate"');
        expect(r.pcStateUpdate).toEqual(update);
        // identity fields outside the scan's output shape survive the scan
        expect(r.profile.identity).toMatchObject({ appearance: 'image-look', portraitSeed: 7 });
    });

    it('the plain scan prompt carries no PC slots and drops any pcStateUpdate', async () => {
        mockLlm.mockResolvedValue(JSON.stringify({ identity: { name: 'Makoto' }, activeTraits: [], pcStateUpdate: update }));
        const p = await scanCharacterProfile(provider, chat, profile);
        const prompt = String(mockLlm.mock.calls[0][1]);
        expect(prompt).not.toContain('PLAYER CHARACTER CURRENT STATE');
        expect(prompt).not.toContain('pcStateUpdate');
        expect(p).not.toHaveProperty('pcStateUpdate');
    });

    it('garbage output keeps the current profile and proposes nothing', async () => {
        mockLlm.mockResolvedValue('no json here');
        const r = await scanCharacterProfileWithPcState(provider, chat, profile, 'Appearance: x');
        expect(r).toEqual({ profile });
    });
});
