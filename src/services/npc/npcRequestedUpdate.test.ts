import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, LLMProvider, NPCEntry } from '../../types';

vi.mock('../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../utils/llmCall';
import {
    requestTerms, rankScenes, gatherUpdateEvidence, parseProposals, buildAcceptedPatch,
    buildRequestedUpdatePrompt, proposeRequestedUpdate, type UpdateEvidence,
} from './npcRequestedUpdate';

const mockLlm = vi.mocked(llmCall);
const provider = { endpoint: 'http://s', modelName: 'deepseek' } as LLMProvider;

const pc = (over: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'pc1', name: 'Makoto', isPC: true, aliases: 'Yuki', appearance: 'Shaggy blue hair over one eye, grey eyes, school uniform',
    faction: 'SEES', storyRelevance: '', disposition: 'calm', status: 'Alive', goals: 'Survive the Dark Hour', voice: 'quiet',
    personality: 'aloof', exampleOutput: '', affinity: 50,
    signatureKit: { equipment: ['Evoker yet to be issued', 'one-handed sword'], abilities: ['Orpheus'] },
    ...over,
} as NPCEntry);

const scenes = [
    { sceneId: '003', content: 'Makoto walks to school. Junpei talks about games.' },
    { sceneId: '010', content: 'Mitsuru hands Makoto a silver Evoker. "Keep it on you at all times."' },
    { sceneId: '014', content: 'At the barber, Makoto gets his hair cut short. The stylist trims the fringe.' },
];
const evidence = (over: Partial<UpdateEvidence> = {}): UpdateEvidence => ({ scenes: [], facts: [], recent: '', found: false, ...over });

