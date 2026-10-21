import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    deepArchiveScanV2,
    tierCandidates,
    trimTieredToBudget,
    partitionScenes,
    type TieredCandidate
} from '../deepArchiveSearch';
import { countTokens, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER } from '../../infrastructure';

import { llmCall } from '../../../utils/llmCall';
import { isEmbedderReady, semanticSearchScored } from '../../embedding';
import { getList } from '../../storage/_helpers';
import { useAppStore } from '../../../store/useAppStore';
import type { ArchiveChapter, ArchiveIndexEntry } from '../../../types';

vi.mock('../../../utils/llmCall', () => ({
    llmCall: vi.fn(),
}));

vi.mock('../../embedding', () => ({
    isEmbedderReady: vi.fn(() => true),
    semanticSearchScored: vi.fn(async () => []),
    abortForCampaignSwitch: vi.fn(),
    runFullReindex: vi.fn(),
    warmupEmbedder: vi.fn(),
    getCurrentModelId: vi.fn(() => 'mock-model'),
}));

vi.mock('../../storage/_helpers', () => ({
    getList: vi.fn(async () => []),
    k: vi.fn((campaignId, kind) => `${campaignId}_${kind}`),
}));

function makeChapter(chapterId: string, minScene: string, maxScene: string, overrides: Partial<ArchiveChapter> = {}): ArchiveChapter {
    return {
        chapterId,
        title: `Chapter ${chapterId}`,
        sceneRange: [minScene, maxScene],
        sceneIds: [],
        summary: 'Chapter summary',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: 'neutral',
        themes: [],
        sceneCount: 0,
        ...overrides,
    } as ArchiveChapter;
}

