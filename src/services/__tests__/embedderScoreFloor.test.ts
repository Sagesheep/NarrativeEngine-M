import { describe, it, expect } from 'vitest';
import { scoreFloorFor } from '../embedding/embedder';

// Every similarity cutoff in the app is written for MiniLM. bge scores
// unrelated text around 0.6, so the same numbers would filter nothing.

describe('scoreFloorFor', () => {
    it('keeps MiniLM cutoffs as written', () => {
        expect(scoreFloorFor('Xenova/all-MiniLM-L6-v2', 0.3)).toBe(0.3);
    });

    it('raises cutoffs for bge, keeping their order', () => {
        const probe = scoreFloorFor('Xenova/bge-base-en-v1.5', 0.28);
        const scene = scoreFloorFor('Xenova/bge-base-en-v1.5', 0.3);
        const npc = scoreFloorFor('Xenova/bge-base-en-v1.5', 0.4);
        expect(scene).toBeCloseTo(0.45);
        expect(probe).toBeLessThan(scene);
        expect(npc).toBeGreaterThan(scene);
    });

    it('leaves "no cutoff" alone and unknown models unchanged', () => {
        expect(scoreFloorFor('Xenova/bge-base-en-v1.5', 0)).toBe(0);
        expect(scoreFloorFor('someone/other-model', 0.3)).toBe(0.3);
    });
});
