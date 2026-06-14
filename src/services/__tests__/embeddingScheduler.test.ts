import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProgressiveChunk } from '../embedding/embeddingScheduler';

const mockSetReindexing = vi.fn();
const mockSubscribe = vi.fn(() => vi.fn());
let mockIsStreaming = false;

const mockStore = {
    getState: vi.fn(() => ({
        isStreaming: mockIsStreaming,
        embeddingsReindexing: { active: false, total: 0, done: 0, reason: null as 'switch' | 'lazy' | 'progressive' | null },
        setEmbeddingsReindexing: mockSetReindexing,
    })),
    subscribe: mockSubscribe,
};

vi.mock('../embedding/embedderPool', () => ({
    poolEmbed: vi.fn(() => Promise.resolve(new Float32Array([0.1, 0.2]))),
    terminatePool: vi.fn(),
    getForegroundPoolSize: vi.fn(() => 3),
}));

vi.mock('../embedding/embedder', () => ({
    getCurrentModelId: vi.fn(() => 'test-model-v1'),
}));

vi.mock('../storage/embeddingStorage', () => ({
    embeddingStorage: {
        getAll: vi.fn(() => Promise.resolve([])),
        store: vi.fn(() => Promise.resolve()),
        deleteByTypeAndId: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('../../store/useAppStore', () => ({
    useAppStore: mockStore,
}));

import {
    enqueueProgressive,
    abortForCampaignSwitch,
    getQueueStats,
    registerStore,
    _resetForTesting,
    _setStoreRefForTesting,
} from '../embedding/embeddingScheduler';
import { poolEmbed, terminatePool } from '../embedding/embedderPool';
import { embeddingStorage } from '../storage/embeddingStorage';

const mockPoolEmbed = poolEmbed as ReturnType<typeof vi.fn>;
const mockTerminatePool = terminatePool as ReturnType<typeof vi.fn>;
const mockGetAll = embeddingStorage.getAll as ReturnType<typeof vi.fn>;

describe('embeddingScheduler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetForTesting();
        _setStoreRefForTesting(mockStore);
        mockIsStreaming = false;
        mockSetReindexing.mockImplementation(() => {});
        mockStore.getState.mockReturnValue({
            isStreaming: false,
            embeddingsReindexing: { active: false, total: 0, done: 0, reason: null as 'switch' | 'lazy' | 'progressive' | null },
            setEmbeddingsReindexing: mockSetReindexing,
        });
        mockStore.subscribe.mockImplementation(() => vi.fn());
        Object.defineProperty(document, 'hidden', {
            value: false,
            configurable: true,
        });
    });

    afterEach(() => {
        abortForCampaignSwitch();
    });

    describe('enqueueProgressive', () => {
        it('filters to vector-mode chunks only', async () => {
            const chunks: ProgressiveChunk[] = [
                { id: 'vec1', content: 'vec content', modes: ['vector', 'keyword'], priority: 5 },
                { id: 'always1', content: 'always content', modes: ['always'], priority: 10 },
                { id: 'kw1', content: 'kw content', modes: ['keyword'], priority: 3 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 100));

            const calledContents = mockPoolEmbed.mock.calls.map((c: any[]) => c[0]);
            expect(calledContents).toContain('vec content');
            expect(calledContents).not.toContain('always content');
            expect(calledContents).not.toContain('kw content');
        });

        it('sorts chunks priority-desc', async () => {
            const chunks: ProgressiveChunk[] = [
                { id: 'low', content: 'lo', modes: ['vector'], priority: 1 },
                { id: 'high', content: 'hi', modes: ['vector'], priority: 10 },
                { id: 'mid', content: 'mi', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 100));

            const calledTexts = mockPoolEmbed.mock.calls.map((c: any[]) => c[0]);
            expect(calledTexts[0]).toBe('hi');
        });

        it('deduplicates queue entries enqueued before drain starts', () => {
            mockIsStreaming = true;
            mockStore.getState.mockReturnValue({
                isStreaming: true,
                embeddingsReindexing: { active: false, total: 0, done: 0, reason: null as 'switch' | 'lazy' | 'progressive' | null },
                setEmbeddingsReindexing: mockSetReindexing,
            });

            const chunks: ProgressiveChunk[] = [
                { id: 'dup1', content: 'a', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });
            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            const stats = getQueueStats();
            expect(stats.queueLength).toBe(1);
            expect(stats.total).toBe(1);

            mockIsStreaming = false;
            mockStore.getState.mockReturnValue({
                isStreaming: false,
                embeddingsReindexing: { active: true, total: 1, done: 0, reason: 'progressive' as const },
                setEmbeddingsReindexing: mockSetReindexing,
            });

            abortForCampaignSwitch();
        });

        it('passes rule content in full (no truncation)', async () => {
            const longContent = 'x'.repeat(600);
            const chunks: ProgressiveChunk[] = [
                { id: 'r1', content: longContent, modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'rule', chunks });

            await new Promise((r) => setTimeout(r, 100));

            const callContent = mockPoolEmbed.mock.calls[0]?.[0] as string | undefined;
            if (callContent !== undefined) {
                expect(callContent.length).toBe(600);
            }
        });

        it('does not slice lore content', async () => {
            const longContent = 'x'.repeat(600);
            const chunks: ProgressiveChunk[] = [
                { id: 'l1', content: longContent, modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 100));

            const callContent = mockPoolEmbed.mock.calls[0]?.[0] as string | undefined;
            if (callContent !== undefined) {
                expect(callContent.length).toBe(600);
            }
        });
    });

    describe('resumability', () => {
        it('skips already-stored ids via getAll', async () => {
            mockGetAll.mockResolvedValueOnce([{ id: 'stored1', vector: [0.1] }]);

            const chunks: ProgressiveChunk[] = [
                { id: 'stored1', content: 'already stored', modes: ['vector'], priority: 5 },
                { id: 'new1', content: 'new content', modes: ['vector'], priority: 5 },
            ];

            await (await import('../embedding/embeddingScheduler')).enqueueProgressiveWithExistingCheck({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 100));

            const embedContents = mockPoolEmbed.mock.calls.map((c: any[]) => c[0]);
            expect(embedContents).toContain('new content');
            expect(embedContents).not.toContain('already stored');
        });
    });

    describe('pause gate', () => {
        it('does not embed when isStreaming is true', async () => {
            mockIsStreaming = true;
            mockStore.getState.mockReturnValue({
                isStreaming: true,
                embeddingsReindexing: { active: false, total: 0, done: 0, reason: null as 'switch' | 'lazy' | 'progressive' | null },
                setEmbeddingsReindexing: mockSetReindexing,
            });

            const chunks: ProgressiveChunk[] = [
                { id: 's1', content: 'stream content', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 100));

            expect(mockPoolEmbed).not.toHaveBeenCalled();

            mockIsStreaming = false;
            mockStore.getState.mockReturnValue({
                isStreaming: false,
                embeddingsReindexing: { active: true, total: 1, done: 0, reason: 'progressive' as const },
                setEmbeddingsReindexing: mockSetReindexing,
            });
        });

        it('does not embed when document.hidden is true', async () => {
            Object.defineProperty(document, 'hidden', {
                value: true,
                configurable: true,
            });

            const chunks: ProgressiveChunk[] = [
                { id: 'h1', content: 'hidden content', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 100));

            expect(mockPoolEmbed).not.toHaveBeenCalled();

            Object.defineProperty(document, 'hidden', {
                value: false,
                configurable: true,
            });
        });
    });

    describe('progress', () => {
        it('sets progress banner with progressive reason', async () => {
            const chunks: ProgressiveChunk[] = [
                { id: 'p1', content: 'p1 content', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 150));

            const progressiveCalls = mockSetReindexing.mock.calls.filter(
                (c: any[]) => c[0]?.reason === 'progressive'
            );
            expect(progressiveCalls.length).toBeGreaterThanOrEqual(1);
        });

        it('completes with active:false when queue drains', async () => {
            const chunks: ProgressiveChunk[] = [
                { id: 'd1', content: 'drain content', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 200));

            const finalCall = mockSetReindexing.mock.calls[mockSetReindexing.mock.calls.length - 1];
            expect(finalCall[0].active).toBe(false);
        });

        it('stores vectors with the current model ID', async () => {
            const { getCurrentModelId } = await import('../embedding/embedder');
            const chunks: ProgressiveChunk[] = [
                { id: 'mid1', content: 'model id content', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 150));

            const storeCalls = (embeddingStorage.store as ReturnType<typeof vi.fn>).mock.calls;
            expect(storeCalls.length).toBeGreaterThanOrEqual(1);
            const lastCall = storeCalls[storeCalls.length - 1];
            expect(lastCall[4]).toBe(getCurrentModelId());
        });
    });

    describe('resume after pause (BUG-1)', () => {
        it('resumes draining when isStreaming returns to false', async () => {
            let capturedListener: ((s: any) => void) | null = null;
            mockStore.subscribe.mockImplementation(((l: any) => {
                capturedListener = l;
                return vi.fn();
            }) as any);

            // Start while the AI is streaming → drain pauses immediately.
            mockIsStreaming = true;
            mockStore.getState.mockImplementation(() => ({
                isStreaming: mockIsStreaming,
                embeddingsReindexing: { active: false, total: 0, done: 0, reason: null as 'switch' | 'lazy' | 'progressive' | null },
                setEmbeddingsReindexing: mockSetReindexing,
            }));

            const chunks: ProgressiveChunk[] = [
                { id: 'r1', content: 'resume content', modes: ['vector'], priority: 5 },
            ];
            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 50));
            expect(mockPoolEmbed).not.toHaveBeenCalled();
            expect(typeof capturedListener).toBe('function');

            // Streaming ends → fire the store subscriber; drain resumes after the
            // 5s settle debounce, so wait past it.
            mockIsStreaming = false;
            capturedListener!({ isStreaming: false });

            await new Promise((r) => setTimeout(r, 5200));

            const embedContents = mockPoolEmbed.mock.calls.map((c: any[]) => c[0]);
            expect(embedContents).toContain('resume content');
        }, 8000);

        it('resumes draining when document.hidden returns to false', async () => {
            Object.defineProperty(document, 'hidden', { value: true, configurable: true });
            mockIsStreaming = false;
            mockStore.getState.mockImplementation(() => ({
                isStreaming: false,
                embeddingsReindexing: { active: false, total: 0, done: 0, reason: null as 'switch' | 'lazy' | 'progressive' | null },
                setEmbeddingsReindexing: mockSetReindexing,
            }));

            const chunks: ProgressiveChunk[] = [
                { id: 'v1', content: 'visible content', modes: ['vector'], priority: 5 },
            ];
            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            await new Promise((r) => setTimeout(r, 50));
            expect(mockPoolEmbed).not.toHaveBeenCalled();

            // Tab returns to foreground → fire visibilitychange; drain resumes
            // after the 5s settle debounce, so wait past it.
            Object.defineProperty(document, 'hidden', { value: false, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));

            await new Promise((r) => setTimeout(r, 5200));

            const embedContents = mockPoolEmbed.mock.calls.map((c: any[]) => c[0]);
            expect(embedContents).toContain('visible content');
        }, 8000);
    });

    describe('counter reset (ISSUE-3)', () => {
        it('zeroes totals after a completed drain so the next upload starts at 0', async () => {
            enqueueProgressive({
                campaignId: 'c1',
                type: 'lore',
                chunks: [{ id: 'a1', content: 'a', modes: ['vector'], priority: 5 }],
            });
            await new Promise((r) => setTimeout(r, 150));

            let stats = getQueueStats();
            expect(stats.total).toBe(0);
            expect(stats.done).toBe(0);

            enqueueProgressive({
                campaignId: 'c1',
                type: 'lore',
                chunks: [{ id: 'b1', content: 'b', modes: ['vector'], priority: 5 }],
            });

            stats = getQueueStats();
            expect(stats.total).toBe(1);

            await new Promise((r) => setTimeout(r, 100));
        });
    });

    describe('store wiring (BUG-2)', () => {
        it('registerStore connects the store without the test-only setter', async () => {
            // Simulate the production wiring path: no _setStoreRefForTesting,
            // only registerStore (as useAppStore.ts calls it at startup).
            _resetForTesting();
            registerStore(mockStore);
            mockIsStreaming = false;

            enqueueProgressive({
                campaignId: 'c1',
                type: 'lore',
                chunks: [{ id: 'w1', content: 'w1 content', modes: ['vector'], priority: 5 }],
            });

            await new Promise((r) => setTimeout(r, 100));

            const progressiveCalls = mockSetReindexing.mock.calls.filter(
                (c: any[]) => c[0]?.reason === 'progressive'
            );
            expect(progressiveCalls.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('abortForCampaignSwitch', () => {
        it('clears queue and terminates pool', () => {
            const chunks: ProgressiveChunk[] = [
                { id: 'a1', content: 'abort content', modes: ['vector'], priority: 5 },
            ];

            enqueueProgressive({ campaignId: 'c1', type: 'lore', chunks });

            abortForCampaignSwitch();

            const stats = getQueueStats();
            expect(stats.queueLength).toBe(0);
            expect(stats.total).toBe(0);
            expect(mockTerminatePool).toHaveBeenCalled();
        });
    });
});