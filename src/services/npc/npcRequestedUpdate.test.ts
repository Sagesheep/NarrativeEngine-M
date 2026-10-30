import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, LLMProvider, NPCEntry } from '../../types';

vi.mock('../../utils/llmCall', () => ({ llmCall: vi.fn() }));
import { llmCall } from '../../utils/llmCall';
import {
    requestTerms, rankScenes, gatherUpdateEvidence, parseProposals, buildAcceptedPatch,
    buildRequestedUpdatePrompt, proposeRequestedUpdate, type UpdateEvidence,
    gatherCanonLore, buildCanonUpdatePrompt, proposeCanonUpdate, pickDivergence,
} from './npcRequestedUpdate';
import type { LoreChunk } from '../../types';

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

    it('covers aliases, inventory, region, element and wants', () => {
        const npc = pc({ inventory: ['bandage'], wants: { short: ['eat'], medium: ['make a friend'], long: 'Survive' } });
        const out = parseProposals({ changes: [
            { field: 'aliases', value: 'Yuki, Leader' }, { field: 'inventory', value: ['bandage', 'Evoker'] },
            { field: 'region', value: 'Tartarus' }, { field: 'element', value: 'almighty' },
            { field: 'longWant', value: 'End the Dark Hour' },
        ] }, npc, ev);
        expect(out.map(p => p.field)).toEqual(['aliases', 'inventory', 'region', 'element', 'longWant']);
        expect(buildAcceptedPatch(npc, out)).toEqual({
            aliases: 'Yuki, Leader', inventory: ['bandage', 'Evoker'], region: 'Tartarus',
            signatureKit: { equipment: ['Evoker yet to be issued', 'one-handed sword'], abilities: ['Orpheus'], element: 'almighty' },
            wants: { short: ['eat'], medium: ['make a friend'], long: 'End the Dark Hour' },
        });
    });

    it('traits stay inside the vocabulary and never wipe on a bad answer', () => {
        const [p] = parseProposals({ changes: [{ field: 'traits', value: ['Loyal', 'sparkly', 'loyal', 'proud'] }] }, pc(), ev);
        expect(p.value).toEqual(['loyal', 'proud']);
        expect(parseProposals({ changes: [{ field: 'traits', value: ['sparkly'] }] }, pc({ traits: ['loyal'] }), ev)).toEqual([]);
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

    const aki = (over: Partial<NPCEntry> = {}) => pc({
        id: 'n2', name: 'Akihiko Sanada', isPC: false, canon: true, aliases: 'Akihiko', personality: '', status: 'Alive at the opening',
        faction: 'SEES', goals: '', signatureKit: { equipment: ['fist weapons', 'Evoker'], abilities: ['Polydeuces'] },
        personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 },
        canonHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 },
        skillRung: 4, inventory: ['protein bar'], ...over,
    });

    it('complete from canon: fills the full engine record, lifts the canon lock, spares set play state', async () => {
        mockLlm.mockResolvedValue(JSON.stringify({ summary: 'Completed from canon.', changes: [
            { field: 'personality', value: 'Competitive, driven to grow stronger', source: 'canon' },
            { field: 'personalityHex', value: { drive: 3, diligence: 2, boldness: 2, warmth: 0, empathy: 1, composure: 0 }, source: 'canon' },
            { field: 'behavioralTriggers', value: [{ keyword: 'Miki', shift: 'goes quiet, then trains harder' }, { keyword: 'Shinjiro', shift: 'pushes too hard' }], source: 'lore' },
            { field: 'coreWant', value: 'Never be powerless again', source: 'lore' },
            { field: 'combatTier', value: 'Elite' },
            { field: 'rungCeiling', value: 'veteran' },
            { field: 'goals', value: 'Grow stronger', source: 'lore' },   // empty → filled
            { field: 'faction', value: 'Shadow Operatives' },             // already set → kept
            { field: 'inventory', value: ['gloves'] },                    // never canon's business
        ] }));
        const npc = aki();
        const r = await proposeCanonUpdate(provider, npc, '', { entry: '### CHARACTER -- Akihiko Sanada', setting: '' });
        expect(r.proposals.map(p => p.field)).toEqual(['personality', 'personalityHex', 'behavioralTriggers', 'coreWant', 'combatTier', 'rungCeiling', 'goals']);
        expect(r.warning).toBeUndefined();

        const patch = buildAcceptedPatch(npc, r.proposals);
        expect(patch).toMatchObject({
            personality: 'Competitive, driven to grow stronger',
            personalityHex: { drive: 3, diligence: 2, boldness: 2, warmth: 0, empathy: 1, composure: 0 },
            canonHex: { drive: 3, diligence: 2, boldness: 2, warmth: 0, empathy: 1, composure: 0 },
            behavioralTriggers: [{ keyword: 'Miki', shift: 'goes quiet, then trains harder' }, { keyword: 'Shinjiro', shift: 'pushes too hard' }],
            drives: { coreWant: 'Never be powerless again', sessionWant: '', sceneWant: '' },
            combatTier: 'elite', rungCeiling: 3, skillRung: 3, goals: 'Grow stronger',
        });
    });

    it('complete from canon: campaign divergence outranks canon', async () => {
        const entries = ['Junpei joined early [#3]', 'Shinjiro survived October 4 [#40]', 'Akihiko quit boxing [#12]', 'Fuuka left SEES [#41]'];
        const div = pickDivergence({ name: 'Akihiko Sanada', aliases: 'Akihiko' }, entries);
        // Entries naming him lead, then the newest of the rest.
        expect(div).toEqual(['Akihiko quit boxing [#12]', 'Fuuka left SEES [#41]', 'Shinjiro survived October 4 [#40]', 'Junpei joined early [#3]']);

        const prompt = buildCanonUpdatePrompt(aki(), '', { entry: 'Shinjiro dies on Oct 4.', setting: '', divergence: div });
        expect(prompt).toContain('[CAMPAIGN DIVERGENCE — overrides canon]\n- Akihiko quit boxing [#12]');
        expect(prompt.indexOf('CAMPAIGN DIVERGENCE')).toBeLessThan(prompt.indexOf('[LORE]'));
        expect(prompt).toContain('the record follows the campaign');

        mockLlm.mockResolvedValue(JSON.stringify({ changes: [{ field: 'storyRelevance', value: 'Shinjiro lived; ...', source: 'campaign' }] }));
        const r = await proposeCanonUpdate(provider, aki(), '', { entry: 'x', setting: '', divergence: div });
        expect(r.proposals[0].source).toBe('campaign');
    });

    it('complete from canon: with no lore it warns that the model is working from memory', async () => {
        mockLlm.mockResolvedValue(JSON.stringify({ changes: [{ field: 'voice', value: 'Blunt, eager', source: 'canon' }] }));
        const r = await proposeCanonUpdate(provider, aki(), '', { entry: '', setting: '' });
        expect(r.proposals[0]).toMatchObject({ field: 'voice', source: 'source material' });
        expect(r.warning).toBeTruthy();
    });

    it('complete from canon: gathers the character entry plus every profile chunk about them', () => {
        const chunk = (over: Partial<LoreChunk>): LoreChunk => ({
            id: 'c', header: '', content: '', tokens: 0, alwaysInclude: false, triggerKeywords: [], scanDepth: 3,
            category: 'character', linkedEntities: [], priority: 5, ...over,
        } as LoreChunk);
        const chunks = [
            chunk({ header: '### CHARACTER -- Mitsuru Kirijo', content: '**Aliases:** Mitsuru.\nIce queen.' }),
            chunk({ header: '### CHARACTER -- Akihiko Sanada', content: '**Aliases:** Akihiko.\n**Element:** electricity' }),
            chunk({ header: '### [CHUNK: OVERVIEW -- Profile Akihiko Sanada]', content: 'Couldn\'t save his sister Miki.', category: 'world_overview', triggerKeywords: ['Akihiko', 'Sanada'] }),
            chunk({ header: '## World', content: 'Persona 3: the Dark Hour.', category: 'world_overview', alwaysInclude: true }),
        ];
        const lore = gatherCanonLore({ name: 'Akihiko Sanada', aliases: 'Akihiko' }, chunks);
        expect(lore.entry).toContain('electricity');
        expect(lore.entry).toContain('sister Miki');
        expect(lore.entry).not.toContain('Ice queen');
        expect(lore.entry.indexOf('electricity')).toBeLessThan(lore.entry.indexOf('Miki'));
        expect(lore.setting).toContain('Dark Hour');

        const prompt = buildCanonUpdatePrompt(aki(), '', lore);
        expect(prompt).toContain('[LORE]\n### CHARACTER -- Akihiko Sanada');
        expect(prompt).toContain('Personality axes (personalityHex): drive 0');
        expect(prompt).not.toContain('Inventory (inventory)');
    });

    it('an unusable answer is an error, not a silent no-op', async () => {
        mockLlm.mockResolvedValue('');
        await expect(proposeRequestedUpdate(provider, pc(), 'x', evidence())).rejects.toThrow();
    });
});
