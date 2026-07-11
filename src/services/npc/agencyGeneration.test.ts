import { describe, it, expect, vi, beforeEach } from 'vitest';
import { populateAgencyFields, updateExistingNPCs, bulkNpcUpdate } from './npcGeneration';
import { buildProximityRoster } from './agencyHeartbeat';
import type { NPCEntry, LLMProvider, ChatMessage } from '../../types';

vi.mock('../llm/llmCall', () => ({
    llmCall: vi.fn()
}));

import { llmCall } from '../llm/llmCall';
const mockLlmCall = vi.mocked(llmCall);

describe('agencyGeneration', () => {
    const provider = { endpoint: 'http://mock-llm', modelName: 'mock-model' } as LLMProvider;
    const history: ChatMessage[] = [];

    beforeEach(() => {
        vi.resetAllMocks();
    });

    describe('populateAgencyFields idempotency and preservation', () => {
        it('does not call updateNPCStore if the NPC is already fully populated', async () => {
            const fullyPopulatedNpc = {
                id: 'npc-1',
                name: 'Kael',
                isPC: false,
                populated: true,
                pcRelation: 1,
                wants: {
                    short: ['eat', 'rest', 'read', 'drink'],
                    medium: ['earn wealth', 'find a home', 'protect someone'],
                    long: 'rule the pass'
                },
                personalityHex: { drive: 1, diligence: 1, boldness: 1, warmth: 1, empathy: 1, composure: 1 },
                traits: ['loyal'],
                region: 'Ironwall Pass',
                // WO-04: a fully-populated NPC also carries the Phase-4 sparse-relation seed and rung
                // defaults, so the null-guard sees them as set and the fill is a true no-op.
                relations: {},
                skillRung: 0,
                rungCeiling: 3,
                // Phase-3: a truly-complete NPC also has goalRecords, else the migration seeds them.
                goalRecords: [{ text: 'rule the pass', horizon: 'long', tier: 'default', base_heat: 4, lastAdvancedTick: 0, failStreak: 0, progress: 0, quota: 20, state: 'active' }]
            } as unknown as NPCEntry;

            const updateNPCStore = vi.fn();

            await populateAgencyFields(provider, history, [fullyPopulatedNpc], updateNPCStore, false);

            // Since it is fully populated and no changes are needed, updateNPCStore should not be called
            expect(updateNPCStore).not.toHaveBeenCalled();
            expect(mockLlmCall).not.toHaveBeenCalled();
        });

        it('only sets populated: true if all fields are already populated but populated is false', async () => {
            const npc = {
                id: 'npc-1',
                name: 'Kael',
                isPC: false,
                populated: false, // needs to be marked true
                pcRelation: 1,
                wants: {
                    short: ['eat', 'rest', 'read', 'drink'],
                    medium: ['earn wealth', 'find a home', 'protect someone'],
                    long: 'rule the pass'
                },
                personalityHex: { drive: 1, diligence: 1, boldness: 1, warmth: 1, empathy: 1, composure: 1 },
                traits: ['loyal'],
                region: 'Ironwall Pass',
                // WO-04: carrying the Phase-4 sparse-relation seed + rung defaults so the only
                // remaining change is populated:true (the fill seeds these when absent; here they
                // are present, so the null-guards skip them).
                relations: {},
                skillRung: 0,
                rungCeiling: 3,
                // Already has goalRecords → migration is a no-op, so the only change is populated:true.
                goalRecords: [{ text: 'rule the pass', horizon: 'long', tier: 'default', base_heat: 4, lastAdvancedTick: 0, failStreak: 0, progress: 0, quota: 20, state: 'active' }]
            } as unknown as NPCEntry;

            const updateNPCStore = vi.fn();

            await populateAgencyFields(provider, history, [npc], updateNPCStore, false);

            expect(updateNPCStore).toHaveBeenCalledTimes(1);
            expect(updateNPCStore).toHaveBeenCalledWith('npc-1', { populated: true });
            expect(mockLlmCall).not.toHaveBeenCalled();
        });

        it('seeds wants and pcRelation from affinity and legacy drives, preserving them', async () => {
            const npc = {
                id: 'npc-2',
                name: 'Mira',
                isPC: false,
                populated: false,
                affinity: 70, // should map to +1 pcRelation
                drives: {
                    coreWant: 'To find my brother',
                    sessionWant: 'Get access to library',
                    sceneWant: 'Find a map'
                },
                // personalityHex, traits, region are absent, so it will call LLM
                personalityHex: undefined,
                traits: undefined,
                region: undefined
            } as unknown as NPCEntry;

            const updateNPCStore = vi.fn();

            // Mock LLM response for the missing fields
            mockLlmCall.mockResolvedValue(JSON.stringify({
                npcs: [
                    {
                        name: 'Mira',
                        personalityHex: { drive: 0, diligence: 2, boldness: -1, warmth: 1, empathy: 2, composure: 0 },
                        traits: ['curious', 'generous'],
                        region: 'Academy'
                    }
                ]
            }));

            await populateAgencyFields(provider, history, [npc], updateNPCStore, false);

            expect(updateNPCStore).toHaveBeenCalledTimes(1);

            const callArgs = updateNPCStore.mock.calls[0];
            expect(callArgs[0]).toBe('npc-2');

            const patch = callArgs[1];
            expect(patch.populated).toBe(true);
            expect(patch.pcRelation).toBe(1); // mapped from affinity: 70
            
            // wants should contain legacy drives topped up
            expect(patch.wants).toBeDefined();
            expect(patch.wants.long).toBe('To find my brother');
            expect(patch.wants.short).toContain('Find a map');
            expect(patch.wants.short.length).toBe(4);
            expect(patch.wants.medium).toContain('Get access to library');
            expect(patch.wants.medium.length).toBe(3);

            // LLM-inferred fields should be merged
            expect(patch.personalityHex).toEqual({ drive: 0, diligence: 2, boldness: -1, warmth: 1, empathy: 2, composure: 0 });
            expect(patch.traits).toEqual(['curious', 'generous']);
            expect(patch.region).toBe('Academy');
        });

        it('preserves existing pcRelation and wants, and does not clobber them', async () => {
            const npc = {
                id: 'npc-3',
                name: 'Bram',
                isPC: false,
                populated: false,
                affinity: 10, // would map to -3
                pcRelation: 2, // but already set, so preserve this!
                wants: {
                    short: ['smoke', 'snack'], // less than 4, should top up but preserve these!
                    medium: ['earn wealth'], // less than 3, should top up but preserve this!
                    long: 'protect Bram' // already set, preserve!
                },
                personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 },
                traits: ['loyal'],
                region: 'Keep'
            } as unknown as NPCEntry;

            const updateNPCStore = vi.fn();

            await populateAgencyFields(provider, history, [npc], updateNPCStore, false);

            expect(updateNPCStore).toHaveBeenCalledTimes(1);
            const patch = updateNPCStore.mock.calls[0][1];

            expect(patch.pcRelation).toBeUndefined(); // Should not set/change pcRelation since it was already set
            expect(patch.wants).toBeDefined();
            
            // Existing wants preserved and topped up
            expect(patch.wants.long).toBe('protect Bram');
            expect(patch.wants.short).toContain('smoke');
            expect(patch.wants.short).toContain('snack');
            expect(patch.wants.short.length).toBe(4);
            
            expect(patch.wants.medium).toContain('earn wealth');
            expect(patch.wants.medium.length).toBe(3);
        });
    });

    describe('updateExistingNPCs want-revise merge', () => {
        it('preserves short wants while allowing medium and long wants to be revised by LLM', async () => {
            const npc = {
                id: 'npc-kael',
                name: 'Kael',
                isPC: false,
                wants: {
                    short: ['eat', 'rest', 'read'],
                    medium: ['old medium goal'],
                    long: 'old long goal'
                }
            } as unknown as NPCEntry;

            const updateNPCStore = vi.fn();

            mockLlmCall.mockResolvedValue(JSON.stringify({
                updates: [
                    {
                        name: 'Kael',
                        changes: {
                            wants: {
                                short: ['this new short want should be ignored'],
                                medium: ['revised medium goal 1', 'revised medium goal 2'],
                                long: 'revised long goal'
                            }
                        }
                    }
                ]
            }));

            await updateExistingNPCs(provider, history, [npc], updateNPCStore);

            expect(updateNPCStore).toHaveBeenCalledTimes(1);
            const patch = updateNPCStore.mock.calls[0][1];

            expect(patch.wants).toBeDefined();
            // Short wants are preserved from the original NPC!
            expect(patch.wants.short).toEqual(['eat', 'rest', 'read']);
            // Medium and long wants are updated from the LLM changes
            expect(patch.wants.medium).toEqual(['revised medium goal 1', 'revised medium goal 2']);
            expect(patch.wants.long).toBe('revised long goal');
        });
    });

    describe('Bundle 2 — Piece B fill + roster guard (WO-04) requirements', () => {
        it('defaults seeded: an NPC missing relations, skillRung, rungCeiling gets defaults', async () => {
            const npc = {
                id: 'npc-unpopulated',
                name: 'Kael',
                isPC: false,
                populated: false,
                relations: undefined,
                skillRung: undefined,
                rungCeiling: undefined,
                wants: { short: ['eat', 'rest', 'read', 'drink'], medium: ['earn wealth', 'find a home', 'protect someone'], long: 'rule the pass' },
                personalityHex: { drive: 1, diligence: 1, boldness: 1, warmth: 1, empathy: 1, composure: 1 },
                traits: ['loyal'],
                region: 'Ironwall Pass',
                goalRecords: []
            } as unknown as NPCEntry;

            const updateNPCStore = vi.fn();
            await populateAgencyFields(provider, history, [npc], updateNPCStore, false);

            expect(updateNPCStore).toHaveBeenCalledTimes(1);
            const patch = updateNPCStore.mock.calls[0][1];
            expect(patch.relations).toEqual({});
            expect(patch.skillRung).toBe(0);
            expect(patch.rungCeiling).toBe(3);
        });

        it('never clobbers authored values: an NPC with skillRung:2 keeps 2 after a fill', async () => {
            const npc = {
                id: 'npc-semi-populated',
                name: 'Kael',
                isPC: false,
                populated: false,
                relations: {},
                skillRung: 2, // authored value
                rungCeiling: 3,
                wants: { short: ['eat', 'rest', 'read', 'drink'], medium: ['earn wealth', 'find a home', 'protect someone'], long: 'rule the pass' },
                personalityHex: { drive: 1, diligence: 1, boldness: 1, warmth: 1, empathy: 1, composure: 1 },
                traits: ['loyal'],
                region: 'Ironwall Pass',
                goalRecords: []
            } as unknown as NPCEntry;

            const updateNPCStore = vi.fn();
            await populateAgencyFields(provider, history, [npc], updateNPCStore, false);

            expect(updateNPCStore).toHaveBeenCalledTimes(1);
            const patch = updateNPCStore.mock.calls[0][1];
            expect(patch.skillRung).toBeUndefined(); // should not be written to patch because it already exists
        });

        it('roster guard: buildProximityRoster excludes an NPC with populated:false; includes once populated:true', () => {
            const pc = { id: 'pc', isPC: true, region: 'Ironwall Pass' } as unknown as NPCEntry;
            const npcNotPopulated = {
                id: 'npc-not-populated',
                isPC: false,
                populated: false,
                region: 'Ironwall Pass',
                condition: 'healthy'
            } as unknown as NPCEntry;

            const npcPopulated = {
                id: 'npc-populated',
                isPC: false,
                populated: true,
                region: 'Ironwall Pass',
                condition: 'healthy'
            } as unknown as NPCEntry;

            // When unpopulated: buildProximityRoster should exclude it
            const roster1 = buildProximityRoster([npcNotPopulated], pc);
            expect(roster1.map(n => n.id)).not.toContain('npc-not-populated');

            // When populated: buildProximityRoster should include it
            const roster2 = buildProximityRoster([npcPopulated], pc);
            expect(roster2.map(n => n.id)).toContain('npc-populated');
        });

        it('bulkNpcUpdate parity: bulkNpcUpdate({needsGeneration:true}) produces same store calls as populateAgencyFields', async () => {
            const npc = {
                id: 'npc-unpopulated',
                name: 'Kael',
                isPC: false,
                populated: false,
                wants: { short: ['eat', 'rest', 'read', 'drink'], medium: ['earn wealth', 'find a home', 'protect someone'], long: 'rule the pass' },
                personalityHex: { drive: 1, diligence: 1, boldness: 1, warmth: 1, empathy: 1, composure: 1 },
                traits: ['loyal'],
                region: 'Ironwall Pass',
                goalRecords: []
            } as unknown as NPCEntry;

            const updateNPCStoreDirect = vi.fn();
            const updateNPCStoreBulk = vi.fn();

            await populateAgencyFields(provider, history, [npc], updateNPCStoreDirect, false);
            await bulkNpcUpdate(provider, history, [npc], updateNPCStoreBulk, { needsGeneration: true });

            expect(updateNPCStoreBulk).toHaveBeenCalledTimes(1);
            expect(updateNPCStoreBulk.mock.calls[0]).toEqual(updateNPCStoreDirect.mock.calls[0]);
        });
    });
});