describe('evidence search', () => {
    it('extracts meaningful terms', () => {
        expect(requestTerms('I got my hair cut short')).toEqual(['hair', 'cut', 'short']);
        expect(requestTerms('My Persona is Pluto, not Orpheus')).toEqual(['persona', 'pluto', 'orpheus']);
    });

    it('ranks scenes by the request words, merging meaning-based hits', () => {
        expect(rankScenes({ npc: pc(), request: 'haircut short hair', scenes })[0]).toBe('014');
        expect(rankScenes({ npc: pc(), request: 'got issued my evoker', scenes })[0]).toBe('010');
        // A meaning hit surfaces a scene that never uses the words.
        expect(rankScenes({ npc: pc(), request: 'new gun-shaped device', scenes, semanticSceneIds: ['010'] })).toEqual(['010']);
    });

    it('reports when nothing in the history matches', () => {
        const none = gatherUpdateEvidence({ npc: pc(), request: 'My Persona is Pluto', scenes, facts: ['Makoto lives at the dorm'], recentMessages: [] });
        expect(none.found).toBe(false);
        expect(none.scenes).toEqual([]);

        const hit = gatherUpdateEvidence({ npc: pc(), request: 'got my Evoker', scenes, facts: [], recentMessages: [] });
        expect(hit.found).toBe(true);
        expect(hit.scenes.map(s => s.sceneId)).toEqual(['010']);
    });

    it('blank request uses the recent chat only', () => {
        const recent = [{ id: '1', role: 'user', content: 'I put on my coat.' }] as ChatMessage[];
        const ev = gatherUpdateEvidence({ npc: pc(), request: '  ', scenes, facts: ['x'], recentMessages: recent });
        expect(ev).toEqual({ scenes: [], facts: [], recent: '[PLAYER]: I put on my coat.', found: true });
    });

    it('stays inside the scene budget', () => {
        const big = [{ sceneId: '020', content: 'evoker '.repeat(5000) }, ...scenes];
        const ev = gatherUpdateEvidence({ npc: pc(), request: 'evoker', scenes: big, facts: [], recentMessages: [], sceneBudgetChars: 2000 });
        expect(ev.scenes.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(2010);
    });
});

describe('proposals', () => {
    const ev = evidence({ scenes: [scenes[1]], found: true });

    it('keeps valid edits with readable before/after and source labels', () => {
        const out = parseProposals({ changes: [
            { field: 'equipment', value: ['Evoker', 'one-handed sword'], source: 'scene 10' },
            { field: 'abilities', value: ['Pluto'], source: 'request', note: 'record said Orpheus' },
        ] }, pc(), ev);
        expect(out).toEqual([
            expect.objectContaining({ field: 'equipment', before: 'Evoker yet to be issued, one-handed sword', after: 'Evoker, one-handed sword', source: 'scene 010' }),
            expect.objectContaining({ field: 'abilities', before: 'Orpheus', after: 'Pluto', source: 'your request', note: 'record said Orpheus' }),
        ]);
    });

    it('drops unknown/engine-owned fields, bad enums, no-ops and duplicates', () => {
        const out = parseProposals({ changes: [
            { field: 'pcRelation', value: 90 }, { field: 'drives', value: 'x' }, { field: 'affinity', value: 1 },
            { field: 'status', value: 'Sleepy' }, { field: 'condition', value: 'bloodied' },
            { field: 'faction', value: 'SEES' },
            { field: 'status', value: 'missing' }, { field: 'status', value: 'Deceased' },
        ] }, pc(), ev);
        expect(out.map(p => [p.field, p.value])).toEqual([['status', 'Missing']]);
    });

    it('a cited scene that was not in the evidence is labelled as the request', () => {
        const [p] = parseProposals({ changes: [{ field: 'goals', value: 'Protect the dorm', source: 'scene 099' }] }, pc(), ev);
        expect(p.source).toBe('your request');
    });

    it('canon NPCs keep their locked identity fields', () => {
        const canon = pc({ isPC: false, canon: true });
        const out = parseProposals({ changes: [
            { field: 'personality', value: 'cheerful' }, { field: 'appearance', value: 'Short blue hair, grey eyes, school uniform' },
        ] }, canon, ev);
        expect(out.map(p => p.field)).toEqual(['appearance']);
    });

    it('accepted equipment/ability edits merge into the kit; other fields patch directly', () => {
        const out = parseProposals({ changes: [
            { field: 'abilities', value: ['Pluto'] }, { field: 'appearance', value: 'Short blue hair, grey eyes, school uniform' },
        ] }, pc(), ev);
        expect(buildAcceptedPatch(pc(), out)).toEqual({
            appearance: 'Short blue hair, grey eyes, school uniform',
            signatureKit: { equipment: ['Evoker yet to be issued', 'one-handed sword'], abilities: ['Pluto'], element: undefined },
        });
        expect(buildAcceptedPatch(pc(), [])).toEqual({});
    });
});

describe('prompt + call', () => {
    beforeEach(() => mockLlm.mockReset());

    it('with no evidence the player request is the authority', () => {
        const prompt = buildRequestedUpdatePrompt(pc(), 'My Persona is Pluto', evidence());
        expect(prompt).toContain('NO MATCHING EVIDENCE WAS FOUND');
        expect(prompt).toContain('[PLAYER REQUEST]\nMy Persona is Pluto');
        expect(prompt).toContain("PLAYER'S OWN CHARACTER");
        expect(prompt).toContain('Abilities / powers (abilities): Orpheus');
    });

    it('with evidence it cites scenes and still lets the player override', () => {
        const prompt = buildRequestedUpdatePrompt(pc(), 'got my Evoker', evidence({ scenes: [scenes[1]], found: true }));
        expect(prompt).toContain('--- SCENE 010 ---');
        expect(prompt).toContain('follow the PLAYER REQUEST anyway');
    });

    it('Pluto correction end-to-end with no supporting scene', async () => {
        mockLlm.mockResolvedValue(JSON.stringify({
            summary: 'Persona corrected to Pluto.',
            changes: [{ field: 'abilities', value: ['Pluto'], source: 'request', note: 'record said Orpheus' }],
        }));
        const r = await proposeRequestedUpdate(provider, pc(), 'My Persona is Pluto, not Orpheus', evidence());
        expect(r.evidenceFound).toBe(false);
        expect(r.proposals).toHaveLength(1);
        expect(r.proposals[0]).toMatchObject({ field: 'abilities', after: 'Pluto', source: 'your request' });
        expect(mockLlm.mock.calls[0][0]).toBe(provider);
    });

    it('an unusable answer is an error, not a silent no-op', async () => {
        mockLlm.mockResolvedValue('');
        await expect(proposeRequestedUpdate(provider, pc(), 'x', evidence())).rejects.toThrow();
    });
});
