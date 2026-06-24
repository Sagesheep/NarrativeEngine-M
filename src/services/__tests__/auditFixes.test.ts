import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, SemanticFact, PinnedExcerpt } from '../../types';

// ─── F4: Funnel threads divergenceSceneIds + plannerFilters ───

const mockRetrieveArchiveMemory = vi.fn().mockReturnValue(['001', '002', '003']);
const mockFetchArchiveScenes = vi.fn().mockResolvedValue(
    ['001', '002', '003'].map(id => ({ sceneId: id, content: `Scene ${id} content`, tokens: 10 }))
);
const mockLlmCall = vi.fn().mockResolvedValue('YES');

vi.mock('../archive/archiveMemory', () => ({
    extractContextActivations: vi.fn(() => ({})),
    expandActivationsWithFacts: vi.fn(() => ({})),
    retrieveArchiveMemory: (...args: unknown[]) => mockRetrieveArchiveMemory(...args),
    fetchArchiveScenes: (...args: unknown[]) => mockFetchArchiveScenes(...args),
}));

vi.mock('../../utils/llmCall', () => ({
    llmCall: (...args: unknown[]) => mockLlmCall(...args),
}));

import { recallWithChapterFunnel } from '../archive/archiveChapterEngine';
import { buildPayload } from '../payload/payloadBuilder';
import { defaultContext } from '../../store/slices/campaignSlice';
import { defaultSettings } from '../../store/settingsMigration';

function makeChapter(id: string, sealed = true): ArchiveChapter {
    return {
        chapterId: id,
        title: `Chapter ${id}`,
        sceneRange: ['001', '010'],
        sceneIds: ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010'],
        summary: `Summary of ${id}`,
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 10,
        ...(sealed ? { sealedAt: Date.now() } : {}),
    };
}

function makeIndexEntry(sceneId: string): ArchiveIndexEntry {
    return {
        sceneId,
        userSnippet: `Player did X in scene ${sceneId}`,
        keywords: ['test'],
        npcsMentioned: ['npc1'],
        npcsWitnessed: ['npc1'],
        events: [],
        timestamp: parseInt(sceneId, 10) * 1000,
    };
}

const chapters = [makeChapter('CH01'), makeChapter('CH02')];
const index: ArchiveIndexEntry[] = ['001', '002', '003'].map(makeIndexEntry);
const messages: ChatMessage[] = [];
const npcLedger: NPCEntry[] = [];
const semanticFacts: SemanticFact[] = [];
const provider = { id: 'u', endpoint: 'http://x', modelName: 'm', apiKey: '' } as never;

describe('F4: recallWithChapterFunnel threads divergenceSceneIds and plannerFilters', () => {
    beforeEach(() => {
        mockRetrieveArchiveMemory.mockClear().mockReturnValue(['001', '002', '003']);
        mockFetchArchiveScenes.mockClear().mockResolvedValue(
            ['001', '002', '003'].map(id => ({ sceneId: id, content: `Scene ${id}`, tokens: 10 }))
        );
        mockLlmCall.mockClear().mockResolvedValue('YES');
    });

    it('passes divergenceSceneIds and filters to retrieveArchiveMemory calls', async () => {
        const divergenceSceneIds = new Set(['002']);
        const filters = { characters: ['Astarion'], eventTypes: ['betrayal'] };

        // With no sealed chapters (rankChapters returns []), the funnel falls back
        // to a single retrieveArchiveMemory call — test that it receives both params.
        const unsealedChapters = [makeChapter('CH_OPEN', false)];
        await recallWithChapterFunnel(
            'camp1', unsealedChapters, index, 'test query', messages, npcLedger, semanticFacts,
            3000, provider, undefined, undefined, undefined,
            divergenceSceneIds, filters
        );

        // The fallback path calls retrieveArchiveMemory once
        expect(mockRetrieveArchiveMemory).toHaveBeenCalled();
        const lastCall = mockRetrieveArchiveMemory.mock.calls[mockRetrieveArchiveMemory.mock.calls.length - 1];
        expect(lastCall[8]).toBe(divergenceSceneIds);
        expect(lastCall[9]).toBe(filters);
    });

    it('passes divergenceSceneIds and filters through Phase 4 scoring', async () => {
        const divergenceSceneIds = new Set(['002']);
        const filters = { locations: ['Baldurs Gate'] };

        await recallWithChapterFunnel(
            'camp1', chapters, index, 'test query', messages, npcLedger, semanticFacts,
            3000, provider, undefined, undefined, undefined,
            divergenceSceneIds, filters
        );

        const calls = mockRetrieveArchiveMemory.mock.calls as unknown[][];
        const phase4Call = calls.find(c => {
            const sceneRanges = c[6];
            return sceneRanges !== undefined && sceneRanges !== null;
        });
        expect(phase4Call).toBeDefined();
        expect(phase4Call![8]).toBe(divergenceSceneIds);
        expect(phase4Call![9]).toBe(filters);
    });
});

// ─── F2: Pinned Memories reach buildPayload ───

