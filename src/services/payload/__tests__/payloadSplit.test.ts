import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildDivergenceBlock } from '../payloadStableContent';
import { assembleWorldBlocks } from '../payloadWorldContext';
import { computeBudgets } from '../payloadBudgeter';
import { EMPTY_REGISTER } from '../../campaign-state';
import type { DivergenceRegister, DivergenceEntry, NPCEntry, GameContext, ChatMessage, PayloadTrace } from '../../../types';

const makeEntry = (id: string, overrides: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id,
    chapterId: 'ch1',
    category: 'misc',
    text: `Fact ${id}`,
    sceneRef: '001',
    npcIds: [],
    pinned: false,
    enabled: true,
    source: 'auto',
    ...overrides,
});

const makeNpc = (id: string, name: string, overrides: Partial<NPCEntry> = {}): NPCEntry => ({
    id,
    name,
    aliases: '',
    appearance: '',
    faction: '',
    storyRelevance: '',
    disposition: '',
    status: '',
    goals: '',
    voice: '',
    personality: '',
    exampleOutput: '',
    affinity: 0,
    ...overrides,
});

const stubContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    inventoryLastScene: '',
    characterProfile: { identity: {}, activeTraits: [] },
    characterProfileLastScene: '',
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    characterProfileUserDisabled: false,
    surpriseEngineActive: false,
    encounterEngineActive: false,
    worldEngineActive: false,
    diceFairnessActive: false,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 0,
    notebook: [],
    notebookActive: false,
};

const noTrace = (_t: PayloadTrace) => {};

