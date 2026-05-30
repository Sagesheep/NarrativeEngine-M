import { describe, it, expect } from 'vitest';
import { mmrSelect, cosineSimilarity } from '../embedding';

/** Build a unit vector in `dims` dimensions, pointing along axis `axis`. */
function axisVec(dims: number, axis: number): number[] {
    const v = new Array(dims).fill(0);
    v[axis] = 1;
    return v;
}

/** Pool entry helper: id + relevance score + vector. */
function entry(id: string, score: number, vector: number[]) {
    return { id, score, vector };
}

describe('mmrSelect', () => {
    it('returns all items unchanged when pool <= topK', () => {
        const pool = [
            entry('a', 0.9, axisVec(3, 0)),
            entry('b', 0.8, axisVec(3, 1)),
        ];
        const result = mmrSelect(pool, 5);
        expect(result.map(r => r.id).sort()).toEqual(['a', 'b']);
    });

    it('is a no-op (returns top-K by relevance) when all vectors are orthogonal — no diversity penalty', () => {
        // Orthogonal vectors have cosine sim = 0, so MMR = lambda * relevance,
        // and ranking is pure relevance order
        const pool = [
            entry('a', 0.9, axisVec(4, 0)),
            entry('b', 0.8, axisVec(4, 1)),
            entry('c', 0.7, axisVec(4, 2)),
            entry('d', 0.6, axisVec(4, 3)),
        ];
        const result = mmrSelect(pool, 2);
        expect(result.map(r => r.id)).toEqual(['a', 'b']);
    });

    it('demotes a near-duplicate in favour of a distinct but lower-relevance item', () => {
        // 'a' is the seed (highest relevance).
        // 'b' is almost identical to 'a' → heavy diversity penalty.
        // 'c' is orthogonal to 'a' → no diversity penalty.
        // Even though relevance(b) > relevance(c), MMR should pick 'c' second.
        const vecA = [1, 0, 0];
        const vecB = [0.999, 0.045, 0]; // nearly identical to A
        const vecC = [0, 1, 0];         // orthogonal to A

        const pool = [
            entry('a', 0.95, vecA),
            entry('b', 0.85, vecB),  // near-duplicate of 'a'
            entry('c', 0.75, vecC),  // distinct from 'a'
        ];

        const result = mmrSelect(pool, 2);
        expect(result[0].id).toBe('a');  // highest relevance always seeds
        expect(result[1].id).toBe('c');  // 'c' beats 'b' because 'b' is penalised
    });

    it('seeds with the highest-relevance item regardless of pool order', () => {
        const pool = [
            entry('low',  0.5, axisVec(3, 0)),
            entry('high', 0.9, axisVec(3, 1)),
            entry('mid',  0.7, axisVec(3, 2)),
        ];
        // Shuffle pool order to verify seeding is by score, not position
        const shuffled = [pool[2], pool[0], pool[1]];
        const result = mmrSelect(shuffled, 1);
        expect(result[0].id).toBe('high');
    });

    it('preserves scores from the original pool in output', () => {
        const pool = [
            entry('x', 0.88, axisVec(3, 0)),
            entry('y', 0.77, axisVec(3, 1)),
            entry('z', 0.55, axisVec(3, 2)),
        ];
        const result = mmrSelect(pool, 2);
        for (const r of result) {
            const original = pool.find(p => p.id === r.id)!;
            expect(r.score).toBe(original.score);
        }
    });

    it('handles topK = 1 correctly (just the seed)', () => {
        const pool = [
            entry('a', 0.9, axisVec(2, 0)),
            entry('b', 0.8, axisVec(2, 1)),
            entry('c', 0.7, axisVec(2, 0)),
        ];
        const result = mmrSelect(pool, 1);
        expect(result.length).toBe(1);
        expect(result[0].id).toBe('a');
    });

    it('returns exactly topK items when pool > topK', () => {
        const pool = Array.from({ length: 10 }, (_, i) =>
            entry(`scene-${i}`, 0.9 - i * 0.05, axisVec(10, i))
        );
        const result = mmrSelect(pool, 4);
        expect(result.length).toBe(4);
    });

    it('cosineSimilarity between identical vectors is ~1 (sanity check for MMR internals)', () => {
        const v = [0.6, 0.8, 0];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });
});
