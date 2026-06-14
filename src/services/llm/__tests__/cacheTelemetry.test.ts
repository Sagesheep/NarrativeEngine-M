import { beforeEach, describe, expect, it } from 'vitest';
import {
    recordCacheUsage,
    getCacheRollup,
    hitRatio,
    totalsForDay,
    clearCacheTelemetry,
} from '../cacheTelemetry';

const today = new Date().toISOString().slice(0, 10);

describe('cacheTelemetry', () => {
    beforeEach(() => clearCacheTelemetry());

    it('accumulates cache hit/miss tokens per label', () => {
        recordCacheUsage('story-generation', {
            prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
            prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200,
        });
        recordCacheUsage('story-generation', {
            prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100,
            prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400,
        });

        const stat = getCacheRollup()[today]['story-generation'];
        expect(stat.calls).toBe(2);
        expect(stat.hitTokens).toBe(1400);
        expect(stat.missTokens).toBe(600);
        expect(hitRatio(stat)).toBeCloseTo(0.7, 5);
    });

    it('ignores usage without a cache split (non-DeepSeek providers)', () => {
        recordCacheUsage('utility', {
            prompt_tokens: 500, completion_tokens: 50, total_tokens: 550,
        });
        expect(getCacheRollup()[today]).toBeUndefined();
    });

    it('is a no-op when usage is undefined', () => {
        recordCacheUsage('story-generation', undefined);
        expect(Object.keys(getCacheRollup())).toHaveLength(0);
    });

    it('totalsForDay collapses across labels', () => {
        recordCacheUsage('story-generation', {
            prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000,
            prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100,
        });
        recordCacheUsage('npc-generation', {
            prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000,
            prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 900,
        });

        const total = totalsForDay(today)!;
        expect(total.calls).toBe(2);
        expect(total.hitTokens).toBe(1000);
        expect(total.missTokens).toBe(1000);
        expect(hitRatio(total)).toBeCloseTo(0.5, 5);
    });

    it('hitRatio is 0 when there is no input', () => {
        expect(hitRatio({ calls: 0, hitTokens: 0, missTokens: 0, promptTokens: 0, completionTokens: 0 })).toBe(0);
    });
});
