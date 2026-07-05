import { describe, it, expect } from 'vitest';
import { assembleWorldBlocks } from '../payloadWorldContext';
import type { ArchiveScene, ArchiveIndexEntry, NPCEntry, GameContext, ChatMessage, PayloadTrace, ArchiveChapter } from '../../../types';

const baseScene = (overrides: Partial<ArchiveScene> & { sceneId: string }): ArchiveScene => ({
    content: 'Some scene content.',
    tokens: 10,
    ...overrides,
});

const baseIndexEntry = (overrides: Partial<ArchiveIndexEntry> & { sceneId: string }): ArchiveIndexEntry => ({
    timestamp: Date.now(),
    keywords: [],
    npcsMentioned: [],
    userSnippet: '',
    ...overrides,
});

const baseNpc = (overrides: Partial<NPCEntry> & { id: string; name: string }): NPCEntry => ({
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

describe('assembleWorldBlocks — witness tag in scene headers', () => {
    it('renders witness names in header when npcsWitnessed has resolvable ids', () => {
        const npcA = baseNpc({ id: 'npc_1', name: 'Aldric' });
        const npcB = baseNpc({ id: 'npc_2', name: 'Brenna' });
        const archiveRecall = [baseScene({ sceneId: '014' })];
        const archiveIndex: ArchiveIndexEntry[] = [
            baseIndexEntry({ sceneId: '014', npcsWitnessed: ['npc_1', 'npc_2'] }),
        ];

        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            archiveRecall,
            archiveIndex,
            npcLedger: [npcA, npcB],
            addTrace: noTrace,
        });

        const content = blocks.find(b => b.source === 'Archive Recall')!.content;
        expect(content).toContain('[PAST SCENE | Witnessed by: Aldric, Brenna');
        expect(content).toContain('NPCs not listed were NOT present');
    });

    it('renders plain header when npcsWitnessed is undefined', () => {
        const archiveRecall = [baseScene({ sceneId: '015' })];
        const archiveIndex: ArchiveIndexEntry[] = [
            baseIndexEntry({ sceneId: '015' }),
        ];

        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            archiveRecall,
            archiveIndex,
            npcLedger: [],
            addTrace: noTrace,
        });

        const content = blocks[0].content;
        expect(content).toContain('[PAST SCENE]');
        expect(content).not.toContain('Witnessed by');
    });

    it('skips unresolvable witness ids and falls back to plain header if none resolve', () => {
        const archiveRecall = [baseScene({ sceneId: '016' })];
        const archiveIndex: ArchiveIndexEntry[] = [
            baseIndexEntry({ sceneId: '016', npcsWitnessed: ['npc_ghost'] }),
        ];

        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            archiveRecall,
            archiveIndex,
            npcLedger: [],
            addTrace: noTrace,
        });

        const content = blocks[0].content;
        expect(content).toContain('[PAST SCENE]');
        expect(content).not.toContain('Witnessed by');
    });

    it('renders resolved names and skips unresolvable ids', () => {
        const npcA = baseNpc({ id: 'npc_1', name: 'Aldric' });
        const archiveRecall = [baseScene({ sceneId: '017' })];
        const archiveIndex: ArchiveIndexEntry[] = [
            baseIndexEntry({ sceneId: '017', npcsWitnessed: ['npc_1', 'npc_ghost'] }),
        ];

        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            archiveRecall,
            archiveIndex,
            npcLedger: [npcA],
            addTrace: noTrace,
        });

        const content = blocks.find(b => b.source === 'Archive Recall')!.content;
        expect(content).toContain('Witnessed by: Aldric');
        expect(content).not.toContain('npc_ghost');
    });
});

describe('assembleWorldBlocks — reserved names block', () => {
    it('lists every ledger name (including archived) as the first block', () => {
        const ledger = [
            baseNpc({ id: 'npc_1', name: 'Voss' }),
            baseNpc({ id: 'npc_2', name: 'Maren Blackwood' }),
            baseNpc({ id: 'npc_3', name: 'Old Garruk' }),
        ];

        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            npcLedger: ledger,
            addTrace: noTrace,
        });

        expect(blocks[0].source).toBe('Reserved Names');
        const content = blocks[0].content;
        expect(content).toContain('[RESERVED CHARACTER NAMES]');
        expect(content).toContain('Voss');
        expect(content).toContain('Maren Blackwood');
        expect(content).toContain('Old Garruk');
        expect(content).toContain('do NOT reuse');
    });

    it('omits the block when the ledger is empty', () => {
        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            npcLedger: [],
            addTrace: noTrace,
        });

        expect(blocks.find(b => b.source === 'Reserved Names')).toBeUndefined();
    });
});

describe('assembleWorldBlocks — open threads block', () => {
    it('contains [OPEN THREADS] when sealed chapters have unresolved threads', () => {
        const sealedChapters: ArchiveChapter[] = [
            {
                chapterId: 'CH01', title: 'Ch 1', sceneRange: ['001', '010'] as [string, string],
                sceneIds: [], summary: '', keywords: [], npcs: [], majorEvents: [],
                unresolvedThreads: ['The missing heir'], tone: '', themes: [], sceneCount: 10,
                sealedAt: Date.now(),
            },
        ];

        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            sealedChapters,
            addTrace: noTrace,
        });

        const threadBlock = blocks.find(b => b.source === 'Open Threads');
        expect(threadBlock).toBeDefined();
        expect(threadBlock!.content).toContain('[OPEN THREADS');
        expect(threadBlock!.content).toContain('The missing heir');
        expect(threadBlock!.content).toContain('CH01');
    });

    it('omits the block when no sealed chapters or no threads', () => {
        const blocks = assembleWorldBlocks({
            context: stubContext,
            history: [] as ChatMessage[],
            userMessage: 'test',
            addTrace: noTrace,
        });

        const threadBlock = blocks.find(b => b.source === 'Open Threads');
        expect(threadBlock).toBeUndefined();
    });
});