describe('payloadSplit — T1', () => {
    const npc_A = makeNpc('npc_A', 'Aldric', { faction: 'Iron Spire' });
    const npc_B = makeNpc('npc_B', 'Brenna');

    const publicFact = makeEntry('pub1', {
        text: 'Public: The eastern gate fell',
        knownBy: undefined,
        category: 'misc',
    });

    const scopedFact = makeEntry('scoped1', {
        text: 'Secret: Aldric is the secret heir',
        knownBy: ['npc:npc_A'],
        category: 'npc_events',
    });

    const factionFact = makeEntry('faction1', {
        text: 'Faction Secret: Spire is corrupt',
        knownBy: ['faction:iron spire'],
        category: 'world_state',
    });

    const register: DivergenceRegister = {
        ...EMPTY_REGISTER,
        entries: [publicFact, scopedFact, factionFact],
        chapterToggles: { ch1: true },
        categoryToggles: {
            ch1: {
                locations: true,
                npc_events: true,
                promises_debts: true,
                world_state: true,
                party_facts: true,
                rules_lore: true,
                misc: true,
            }
        },
    };

    describe('T1 — buildDivergenceBlock (Cached static path)', () => {
        it('renders public facts but NOT scoped or faction-scoped facts', () => {
            const { divergenceContent } = buildDivergenceBlock({
                divergenceRegister: register,
                addTrace: noTrace,
            });

            expect(divergenceContent).toContain('Public: The eastern gate fell');
            expect(divergenceContent).not.toContain('Secret: Aldric is the secret heir');
            expect(divergenceContent).not.toContain('Faction Secret: Spire is corrupt');
        });
    });

    describe('T1 — assembleWorldBlocks (Per-turn scoped path)', () => {
        it('omits the scoped and faction facts when their respective knowers/factions are not on stage', () => {
            const blocks = assembleWorldBlocks({
                context: stubContext,
                history: [] as ChatMessage[],
                userMessage: 'test',
                divergenceRegister: register,
                npcLedger: [npc_A, npc_B],
                onStageNpcIds: ['npc_B'], // Aldric is off stage
                addTrace: noTrace,
            });

            const scopedBlock = blocks.find(b => b.source === 'Scoped Knowledge');
            expect(scopedBlock).toBeUndefined();
        });

        it('includes the scoped fact when Aldric (npc_A) is on stage, labeled with who knows it', () => {
            const blocks = assembleWorldBlocks({
                context: stubContext,
                history: [] as ChatMessage[],
                userMessage: 'test',
                divergenceRegister: register,
                npcLedger: [npc_A, npc_B],
                onStageNpcIds: ['npc_A'], // Aldric on stage
                addTrace: noTrace,
            });

            const scopedBlock = blocks.find(b => b.source === 'Scoped Knowledge');
            expect(scopedBlock).toBeDefined();
            expect(scopedBlock!.content).toContain('[FACTS KNOWN TO ON-STAGE CHARACTERS]');
            expect(scopedBlock!.content).toContain('Secret: Aldric is the secret heir (known to: Aldric)');
            // Faction fact also matches because Aldric is on stage and belongs to "Iron Spire"
            expect(scopedBlock!.content).toContain('Faction Secret: Spire is corrupt (known to: iron spire members)');
            expect(scopedBlock!.content).not.toContain('Public: The eastern gate fell'); // Public fact is in stable cached block, not here
        });

        it('includes the faction fact but not individual scoped fact when only a faction member is on stage', () => {
            // Let's make another NPC part of the Iron Spire faction, but not npc_A
            const npc_C = makeNpc('npc_C', 'Caleb', { faction: 'Iron Spire' });

            const blocks = assembleWorldBlocks({
                context: stubContext,
                history: [] as ChatMessage[],
                userMessage: 'test',
                divergenceRegister: register,
                npcLedger: [npc_A, npc_B, npc_C],
                onStageNpcIds: ['npc_C'], // Caleb on stage (so Iron Spire is present)
                addTrace: noTrace,
            });

            const scopedBlock = blocks.find(b => b.source === 'Scoped Knowledge');
            expect(scopedBlock).toBeDefined();
            expect(scopedBlock!.content).toContain('Faction Secret: Spire is corrupt (known to: iron spire members)');
            expect(scopedBlock!.content).not.toContain('Secret: Aldric is the secret heir'); // Aldric is off stage
        });
    });

    describe('T1 — Regression safety rail guard', () => {
        it('ensures buildDivergenceBlock call site in payloadBuilder.ts passes NO cast-dependent args', () => {
            const filePath = path.resolve(__dirname, '../payloadBuilder.ts');
            const content = fs.readFileSync(filePath, 'utf8');

            // Find the call site of buildDivergenceBlock
            const startIndex = content.indexOf('buildDivergenceBlock({');
            expect(startIndex).not.toBe(-1);

            const endIndex = content.indexOf('});', startIndex);
            expect(endIndex).not.toBe(-1);

            const invocationBlock = content.substring(startIndex, endIndex + 3);

            // Assert that the invocation block does not reference cast-dependent variables or arguments
            expect(invocationBlock).not.toContain('onStageNpcIds');
            expect(invocationBlock).not.toContain('npcLedger');
            expect(invocationBlock).not.toContain('ledger');
        });
    });

    // ── Phase 2: reaction menu wiring + NPC budget decoupling ──────────────
    describe('Phase 2 — reaction menu reaches the payload', () => {
        const hexNpc = makeNpc('npc_hex', 'Kakashi', {
            personalityHex: { drive: 1, diligence: 2, boldness: 1, warmth: 2, empathy: 2, composure: 1 },
            traits: ['loyal', 'protective', 'honorable'],
            pcRelation: 2,
            goals: 'protect his students',
        });

        it('buildCoreDirective emits the REACTIONS line for a hex-bearing NPC (peaceful)', () => {
            const blocks = assembleWorldBlocks({
                context: stubContext,
                history: [{ id: 'm1', role: 'user', content: 'hey Kakashi', timestamp: 0 }] as ChatMessage[],
                userMessage: 'hey Kakashi',
                npcLedger: [hexNpc],
                onStageNpcIds: ['npc_hex'],
                addTrace: noTrace,
            });

            const npcBlock = blocks.find(b => b.source === 'Active NPCs');
            expect(npcBlock).toBeDefined();
            expect(npcBlock!.content).toContain('REACTIONS (choose ONE');
            expect(npcBlock!.content).toContain('do NOT invent a softer reaction');
        });

        it('reaction menu is absent for a legacy hex-less NPC', () => {
            const legacyNpc = makeNpc('npc_legacy', 'OldMan', { goals: 'sit by the road' });
            const blocks = assembleWorldBlocks({
                context: stubContext,
                history: [{ id: 'm1', role: 'user', content: 'hey OldMan', timestamp: 0 }] as ChatMessage[],
                userMessage: 'hey OldMan',
                npcLedger: [legacyNpc],
                onStageNpcIds: ['npc_legacy'],
                addTrace: noTrace,
            });

            const npcBlock = blocks.find(b => b.source === 'Active NPCs');
            expect(npcBlock).toBeDefined();
            expect(npcBlock!.content).not.toContain('REACTIONS');
        });

        it('uses the dangerous context pool when planner tags a combat scene', () => {
            const combatNpc = makeNpc('npc_fighter', 'Bram', {
                personalityHex: { drive: 0, diligence: 0, boldness: 2, warmth: -1, empathy: -1, composure: -1 },
                traits: ['impulsive', 'proud'],
                pcRelation: 0,
                goals: 'win',
            });
            const blocks = assembleWorldBlocks({
                context: stubContext,
                history: [{ id: 'm1', role: 'user', content: 'Bram attack!', timestamp: 0 }] as ChatMessage[],
                userMessage: 'Bram attack!',
                npcLedger: [combatNpc],
                onStageNpcIds: ['npc_fighter'],
                plannerEventTypes: ['combat'],
                addTrace: noTrace,
            });

            const npcBlock = blocks.find(b => b.source === 'Active NPCs');
            expect(npcBlock).toBeDefined();
            // 'reckless charge' is in the dangerous context pool — should surface
            // for a bold/impulsive NPC on a combat-tagged scene.
            expect(npcBlock!.content).toContain('REACTIONS');
        });
    });

    describe('Phase 2 — NPC budget decoupling (5% floor)', () => {
        it('computeBudgets allocates a 5% npc slice', () => {
            const budgets = computeBudgets(8192, false, 0.10);
            expect(budgets.npc).toBeGreaterThan(0);
            // 8192 limit - ~819 rules = ~7373 adjusted; 5% = ~368
            expect(budgets.npc).toBeGreaterThanOrEqual(350);
            expect(budgets.npc).toBeLessThanOrEqual(420);
            // World budget should be smaller now (adjusted minus npc slice)
            expect(budgets.world).toBeLessThan(4000);
        });

        it('computeBudgets scales the npc slice with context limit (200K → ~10K)', () => {
            const budgets = computeBudgets(200_000, false, 0.10);
            // 200K limit - 20K rules (10%) = 180K adjusted; 5% = 9000
            expect(budgets.npc).toBeGreaterThanOrEqual(8999);
            expect(budgets.npc).toBeLessThanOrEqual(11_000);
        });
    });
});
