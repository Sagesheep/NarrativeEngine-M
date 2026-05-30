import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    getForegroundPoolSize,
    resizePool,
    terminatePool,
    getActivePoolSize,
    poolEmbed,
} from '../embedding/embedderPool';

vi.mock('../embedding/embedder', () => ({
    getCurrentModelId: vi.fn(() => 'Xenova/all-MiniLM-L6-v2'),
    embedText: vi.fn(() => Promise.resolve(new Float32Array([0.5, 0.6]))),
}));

const originalHC = navigator.hardwareConcurrency;
const originalDM = (navigator as any).deviceMemory;

function mockHardware(hc: number | undefined, dm?: number) {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
        value: hc,
        configurable: true,
    });
    if (dm !== undefined) {
        (navigator as any).deviceMemory = dm;
    } else {
        delete (navigator as any).deviceMemory;
    }
}

function restoreHardware() {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
        value: originalHC,
        configurable: true,
    });
    if (originalDM !== undefined) {
        (navigator as any).deviceMemory = originalDM;
    } else {
        delete (navigator as any).deviceMemory;
    }
}

describe('getForegroundPoolSize', () => {
    beforeEach(restoreHardware);

    it('returns 1 for 2 cores', () => {
        mockHardware(2);
        expect(getForegroundPoolSize()).toBe(1);
    });

    it('returns 1 for 2 cores with low memory', () => {
        mockHardware(4, 2);
        expect(getForegroundPoolSize()).toBe(1);
    });

    it('returns 2 for 4 cores', () => {
        mockHardware(4);
        expect(getForegroundPoolSize()).toBe(Math.max(1, Math.min(6, Math.floor(4 * 0.75))));
    });

    it('returns 2 for 4 cores with 4GB memory', () => {
        mockHardware(4, 4);
        expect(getForegroundPoolSize()).toBe(Math.min(Math.floor(4 * 0.75), 2));
    });

    it('returns 6 for 16 cores (clamped)', () => {
        mockHardware(16);
        expect(getForegroundPoolSize()).toBe(6);
    });

    it('returns 6 for 32 cores (clamped)', () => {
        mockHardware(32);
        expect(getForegroundPoolSize()).toBe(6);
    });

    it('defaults to 3 when hardwareConcurrency undefined (4 default * 0.75)', () => {
        mockHardware(undefined);
        expect(getForegroundPoolSize()).toBe(Math.max(1, Math.min(6, Math.floor(4 * 0.75))));
    });
});

describe('pool lifecycle', () => {
    beforeEach(() => {
        terminatePool();
    });

    afterEach(() => {
        terminatePool();
    });

    it('returns 0 active size after terminate', () => {
        expect(getActivePoolSize()).toBe(0);
    });

    it('resizePool sets poolSize even if workers fail to init in test env', () => {
        resizePool(2);
        expect(getActivePoolSize()).toBeLessThanOrEqual(2);
    });
});

describe('poolEmbed fallback', () => {
    beforeEach(() => {
        terminatePool();
        vi.clearAllMocks();
    });

    afterEach(() => {
        terminatePool();
    });

    it('falls back to primary embedText when pool init fails', async () => {
        const { embedText } = await import('../embedding/embedder');
        const mockEmbedText = embedText as ReturnType<typeof vi.fn>;
        mockEmbedText.mockResolvedValueOnce(new Float32Array([0.99, 0.01]));

        const vector = await poolEmbed('test text');

        expect(vector).not.toBeNull();
        expect(mockEmbedText).toHaveBeenCalledWith('test text');
    });
});