describe('F2: buildPinnedMemoriesBlock renders excerpts', () => {
    it('formats pinned excerpts with scene numbers', async () => {
        const { buildPinnedMemoriesBlock } = await import('../payload/payloadHistoryFitting');
        const excerpts: PinnedExcerpt[] = [
            { id: 'pin1', sourceMessageId: 'msg1', text: 'The dragon was slain', createdAt: Date.now(), isFullMessage: false },
            { id: 'pin2', sourceMessageId: 'msg2', text: 'Astarion betrayed us', createdAt: Date.now(), isFullMessage: false },
        ];
        const messages = [
            { id: 'msg1', role: 'user' as const, content: 'hi', sceneNumber: '005' },
            { id: 'msg2', role: 'assistant' as const, content: 'hello' },
        ];
        const block = buildPinnedMemoriesBlock(excerpts, messages as any);
        expect(block).toContain('[PINNED MEMORIES]');
        expect(block).toContain('The dragon was slain');
        expect(block).toContain('scene 005');
        expect(block).toContain('Astarion betrayed us');
    });
});

// ─── F2 payload-side guard ───
// The original F2 bug was that pinnedExcerpts never reached buildPayload, so the
// [PINNED MEMORIES] block was never emitted. Assert buildPayload honors the field
// end-to-end. (The caller wiring — TurnState.pinnedExcerpts → turnContext → here —
// is type-enforced; F8's try/catch/finally in turnOrchestrator is control-flow,
// covered by review.)

describe('F2: buildPayload emits the pinned block when excerpts are supplied', () => {
    const baseOpts = () => ({
        settings: { ...defaultSettings, contextLimit: 8192 },
        context: defaultContext,
        history: [] as ChatMessage[],
        userMessage: 'What do we do now?',
    });

    it('renders a [PINNED MEMORIES] system message containing the excerpt text', () => {
        const pinnedExcerpts: PinnedExcerpt[] = [
            { id: 'p1', sourceMessageId: 'm1', text: 'The relic must never be opened', createdAt: 0, isFullMessage: false },
        ];
        const { messages } = buildPayload({ ...baseOpts(), pinnedExcerpts });
        const hit = messages.some(m =>
            typeof m.content === 'string' &&
            m.content.includes('[PINNED MEMORIES]') &&
            m.content.includes('The relic must never be opened')
        );
        expect(hit).toBe(true);
    });

    it('omits the pinned block when no excerpts are supplied', () => {
        const { messages } = buildPayload(baseOpts());
        expect(messages.some(m => typeof m.content === 'string' && m.content.includes('[PINNED MEMORIES]'))).toBe(false);
    });
});

// ─── F7: parseInt comparison in resolveTimeline ───

describe('F7: resolveTimeline sorts sceneId using parseInt comparison', () => {
    it('correctly resolves timeline when sceneIds exceed 999 (e.g. 1000 vs 998)', async () => {
        const { resolveTimeline } = await import('../campaign-state/timelineResolver');
        const events = [
            { subject: 'Astarion', predicate: 'isDead', object: 'true', sceneId: '998', importance: 3, chapterId: 'CH39' },
            { subject: 'Astarion', predicate: 'isDead', object: 'false', sceneId: '1000', importance: 3, chapterId: 'CH40' }
        ];
        const resolved = resolveTimeline(events as any);
        // The newer scene (1000) should win over the older scene (998), returning object: 'false'
        expect(resolved).toHaveLength(1);
        expect(resolved[0].sceneId).toBe('1000');
        expect(resolved[0].object).toBe('false');
    });
});

// ─── F13: filterRecallByPerception empty witness array ───

describe('F13: filterRecallByPerception preserves scenes with empty npcsWitnessed array', () => {
    it('behaves like undefined when npcsWitnessed is empty list []', async () => {
        const { assembleWorldBlocks } = await import('../payload/payloadWorldContext');
        
        const archiveRecall = [
            { sceneId: '001', content: 'PC solo scene with empty array', tokens: 10 },
            { sceneId: '002', content: 'PC solo scene with undefined', tokens: 10 },
            { sceneId: '003', content: 'NPC scene with different NPC', tokens: 10 }
        ];
        
        const archiveIndex = [
            { sceneId: '001', userSnippet: '', keywords: [], npcsMentioned: [], npcsWitnessed: [] }, // empty list
            { sceneId: '002', userSnippet: '', keywords: [], npcsMentioned: [], npcsWitnessed: undefined }, // undefined
            { sceneId: '003', userSnippet: '', keywords: [], npcsMentioned: ['npc_other'], npcsWitnessed: ['npc_other'] }
        ];

        const npcLedger = [
            { id: 'npc_onstage', name: 'Onstage NPC', archived: false }
        ];

        const blocks = assembleWorldBlocks({
            context: { ...defaultContext },
            history: [],
            userMessage: '',
            archiveRecall: archiveRecall as any,
            archiveIndex: archiveIndex as any,
            npcLedger: npcLedger as any,
            onStageNpcIds: ['npc_onstage'],
            addTrace: () => {}
        });

        const recallBlock = blocks.find(b => b.source === 'Archive Recall');
        expect(recallBlock).toBeDefined();
        // Scene 001 (empty array) and Scene 002 (undefined) should be preserved
        // Scene 003 should be filtered out because npc_other is not onstage/active
        expect(recallBlock!.content).toContain('PC solo scene with empty array');   // scene 001 kept
        expect(recallBlock!.content).toContain('PC solo scene with undefined');      // scene 002 kept
        expect(recallBlock!.content).not.toContain('NPC scene with different NPC');  // scene 003 filtered out
    });
});