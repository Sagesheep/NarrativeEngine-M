import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NPCEntry, LLMProvider, ChatMessage, PersonalityHex } from '../../types';
import { generateNPCProfile } from './npcGeneration';

vi.mock('../llm/llmCall', () => ({
    llmCall: vi.fn()
}));

import { llmCall } from '../llm/llmCall';
const mockLlmCall = vi.mocked(llmCall);

// ── Seeded RNG (mulberry32) — same helper as hexRoll.test.ts. Deterministic across runs.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const AXES: readonly (keyof PersonalityHex)[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

/**
 * Drive the mock llmCall so the FIRST call of a generation (the PROPOSE call) returns a fixed
 * candidate pool + anchor traits, and the SECOND call (the RENDER call) returns a minimal
 * profile. `callIndex` is tracked across the whole test so multiple NPCs each consume a
 * propose+render pair.
 */
function mockProposeThenRender(proposalJson: string, renderJson: string) {
    let callIndex = 0;
    mockLlmCall.mockImplementation(async () => {
        callIndex++;
        // Odd call = propose; even call = render.
        return callIndex % 2 === 1 ? proposalJson : renderJson;
    });
}

describe('generateNPCProfile — Phase-1 refit (propose → roll → render)', () => {
    const provider = { endpoint: 'http://mock-llm', modelName: 'mock-model' } as LLMProvider;
    const history: ChatMessage[] = [
        { id: '1', role: 'user', content: 'Three street kids loiter by the alley.', timestamp: 0 },
    ];

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('3 NPCs from the same candidate pool yield 3 measurably different hexes (headline acceptance)', async () => {
        // Same "street kid" scene + same candidate pool for all three. The ONLY thing that varies
        // is the seeded rng draw per NPC — which is exactly what should produce variety. The model
        // propose + render calls are mocked to identical payloads so any variance must come from
        // the engine roll, not the model.
        const proposal = JSON.stringify({
            candidateGroups: ['scholar', 'brute', 'fool'],
            anchorTraits: ['curious'],
        });
        // The render model emits a bogus personalityHex + traits — these MUST be ignored on the
        // new path (hex from ROLL, traits from anchors + engine draw).
        const render = JSON.stringify({
            name: 'Street Kid',
            aliases: '',
            status: 'Alive',
            faction: 'Street',
            storyRelevance: 'A street kid',
            disposition: 'Wary',
            goals: 'Survive',
            voice: 'clipped',
            appearance: '[inferred] thin, scuffed shoes',
            personality: 'guarded',
            exampleOutput: '"...what do you want?"',
            longWant: 'get off the street',
            region: 'the alley',
            // BOGUS model-emitted personality numbers — must be DISCARDED by the new path:
            personalityHex: { drive: 3, diligence: 3, boldness: 3, warmth: 3, empathy: 3, composure: 3 },
            traits: ['sadistic', 'bloodthirsty'], // also bogus (and mature-gated) — must be discarded
        });

        const rng = mulberry32(2026);
        const created: NPCEntry[] = [];
        const addNpc = (npc: NPCEntry) => created.push(npc);

        for (let i = 0; i < 3; i++) {
            // Each NPC gets its own propose→render pair, but the mocked payloads are identical.
            mockProposeThenRender(proposal, render);
            await generateNPCProfile(provider, history, `kid-${i}`, addNpc, [], 'camp', false, rng);
        }

        expect(created.length).toBe(3);

        // 1) Headline: 3 measurably different hexes (variance, not copy-paste).
        const sigs = created.map(n => AXES.map(a => n.personalityHex![a]).join(','));
        const unique = new Set(sigs);
        expect(unique.size, 'three NPCs from one pool must produce >1 distinct hex').toBeGreaterThan(1);

        // 2) No NPC hex comes from model output. The model emitted all-+3; if any axis equals +3
        //    it could be a coincidence, so instead assert the hex is NOT the model's emitted object
        //    AND that it matches an engine roll signature. Strongest assertion: at least one NPC's
        //    hex differs from the model's all-+3 on at least 3 axes (the model output is fully
        //    discarded — the rolled hex is what's stored).
        for (const npc of created) {
            const modelHex: PersonalityHex = { drive: 3, diligence: 3, boldness: 3, warmth: 3, empathy: 3, composure: 3 };
            const diffs = AXES.filter(a => npc.personalityHex![a] !== modelHex[a]).length;
            expect(diffs, 'rolled hex must not equal the model-emitted all-+3 hex').toBeGreaterThan(0);
        }
        // And at least one of the three differs from all-+3 on >= 3 axes (proves the model output
        // is wholesale discarded, not merged).
        const maxDiffs = Math.max(...created.map(n => AXES.filter(a => n.personalityHex![a] !== 3).length));
        expect(maxDiffs).toBeGreaterThanOrEqual(3);
    });

    it('hex comes from the ROLL: matches rollHex(primary, secondary, anchors, same seed) exactly', async () => {
        // Pin the rng seed and assert the stored hex equals what rollHex produces directly with
        // the same primary/secondary/anchors — i.e. the stored hex is engine-rolled, not model-
        // emitted. We import rollHex + pickGroups to recompute the expected skeleton.
        const { rollHex, pickGroups } = await import('./hexRoll');
        const { GROUP_KEYS } = await import('./dispositionGroups');

        const proposal = JSON.stringify({
            candidateGroups: ['scholar', 'brute', 'fool'],
            anchorTraits: ['curious'],
        });
        const render = JSON.stringify({
            name: 'Kid', status: 'Alive', faction: 'Street', disposition: 'Wary', goals: 'Survive',
            voice: 'clipped', appearance: '', personality: 'guarded', exampleOutput: '"..."',
            longWant: 'get off the street', region: 'alley',
            personalityHex: { drive: -3, diligence: -3, boldness: -3, warmth: -3, empathy: -3, composure: -3 },
            traits: ['depraved'],
        });

        const seed = 4242;
        const rng = mulberry32(seed);
        // Pre-compute the engine skeleton with the SAME rng sequence the generation will consume.
        // The generation's first rng draws are: pickGroups (2 draws) then rollHex (6 draws) then
        // drawConsistentTraits + rollLooksTier. So we replay that exact sequence here.
        const expected = pickGroups(['scholar', 'brute', 'fool'], rng);
        const expectedHex = rollHex(expected.primary, expected.secondary, ['curious'], rng);

        // Reset the rng to the same seed so generateNPCProfile consumes the identical sequence.
        const rng2 = mulberry32(seed);
        mockProposeThenRender(proposal, render);
        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, history, 'Kid', n => created.push(n), [], 'camp', false, rng2);

        expect(created[0].personalityHex).toEqual(expectedHex);
        expect(created[0].primaryGroup).toBe(expected.primary);
        expect(created[0].secondaryGroup).toBe(expected.secondary);
        // Sanity: primary is a known GROUP_KEY, secondary (if set) is too and !== primary.
        expect((GROUP_KEYS as readonly string[]).includes(created[0].primaryGroup!)).toBe(true);
        if (created[0].secondaryGroup !== undefined) {
            expect(created[0].secondaryGroup).not.toBe(created[0].primaryGroup);
            expect((GROUP_KEYS as readonly string[]).includes(created[0].secondaryGroup)).toBe(true);
        }
    });

    it('no personalityHex / numeric axes asked of the render model (prompt hygiene)', async () => {
        // Capture the render prompt (the 2nd llmCall) and assert it does NOT contain the legacy
        // all-zeros hex example nor the HEX_AXIS_LEGEND "rate each as an INTEGER from -3 to +3"
        // instruction. The model must not be invited to emit hex.
        const proposal = JSON.stringify({ candidateGroups: ['scholar'], anchorTraits: [] });
        const render = JSON.stringify({ name: 'Kid', status: 'Alive', faction: 'X', disposition: 'Wary', goals: 'g', voice: 'v', appearance: '', personality: 'p', exampleOutput: '"..."', longWant: 'l', region: '' });

        mockProposeThenRender(proposal, render);
        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, history, 'Kid', n => created.push(n), [], 'camp', false, mulberry32(1));

        const renderCallArg = mockLlmCall.mock.calls[1][1] as string;
        // The legacy all-zeros hex schema example must be gone (it invited the model to emit hex):
        expect(renderCallArg).not.toContain('"personalityHex": {"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0}');
        expect(renderCallArg).not.toContain('"personalityHex": {"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0}');
        // The axis legend ("rate each as an INTEGER from -3 to +3") must be gone from the generation prompt:
        expect(renderCallArg).not.toContain('rate each as an INTEGER from -3 to +3');
        // And the prompt must explicitly forbid the model from emitting hex:
        expect(renderCallArg).toContain('Do NOT emit a "personalityHex" field');
    });

    it('safe fallback when the propose call returns garbage: all GROUP_KEYS + no anchors, still generates', async () => {
        // Propose returns unparseable JSON → fallback. Render still runs. NPC is created with a
        // rolled hex + group drawn from all GROUP_KEYS.
        let callIndex = 0;
        mockLlmCall.mockImplementation(async () => {
            callIndex++;
            return callIndex === 1 ? 'not json at all' : JSON.stringify({ name: 'Kid', status: 'Alive', faction: 'X', disposition: 'Wary', goals: 'g', voice: 'v', appearance: '', personality: 'p', exampleOutput: '"..."', longWant: 'l', region: '' });
        });

        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, history, 'Kid', n => created.push(n), [], 'camp', false, mulberry32(7));

        expect(created.length).toBe(1);
        expect(created[0].personalityHex).toBeDefined();
        expect(created[0].primaryGroup).toBeDefined();
        for (const axis of AXES) {
            expect(created[0].personalityHex![axis]).toBeGreaterThanOrEqual(-3);
            expect(created[0].personalityHex![axis]).toBeLessThanOrEqual(3);
        }
    });

    it('existing saves load unchanged: NPCEntry without primaryGroup/secondaryGroup is valid', async () => {
        // Non-breaking contract: an NPC entry constructed WITHOUT the new fields must typecheck
        // and behave as before. This is a compile-time + runtime guarantee; we exercise it by
        // constructing a legacy-shape entry and reading the new fields as undefined.
        const legacy: NPCEntry = {
            id: 'old-1', name: 'Old NPC', aliases: '', appearance: '', faction: 'X',
            storyRelevance: '', disposition: 'Neutral', status: 'Alive', goals: '', voice: '',
            personality: '', exampleOutput: '', affinity: 50,
            personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 },
        };
        expect(legacy.primaryGroup).toBeUndefined();
        expect(legacy.secondaryGroup).toBeUndefined();
        // And a save containing only legacy fields round-trips with no migration required.
        const json = JSON.stringify(legacy);
        const parsed = JSON.parse(json) as NPCEntry;
        expect(parsed.personalityHex).toEqual({ drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 });
        expect(parsed.primaryGroup).toBeUndefined();
    });
});