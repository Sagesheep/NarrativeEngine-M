import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildDivergenceBlock } from '../payloadStableContent';
import { assembleWorldBlocks } from '../payloadWorldContext';
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
});
