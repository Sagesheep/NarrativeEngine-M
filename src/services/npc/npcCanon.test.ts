import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NPCEntry, LLMProvider, PersonalityHex, Goal, LoreChunk } from '../../types';
import { anchorCanonHex, stripCanonLockedFields, markCanonFromLore, mergeLoreNPCs, findLoreMatch } from './npcCanon';
import { applyGoalOutcomeNudge } from './agencyDrift';
import { updateExistingNPCs, generateNPCProfile } from './npcGeneration';
import { parseNPCsFromLore } from '../lore/loreNPCParser';
import { assembleWorldBlocks } from '../payload/payloadWorldContext';

vi.mock('../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../utils/llmCall';
const mockLlmCall = vi.mocked(llmCall);

const provider = { endpoint: 'http://mock-llm', modelName: 'mock-model' } as LLMProvider;

const hex = (h: Partial<PersonalityHex> = {}): PersonalityHex =>
    ({ drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0, ...h });

function npc(over: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'n1', name: 'Naruto Uzumaki', aliases: '', appearance: '', faction: '', storyRelevance: '',
        disposition: '', status: 'Alive', goals: '', voice: '', personality: '', exampleOutput: '', affinity: 50,
        ...over,
    };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('anchorCanonHex', () => {
    it('keeps every axis within ±1 of the canon baseline', () => {
        const n = npc({ canon: true, canonHex: hex({ boldness: 3, composure: -1 }) });
        expect(anchorCanonHex(n, hex({ boldness: 0, composure: -3, warmth: 2 })))
            .toEqual(hex({ boldness: 2, composure: -2, warmth: 1 }));
    });

    it('passes through for non-canon NPCs and canon NPCs without a baseline', () => {
        const drifted = hex({ boldness: -3 });
        expect(anchorCanonHex(npc({ canonHex: hex({ boldness: 3 }) }), drifted)).toEqual(drifted);
        expect(anchorCanonHex(npc({ canon: true }), drifted)).toEqual(drifted);
    });
});

describe('stripCanonLockedFields', () => {
    it('drops identity fields for canon NPCs only', () => {
        const changes: Partial<NPCEntry> = { personality: 'cold', voice: 'flat', traits: ['cruel'], status: 'Missing', region: 'suna' };
        expect(stripCanonLockedFields(npc({ canon: true }), changes)).toEqual({ status: 'Missing', region: 'suna' });
        expect(stripCanonLockedFields(npc({ canon: false }), changes)).toEqual(changes);
    });
});

describe('applyGoalOutcomeNudge on a canon NPC', () => {
    const goal = { text: 'win', horizon: 'medium', state: 'active', failStreak: 3 } as unknown as Goal;

    it('does not push composure past the canon anchor', () => {
        const n = npc({ canon: true, canonHex: hex({ composure: 1 }), personalityHex: hex({ composure: 0 }) });
        const r = applyGoalOutcomeNudge(n, goal, 'critFail');
        expect(r.hexPatch).toBeUndefined();
        expect(r.shiftLine).toBe('');
    });

    it('still nudges within the slack', () => {
        const n = npc({ canon: true, canonHex: hex({ composure: 1 }), personalityHex: hex({ composure: 1 }) });
        expect(applyGoalOutcomeNudge(n, goal, 'critFail').hexPatch?.composure).toBe(0);
    });
});

describe('lore matching, migration and re-import', () => {
    const lore = [npc({ id: 'lore-1', name: 'Kakashi Hatake', aliases: 'Copy Ninja', canon: true, personality: 'lazy genius', personalityHex: hex({ composure: 3 }) })];

    it('matches by name or alias, case-insensitively', () => {
        expect(findLoreMatch(npc({ name: 'copy ninja' }), lore)).toBe(lore[0]);
        expect(findLoreMatch(npc({ name: 'Sasuke' }), lore)).toBeUndefined();
    });

    it('migration tags matching entries and backfills the baseline from lore', () => {
        const ledger = [npc({ id: 'a', name: 'Kakashi Hatake', personalityHex: hex({ composure: 1 }) }), npc({ id: 'b', name: 'Rando' })];
        const out = markCanonFromLore(ledger, lore);
        expect(out[0].canon).toBe(true);
        expect(out[0].canonHex).toEqual(hex({ composure: 3 }));
        expect(out[1].canon).toBeUndefined();
    });

    it('migration never overrides the player opt-out, and is a no-op when nothing changes', () => {
        const ledger = [npc({ name: 'Kakashi Hatake', canon: false })];
        expect(markCanonFromLore(ledger, lore)).toBe(ledger);
    });

    it('migration backfills a missing baseline on an already-canon entry', () => {
        const out = markCanonFromLore([npc({ canon: true, personalityHex: hex({ drive: 2 }) })], []);
        expect(out[0].canonHex).toEqual(hex({ drive: 2 }));
    });

    it('re-import refreshes identity but keeps id and play state', () => {
        const played = npc({
            id: 'played', name: 'Kakashi Hatake', personality: 'drifted', pcRelation: 2, relationMeter: 40,
            region: 'land of waves', status: 'Wounded', skillRung: 3, wants: { short: ['read'], medium: [], long: 'x' },
        });
        const fresh = npc({ id: 'new', name: 'Gai' });
        const out = mergeLoreNPCs([played], [...lore, fresh]);
        expect(out).toHaveLength(2);
        const k = out[0];
        expect(k.id).toBe('played');
        expect(k.personality).toBe('lazy genius');
        expect(k.personalityHex).toEqual(hex({ composure: 3 }));
        expect(k.canon).toBe(true);
        expect(k.canonHex).toEqual(hex({ composure: 3 }));
        expect(k).toMatchObject({ pcRelation: 2, relationMeter: 40, region: 'land of waves', status: 'Wounded', skillRung: 3 });
        expect(k.wants?.short).toEqual(['read']);
        expect(out[1].id).toBe('new');
    });

    it('re-import keeps a player opt-out', () => {
        const out = mergeLoreNPCs([npc({ name: 'Kakashi Hatake', canon: false })], lore);
        expect(out[0].canon).toBe(false);
    });
});

describe('parseNPCsFromLore', () => {
    it('marks every lore character canon with the authored hex as baseline', () => {
        const chunks = [{
            id: 'c1', header: 'Naruto Uzumaki', category: 'character',
            content: '**Personality:** loud\n**PersonalityHex:** drive:+3, boldness:+2',
        }] as unknown as LoreChunk[];
        const [n] = parseNPCsFromLore(chunks);
        expect(n.canon).toBe(true);
        expect(n.canonHex).toEqual(hex({ drive: 3, boldness: 2 }));
    });
});

describe('updateExistingNPCs on a canon NPC', () => {
    it('ignores identity rewrites, anchors hex drift, and flags CANON in the prompt', async () => {
        const target = npc({
            name: 'Kakashi', canon: true, personality: 'lazy genius', voice: 'drawl',
            personalityHex: hex({ composure: 3 }), canonHex: hex({ composure: 3 }),
        });
        mockLlmCall.mockResolvedValue(JSON.stringify({
            updates: [{ name: 'Kakashi', changes: { personality: 'hothead', voice: 'shouty', status: 'Missing', personalityHex: { composure: -1 } } }],
            tones: [],
        }));
        const update = vi.fn();
        await updateExistingNPCs(provider, [], [target], update);

        expect(String(mockLlmCall.mock.calls[0][1])).toContain('[NPC: Kakashi] (CANON');
        const patch = update.mock.calls[0][1] as Partial<NPCEntry>;
        expect(patch.personality).toBeUndefined();
        expect(patch.voice).toBeUndefined();
        expect(patch.status).toBe('Missing');
        expect(patch.personalityHex?.composure).toBe(2);
    });
});

describe('generateNPCProfile canon check', () => {
    const render = JSON.stringify({ name: 'Kakashi Hatake', disposition: 'calm' });

    it('uses the source hex and tags canon when the model recognises the character', async () => {
        const sourceHex = hex({ composure: 3, diligence: -2 });
        let call = 0;
        mockLlmCall.mockImplementation(async () => (++call === 1
            ? JSON.stringify({ canon: true, personalityHex: sourceHex, candidateGroups: ['scholar'], anchorTraits: [] })
            : render));
        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, [], 'Kakashi', n => created.push(n), []);

        expect(String(mockLlmCall.mock.calls[0][1])).toContain('NPC NAME: "Kakashi"');
        expect(String(mockLlmCall.mock.calls[1][1])).toContain('CANON CHARACTER');
        expect(created[0].canon).toBe(true);
        expect(created[0].personalityHex).toEqual(sourceHex);
        expect(created[0].canonHex).toEqual(sourceHex);
    });

    it('leaves original characters untagged', async () => {
        let call = 0;
        mockLlmCall.mockImplementation(async () => (++call === 1
            ? JSON.stringify({ canon: false, candidateGroups: ['scholar'], anchorTraits: [] })
            : render));
        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, [], 'Bob', n => created.push(n), []);
        expect(created[0].canon).toBeUndefined();
        expect(String(mockLlmCall.mock.calls[1][1])).not.toContain('CANON CHARACTER');
    });
});

describe('PLAY AS line', () => {
    it('carries the canon marker only for canon NPCs', () => {
        const build = (n: NPCEntry) => JSON.stringify(assembleWorldBlocks({
            context: {} as never, npcLedger: [n], onStageNpcIds: [n.id], userMessage: 'Naruto Uzumaki waves', history: [], addTrace: () => {},
        }));
        expect(build(npc({ canon: true, personalityHex: hex() }))).toContain('PLAY AS: CANON — stay true to source');
        expect(build(npc({ personalityHex: hex() }))).not.toContain('CANON');
    });
});