function makeIndexEntry(sceneId: string, overrides: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry {
    return {
        sceneId,
        timestamp: Date.now(),
        keywords: [],
        npcsMentioned: [],
        userSnippet: `Snippet for ${sceneId}`,
        importance: 1.0,
        ...overrides,
    } as ArchiveIndexEntry;
}

/** Stand-in for llmCall's UtilityTimeoutError (the real module is mocked out). */
function utilityTimeout(ms: number, label: string): Error {
    const err = new Error(`Utility call "${label}" exceeded deadline (${ms}ms)`);
    err.name = 'UtilityTimeoutError';
    return err;
}

const defaultMockLlm = (prompts: string[]) => async (_provider: any, prompt: string, _opts: any) => {
    prompts.push(prompt);
    if (prompt.includes('search-probe generator')) {
        return JSON.stringify(['probe1', 'probe2']);
    }
    if (prompt.includes('[CHAPTER INDEX]')) {
        return JSON.stringify({ chapters: ['ch01'] });
    }
    if (prompt.includes('[CANDIDATE SCENES]')) {
        return JSON.stringify({ scenes: ['001'] });
    }
    if (prompt.includes('memory synthesizer')) {
        return 'synthesized memory';
    }
    return '';
};

describe('Deep Archive Search V2 Tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── Group 1: tierCandidates (pure — no mocks) ──
    describe('1. tierCandidates', () => {
        it('assigns tiers A, B, C correctly based on probe hits and selected chapters', () => {
            const probeHits = [
                { id: '001', score: 0.9 }, // Inside selected chapter 1 -> Tier A
                { id: '015', score: 0.8 }, // Outside selected chapter -> Tier B
            ];
            const selectedChapters = [
                makeChapter('ch01', '001', '010'),
            ];
            const archiveIndex = [
                makeIndexEntry('001', { importance: 2.0 }),
                makeIndexEntry('002', { importance: 3.0 }), // Chapter-only top importance -> Tier C
                makeIndexEntry('003', { importance: 1.5 }),
                makeIndexEntry('015', { importance: 1.0 }),
            ];

            const result = tierCandidates({
                probeHits,
                selectedChapters,
                archiveIndex,
                maxPerChapterC: 1
            });

            expect(result).toHaveLength(3);

            const r001 = result.find(c => c.entry.sceneId === '001');
            const r015 = result.find(c => c.entry.sceneId === '015');
            const r002 = result.find(c => c.entry.sceneId === '002');
            const r003 = result.find(c => c.entry.sceneId === '003');

            expect(r001).toBeDefined();
            expect(r001!.tier).toBe('A');
            expect(r001!.score).toBe(0.9);

            expect(r015).toBeDefined();
            expect(r015!.tier).toBe('B');
            expect(r015!.score).toBe(0.8);

            expect(r002).toBeDefined();
            expect(r002!.tier).toBe('C');

            expect(r003).toBeUndefined(); // Excluded because maxPerChapterC is 1 and 002 had higher importance (3.0 > 1.5)
        });

        it('dedupes and respects precedence A > B > C for the same sceneId', () => {
            const probeHits = [{ id: '001', score: 0.9 }];
            const selectedChapters = [makeChapter('ch01', '001', '010')];
            const archiveIndex = [
                makeIndexEntry('001', { importance: 5.0 }),
            ];

            const result = tierCandidates({
                probeHits,
                selectedChapters,
                archiveIndex,
                maxPerChapterC: 5
            });

            expect(result).toHaveLength(1);
            expect(result[0].entry.sceneId).toBe('001');
            expect(result[0].tier).toBe('A'); // A > C
        });

        it('respects maxPerChapterC and picks C by descending importance', () => {
            const probeHits: any[] = [];
            const selectedChapters = [makeChapter('ch01', '001', '010')];
            const archiveIndex = [
                makeIndexEntry('001', { importance: 1.0 }),
                makeIndexEntry('002', { importance: 3.5 }), // highest
                makeIndexEntry('003', { importance: 2.0 }), // second highest
                makeIndexEntry('004', { importance: 0.5 }),
            ];

            const result = tierCandidates({
                probeHits,
                selectedChapters,
                archiveIndex,
                maxPerChapterC: 2
            });

            expect(result).toHaveLength(2);
            expect(result.map(c => c.entry.sceneId)).toEqual(['002', '003']);
            expect(result.map(c => c.tier)).toEqual(['C', 'C']);
        });

        it('returns only C when probes are empty', () => {
            const selectedChapters = [makeChapter('ch01', '001', '010')];
            const archiveIndex = [makeIndexEntry('001')];
            const result = tierCandidates({
                probeHits: [],
                selectedChapters,
                archiveIndex,
                maxPerChapterC: 1
            });
            expect(result).toHaveLength(1);
            expect(result[0].tier).toBe('C');
        });

        it('returns only B when selected chapters are empty', () => {
            const probeHits = [{ id: '001', score: 0.9 }];
            const archiveIndex = [makeIndexEntry('001')];
            const result = tierCandidates({
                probeHits,
                selectedChapters: [],
                archiveIndex
            });
            expect(result).toHaveLength(1);
            expect(result[0].tier).toBe('B');
        });

        it('returns empty array when both probes and chapters are empty', () => {
            const result = tierCandidates({
                probeHits: [],
                selectedChapters: [],
                archiveIndex: [makeIndexEntry('001')]
            });
            expect(result).toEqual([]);
        });
    });

    // ── Group 2: Keying ──
    describe('2. Keying', () => {
        it('includes [SEARCH QUERY] and [CURRENT SCENE] in prompts when searchQuery is provided', async () => {
            const prompts: string[] = [];
            vi.mocked(llmCall).mockImplementation(defaultMockLlm(prompts));
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([{ id: '001', score: 0.9 }]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'EXCERPT_TEXT_1' }] as any,
                'EXCERPT_TEXT_2',
                500,
                () => {},
                'FIND_FEATS'
            );

            expect(brief).toBe('synthesized memory');

            const chapterPrompt = prompts.find(p => p.includes('[CHAPTER INDEX]'));
            const verifyPrompt = prompts.find(p => p.includes('[CANDIDATE SCENES]'));

            expect(chapterPrompt).toBeDefined();
            expect(chapterPrompt).toContain('[SEARCH QUERY]\nFIND_FEATS');
            expect(chapterPrompt).toContain('[CURRENT SCENE]');
            expect(chapterPrompt).toContain('EXCERPT_TEXT_1');
            expect(chapterPrompt).toContain('EXCERPT_TEXT_2');
            expect(chapterPrompt).not.toContain('[CURRENT INPUT]');

            expect(verifyPrompt).toBeDefined();
            expect(verifyPrompt).toContain('[SEARCH QUERY]\nFIND_FEATS');
            expect(verifyPrompt).toContain('[CURRENT SCENE]');
            expect(verifyPrompt).toContain('EXCERPT_TEXT_1');
            expect(verifyPrompt).toContain('EXCERPT_TEXT_2');
            expect(verifyPrompt).not.toContain('[CURRENT INPUT]');
        });

        it('matches v1 keying (contains [CURRENT INPUT] and no [SEARCH QUERY]) when searchQuery is omitted or empty', async () => {
            const prompts: string[] = [];
            vi.mocked(llmCall).mockImplementation(defaultMockLlm(prompts));
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([{ id: '001', score: 0.9 }]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'EXCERPT_TEXT_1' }] as any,
                'EXCERPT_TEXT_2',
                500,
                () => {}
            );

            expect(brief).toBe('synthesized memory');

            const chapterPrompt = prompts.find(p => p.includes('[CHAPTER INDEX]'));
            const verifyPrompt = prompts.find(p => p.includes('[CANDIDATE SCENES]'));

            expect(chapterPrompt).toBeDefined();
            expect(chapterPrompt).toContain('[CURRENT INPUT]');
            expect(chapterPrompt).toContain('EXCERPT_TEXT_1');
            expect(chapterPrompt).toContain('EXCERPT_TEXT_2');
            expect(chapterPrompt).not.toContain('[SEARCH QUERY]');
            expect(chapterPrompt).not.toContain('[CURRENT SCENE]');

            expect(verifyPrompt).toBeDefined();
            expect(verifyPrompt).toContain('[CURRENT INPUT]');
            expect(verifyPrompt).toContain('EXCERPT_TEXT_1');
            expect(verifyPrompt).toContain('EXCERPT_TEXT_2');
            expect(verifyPrompt).not.toContain('[SEARCH QUERY]');
            expect(verifyPrompt).not.toContain('[CURRENT SCENE]');
        });
    });

    // ── Group 3: Degradation ladder ──
    describe('3. Degradation ladder', () => {
        it('skips probe expansion and semantic search when isEmbedderReady() is false, but still returns a brief', async () => {
            const prompts: string[] = [];
            vi.mocked(llmCall).mockImplementation(defaultMockLlm(prompts));
            vi.mocked(isEmbedderReady).mockReturnValue(false); // embedder not ready

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {},
                'FIND_FEATS'
            );

            expect(brief).toBe('synthesized memory');
            expect(isEmbedderReady).toHaveBeenCalled();
            expect(semanticSearchScored).not.toHaveBeenCalled();

            const probePrompt = prompts.find(p => p.includes('search-probe generator'));
            expect(probePrompt).toBeUndefined();

            expect(prompts.some(p => p.includes('[CHAPTER INDEX]'))).toBe(true);
            expect(prompts.some(p => p.includes('[CANDIDATE SCENES]'))).toBe(true);
            expect(prompts.some(p => p.includes('memory synthesizer'))).toBe(true);
        });

        it('still produces a brief via probes-only path (Tier B) when chapter scan fails/times out', async () => {
            const prompts: string[] = [];
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([{ id: '001', score: 0.9 }]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            vi.mocked(llmCall).mockImplementation(async (_provider: any, prompt: string, _opts: any) => {
                prompts.push(prompt);
                if (prompt.includes('search-probe generator')) {
                    return JSON.stringify(['probe1']);
                }
                if (prompt.includes('[CHAPTER INDEX]')) {
                    throw new Error('Timeout or LLM failure');
                }
                if (prompt.includes('[CANDIDATE SCENES]')) {
                    return JSON.stringify({ scenes: ['001'] });
                }
                if (prompt.includes('memory synthesizer')) {
                    return 'synthesized brief from probes';
                }
                return '';
            });

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );

            expect(brief).toBe('synthesized brief from probes');
            const verifyPrompt = prompts.find(p => p.includes('[CANDIDATE SCENES]'));
            expect(verifyPrompt).toContain('○ [Scene 001]');
        });

        it('returns empty string immediately and makes no further calls if both retrievers fail or return empty', async () => {
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([]);
            vi.mocked(getList).mockResolvedValue([]);

            const prompts: string[] = [];
            vi.mocked(llmCall).mockImplementation(async (_provider: any, prompt: string, _opts: any) => {
                prompts.push(prompt);
                if (prompt.includes('search-probe generator')) {
                    return JSON.stringify(['probe1']);
                }
                if (prompt.includes('[CHAPTER INDEX]')) {
                    return JSON.stringify({ chapters: [] });
                }
                return '';
            });

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );

            expect(brief).toBe('');
            expect(prompts.some(p => p.includes('search-probe generator'))).toBe(true);
            expect(prompts.some(p => p.includes('[CHAPTER INDEX]'))).toBe(true);
            expect(prompts.some(p => p.includes('[CANDIDATE SCENES]'))).toBe(false);
            expect(prompts.some(p => p.includes('memory synthesizer'))).toBe(false);
        });

        it('falls back to Tier A scenes when verify call times out', async () => {
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([
                { id: '001', score: 0.9 }
            ]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            vi.mocked(llmCall).mockImplementation((_provider: any, prompt: string, _opts: any) => {
                if (prompt.includes('search-probe generator')) {
                    return Promise.resolve(JSON.stringify(['probe1']));
                }
                if (prompt.includes('[CHAPTER INDEX]')) {
                    return Promise.resolve(JSON.stringify({ chapters: ['ch01'] }));
                }
                if (prompt.includes('[CANDIDATE SCENES]')) {
                    // What llmCall does when its timeoutMs deadline passes (it also aborts the request).
                    return Promise.reject(utilityTimeout(_opts.timeoutMs, _opts.trackingLabel));
                }
                if (prompt.includes('memory synthesizer')) {
                    return Promise.resolve('fallback brief');
                }
                return Promise.resolve('');
            });

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );

            expect(brief).toBe('fallback brief');
        });

        it('falls back to Tier A scenes when verify call throws an error', async () => {
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([
                { id: '001', score: 0.9 }
            ]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            vi.mocked(llmCall).mockImplementation(async (_provider: any, prompt: string, _opts: any) => {
                if (prompt.includes('search-probe generator')) {
                    return JSON.stringify(['probe1']);
                }
                if (prompt.includes('[CHAPTER INDEX]')) {
                    return JSON.stringify({ chapters: ['ch01'] });
                }
                if (prompt.includes('[CANDIDATE SCENES]')) {
                    throw new Error('Verify call failed');
                }
                if (prompt.includes('memory synthesizer')) {
                    return 'fallback brief from error';
                }
                return '';
            });

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );

            expect(brief).toBe('fallback brief from error');
        });

        it('returns empty string if verify call returns successfully but with empty scenes or malformed JSON', async () => {
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([
                { id: '001', score: 0.9 }
            ]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            let verifyOutput = 'malformed json string';

            vi.mocked(llmCall).mockImplementation(async (_provider: any, prompt: string, _opts: any) => {
                if (prompt.includes('search-probe generator')) {
                    return JSON.stringify(['probe1']);
                }
                if (prompt.includes('[CHAPTER INDEX]')) {
                    return JSON.stringify({ chapters: ['ch01'] });
                }
                if (prompt.includes('[CANDIDATE SCENES]')) {
                    return verifyOutput;
                }
                return '';
            });

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            let brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );
            expect(brief).toBe('');

            verifyOutput = JSON.stringify({ scenes: [] });
            brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );
            expect(brief).toBe('');
        });

        it('filters out hallucinated sceneId returned by verify call', async () => {
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([
                { id: '001', score: 0.9 }
            ]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);

            vi.mocked(llmCall).mockImplementation(async (_provider: any, prompt: string, _opts: any) => {
                if (prompt.includes('search-probe generator')) {
                    return JSON.stringify(['probe1']);
                }
                if (prompt.includes('[CHAPTER INDEX]')) {
                    return JSON.stringify({ chapters: ['ch01'] });
                }
                if (prompt.includes('[CANDIDATE SCENES]')) {
                    return JSON.stringify({ scenes: ['001', '999'] }); // 999 is hallucinated
                }
                if (prompt.includes('memory synthesizer')) {
                    return prompt.includes('SCENE 999') ? 'brief with 999' : 'brief only 001';
                }
                return '';
            });

            const archiveIndex = [makeIndexEntry('001')];
            const sealedChapters = [makeChapter('ch01', '001', '010')];

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );

            expect(brief).toBe('brief only 001');
        });
    });

    // ── Group 4: Sealed-range filter ──
    describe('4. Sealed-range filter', () => {
        it('excludes probe hits outside any sealed chapter scene range before tiering', async () => {
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([
                { id: '005', score: 0.9 },
                { id: '015', score: 0.8 },
            ]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '005', userContent: '005 user', assistantContent: '005 assistant' } as any,
                { sceneId: '015', userContent: '015 user', assistantContent: '015 assistant' } as any,
            ]);

            const prompts: string[] = [];
            vi.mocked(llmCall).mockImplementation(defaultMockLlm(prompts));

            const archiveIndex = [makeIndexEntry('005'), makeIndexEntry('015')];
            const sealedChapters = [makeChapter('ch01', '001', '010')]; // Only 005 matches

            await deepArchiveScanV2(
                { provider: 'openai' } as any,
                archiveIndex,
                sealedChapters,
                'campaign-1',
                [{ role: 'user', content: 'hello' }] as any,
                'world',
                500,
                () => {}
            );

            const verifyPrompt = prompts.find(p => p.includes('[CANDIDATE SCENES]'));
            expect(verifyPrompt).toContain('[Scene 005]');
            expect(verifyPrompt).not.toContain('[Scene 015]');
        });
    });

    // ── Group 5: Overflow trim ──
    describe('5. Overflow trim', () => {
        it('drops C by ascending importance, then B by ascending score, while A always survives', () => {
            const c1: TieredCandidate = { entry: makeIndexEntry('001', { importance: 3.0 }), tier: 'A' };
            const c2: TieredCandidate = { entry: makeIndexEntry('002'), tier: 'B', score: 0.8 };
            const c3: TieredCandidate = { entry: makeIndexEntry('003'), tier: 'B', score: 0.4 };
            const c4: TieredCandidate = { entry: makeIndexEntry('004', { importance: 2.0 }), tier: 'C' };
            const c5: TieredCandidate = { entry: makeIndexEntry('005', { importance: 1.0 }), tier: 'C' };

            const tiered = [c1, c2, c3, c4, c5];
            const tokenOf = () => 10;

            expect(trimTieredToBudget(tiered, tokenOf, 50)).toHaveLength(5);

            const trim1 = trimTieredToBudget(tiered, tokenOf, 40);
            expect(trim1).toHaveLength(4);
            expect(trim1.find(c => c.entry.sceneId === '005')).toBeUndefined();

            const trim2 = trimTieredToBudget(tiered, tokenOf, 30);
            expect(trim2).toHaveLength(3);
            expect(trim2.map(c => c.entry.sceneId)).toEqual(['001', '002', '003']);

            const trim3 = trimTieredToBudget(tiered, tokenOf, 20);
            expect(trim3).toHaveLength(2);
            expect(trim3.map(c => c.entry.sceneId)).toEqual(['001', '002']);

            const trim4 = trimTieredToBudget(tiered, tokenOf, 10);
            expect(trim4).toHaveLength(1);
            expect(trim4[0].entry.sceneId).toBe('001');

            const trim5 = trimTieredToBudget(tiered, tokenOf, 5);
            expect(trim5).toHaveLength(1);
            expect(trim5[0].entry.sceneId).toBe('001');
        });
    });

    // ── Group 7: Timeout setting ──
    describe('7. Timeout setting', () => {
        async function runScan(opts?: { timeoutMs?: number; signal?: AbortSignal }) {
            vi.mocked(llmCall).mockImplementation(defaultMockLlm([]));
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([{ id: '001', score: 0.9 }]);
            vi.mocked(getList).mockResolvedValue([
                { sceneId: '001', userContent: 'user content', assistantContent: 'assistant content' } as any
            ]);
            return deepArchiveScanV2(
                { provider: 'openai' } as any,
                [makeIndexEntry('001')],
                [makeChapter('ch01', '001', '010')],
                'campaign-1',
                [] as any,
                'world',
                500,
                () => {},
                'q',
                opts,
            );
        }

        it('gives every utility call the configured timeout, a tracking label and the caller signal', async () => {
            const ac = new AbortController();
            const brief = await runScan({ timeoutMs: 90_000, signal: ac.signal });
            expect(brief).toBe('synthesized memory');

            const calls = vi.mocked(llmCall).mock.calls;
            expect(calls.length).toBe(4); // probes, chapters, verify, summarize
            for (const [, , opts] of calls) {
                expect(opts?.timeoutMs).toBe(90_000);
                expect(opts?.trackingLabel).toMatch(/^deep-archive-/);
                expect(opts?.signal).toBe(ac.signal);
            }
            expect(calls.map(c => c[2]?.trackingLabel)).toEqual([
                'deep-archive-probes', 'deep-archive-chapters', 'deep-archive-verify', 'deep-archive-summarize',
            ]);
        });

        it('defaults to 45s (the utilityTimeoutSeconds default) when no timeout is passed', async () => {
            await runScan();
            for (const [, , opts] of vi.mocked(llmCall).mock.calls) {
                expect(opts?.timeoutMs).toBe(45_000);
            }
        });

        it('stops without verifying or summarizing once the caller aborts', async () => {
            const ac = new AbortController();
            vi.mocked(llmCall).mockImplementation(async (_p: any, prompt: string) => {
                if (prompt.includes('[CHAPTER INDEX]')) {
                    ac.abort();
                    throw new DOMException('Aborted', 'AbortError');
                }
                return defaultMockLlm([])(_p, prompt, {});
            });
            vi.mocked(isEmbedderReady).mockReturnValue(true);
            vi.mocked(semanticSearchScored).mockResolvedValue([{ id: '001', score: 0.9 }]);

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                [makeIndexEntry('001')],
                [makeChapter('ch01', '001', '010')],
                'campaign-1', [] as any, 'world', 500, () => {}, 'q',
                { signal: ac.signal },
            );

            expect(brief).toBe('');
            const prompts = vi.mocked(llmCall).mock.calls.map(c => c[1]);
            expect(prompts.some(p => p.includes('[CANDIDATE SCENES]'))).toBe(false);
            expect(prompts.some(p => p.includes('memory synthesizer'))).toBe(false);
        });
    });

    // ── Group 8: Story order ──
    describe('8. Story order', () => {
        const sceneRecord = (id: string) => ({
            sceneId: id,
            userContent: `player action in scene ${id}`,
            assistantContent: `gm narration for scene ${id} `.repeat(30),
        });
        const sceneTokens = (id: string) => {
            const r = sceneRecord(id);
            return countTokens(`--- SCENE ${id} ---\n[Player]: ${r.userContent}\n[GM]: ${r.assistantContent}`);
        };

        async function scanAndGetSummarizePrompt(availableBudget: number): Promise<string> {
            const prompts: string[] = [];
            vi.mocked(llmCall).mockImplementation(async (_p: any, prompt: string) => {
                prompts.push(prompt);
                if (prompt.includes('[CHAPTER INDEX]')) return JSON.stringify({ chapters: ['ch01'] });
                // Verify answers in importance order, not story order.
                if (prompt.includes('[CANDIDATE SCENES]')) return JSON.stringify({ scenes: ['005', '003', '001'] });
                if (prompt.includes('memory synthesizer')) return 'brief';
                return '';
            });
            vi.mocked(isEmbedderReady).mockReturnValue(false);
            vi.mocked(getList).mockResolvedValue(['001', '003', '005'].map(sceneRecord) as any);

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                [
                    makeIndexEntry('001', { importance: 1.0 }),
                    makeIndexEntry('003', { importance: 2.0 }),
                    makeIndexEntry('005', { importance: 3.0 }),
                ],
                [makeChapter('ch01', '001', '010')],
                'campaign-1', [] as any, 'world', availableBudget, () => {},
            );
            expect(brief).toBe('brief');
            const summarize = prompts.find(p => p.includes('memory synthesizer'));
            expect(summarize).toBeDefined();
            return summarize!;
        }

        it('summarizes the kept scenes in chronological (sceneId) order', async () => {
            const prompt = await scanAndGetSummarizePrompt(5_000);
            const i1 = prompt.indexOf('--- SCENE 001 ---');
            const i3 = prompt.indexOf('--- SCENE 003 ---');
            const i5 = prompt.indexOf('--- SCENE 005 ---');
            expect(i1).toBeGreaterThan(-1);
            expect(i1).toBeLessThan(i3);
            expect(i3).toBeLessThan(i5);
        });

        it('lets importance decide what fits the budget, then restores story order', async () => {
            // Fetch cap is budget × 4: room for the two most important scenes, not the third.
            const twoScenes = sceneTokens('005') + sceneTokens('003');
            const budget = Math.floor((twoScenes + sceneTokens('001') / 2) / 4);

            const prompt = await scanAndGetSummarizePrompt(budget);
            expect(prompt).not.toContain('--- SCENE 001 ---'); // least important, dropped
            const i3 = prompt.indexOf('--- SCENE 003 ---');
            const i5 = prompt.indexOf('--- SCENE 005 ---');
            expect(i3).toBeGreaterThan(-1);
            expect(i3).toBeLessThan(i5);
        });
    });

    // ── Group 9: Scene-boundary splitting ──
    describe('9. Scene-boundary splitting', () => {
        const scene = (id: string, words: number) =>
            `--- SCENE ${id} ---\n[Player]: act ${id}\n[GM]: ${Array.from({ length: words }, (_, i) => `w${id}x${i}`).join(' ')} END_${id}`;

        it('partitionScenes packs whole scenes and never cuts one in half', () => {
            const scenes = ['001', '002', '003', '004', '005'].map(id => scene(id, 120));
            const text = scenes.join('\n\n');
            const per = countTokens(scenes[0]);
            const parts = partitionScenes(text, Math.floor(per * 2.5));

            expect(parts).toHaveLength(3); // 2 + 2 + 1
            expect(parts.join('\n\n')).toBe(text);
            for (const part of parts) {
                expect(part.startsWith('--- SCENE ')).toBe(true);
                const headers = part.match(/--- SCENE (\d+) ---/g) ?? [];
                for (const h of headers) {
                    const id = h.match(/\d+/)![0];
                    expect(part).toContain(`END_${id}`);
                }
            }
        });

        it('partitionScenes gives an oversized scene a partition of its own', () => {
            const big = scene('002', 400);
            const text = [scene('001', 20), big, scene('003', 20)].join('\n\n');
            const parts = partitionScenes(text, Math.floor(countTokens(big) / 2));
            expect(parts).toHaveLength(3);
            expect(parts[1]).toBe(big);
        });

        it('MapReduce sends whole scenes per partition and uses the shared prompt framing', async () => {
            const ids = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(3, '0'));
            const records = ids.map(id => ({
                sceneId: id,
                userContent: `act ${id}`,
                assistantContent: `${Array.from({ length: 1500 }, (_, i) => `w${id}x${i}`).join(' ')} END_${id}`,
            }));
            const prompts: { prompt: string; opts: any }[] = [];
            vi.mocked(llmCall).mockImplementation(async (_p: any, prompt: string, opts: any) => {
                prompts.push({ prompt, opts });
                if (prompt.includes('[CHAPTER INDEX]')) return JSON.stringify({ chapters: ['ch01'] });
                if (prompt.includes('[CANDIDATE SCENES]')) return JSON.stringify({ scenes: ids });
                if (prompt.includes('Merge these')) return 'combined brief';
                if (prompt.includes('memory synthesizer')) return '- a fact';
                return '';
            });
            vi.mocked(isEmbedderReady).mockReturnValue(false);
            vi.mocked(getList).mockResolvedValue(records as any);

            // 128k-context-sized budget: must not turn into one giant call.
            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                ids.map(id => makeIndexEntry(id)),
                [makeChapter('ch01', '001', '020')],
                'campaign-1', [] as any, 'world', 57_600, () => {}, undefined,
                { timeoutMs: 60_000 },
            );
            expect(brief).toBe('combined brief');

            const partPrompts = prompts.filter(p => p.opts?.trackingLabel === 'deep-archive-summarize-part');
            expect(partPrompts.length).toBeGreaterThan(1);
            const seen = new Set<string>();
            for (const { prompt, opts } of partPrompts) {
                expect(opts.timeoutMs).toBe(60_000);
                expect(prompt).toContain(INPUT_DELIMITER);
                expect(prompt).toContain(ANCHOR_BEFORE_INPUT);
                const scenesSection = prompt.slice(prompt.indexOf('SCENES:\n') + 'SCENES:\n'.length);
                // No single partition call is oversized (8k partitions, nothing like 170k).
                expect(countTokens(scenesSection)).toBeLessThanOrEqual(8_000);
                for (const h of scenesSection.match(/--- SCENE (\d+) ---/g) ?? []) {
                    const id = h.match(/\d+/)![0];
                    expect(scenesSection).toContain(`END_${id}`);
                    seen.add(id);
                }
            }
            expect(seen.size).toBeGreaterThan(0);

            const combine = prompts.find(p => p.opts?.trackingLabel === 'deep-archive-combine');
            expect(combine).toBeDefined();
            expect(combine!.prompt).toContain(INPUT_DELIMITER);
            expect(combine!.prompt).toContain(ANCHOR_BEFORE_INPUT);
            expect(combine!.opts.timeoutMs).toBe(60_000);
        });

        it('a failed partition is dropped, not fatal', async () => {
            const ids = Array.from({ length: 6 }, (_, i) => String(i + 1).padStart(3, '0'));
            const records = ids.map(id => ({
                sceneId: id,
                userContent: `act ${id}`,
                assistantContent: `${Array.from({ length: 3000 }, (_, i) => `w${id}x${i}`).join(' ')} END_${id}`,
            }));
            let partCalls = 0;
            vi.mocked(llmCall).mockImplementation(async (_p: any, prompt: string, opts: any) => {
                if (prompt.includes('[CHAPTER INDEX]')) return JSON.stringify({ chapters: ['ch01'] });
                if (prompt.includes('[CANDIDATE SCENES]')) return JSON.stringify({ scenes: ids });
                if (opts?.trackingLabel === 'deep-archive-summarize-part') {
                    if (partCalls++ === 0) throw utilityTimeout(opts.timeoutMs, opts.trackingLabel);
                    return '- a fact';
                }
                if (prompt.includes('Merge these')) return 'combined brief';
                return '';
            });
            vi.mocked(isEmbedderReady).mockReturnValue(false);
            vi.mocked(getList).mockResolvedValue(records as any);

            const brief = await deepArchiveScanV2(
                { provider: 'openai' } as any,
                ids.map(id => makeIndexEntry(id)),
                [makeChapter('ch01', '001', '020')],
                'campaign-1', [] as any, 'world', 57_600, () => {},
            );
            expect(partCalls).toBeGreaterThan(1);
            expect(brief).toBe('combined brief');
        });
    });

    // ── Group 6: Threading ──
    describe('6. Threading', () => {
        it('setDeepSearch(true, "q") then clears both upon simulation of ChatArea consume logic', () => {
            useAppStore.getState().setDeepSearch(true, 'q');
            expect(useAppStore.getState().deepArmed).toBe(true);
            expect(useAppStore.getState().deepSearchQuery).toBe('q');

            useAppStore.getState().setDeepSearch(false, '');
            expect(useAppStore.getState().deepArmed).toBe(false);
            expect(useAppStore.getState().deepSearchQuery).toBe('');
        });

        it('clears armed state and query on campaign switch to null', async () => {
            useAppStore.getState().setDeepSearch(true, 'query text');
            expect(useAppStore.getState().deepArmed).toBe(true);
            expect(useAppStore.getState().deepSearchQuery).toBe('query text');

            await useAppStore.getState().setActiveCampaign(null);
            expect(useAppStore.getState().deepArmed).toBe(false);
            expect(useAppStore.getState().deepSearchQuery).toBe('');
        });
    });
});
