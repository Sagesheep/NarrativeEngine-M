import { describe, it, expect } from 'vitest';
import { isKnownName, lookupCultures, genderOf, drawUnusedName, NAME_CULTURES } from '../npc';

describe('nameBank', () => {
    it('loads multiple culture headers', () => {
        expect(NAME_CULTURES.length).toBeGreaterThan(10);
        expect(NAME_CULTURES).toContain('japan');
        expect(NAME_CULTURES).toContain('fantasy-neutral');
    });

    it('recognises a known name and rejects gibberish', () => {
        expect(isKnownName('Anna')).toBe(true);
        expect(isKnownName('Zxqwzzpfk')).toBe(false);
    });

    it('keys on first name only (ignores surname)', () => {
        expect(isKnownName('Anna Blackwood')).toBe(true);
    });

    it('reports every culture a shared name belongs to', () => {
        const cultures = lookupCultures('Anna');
        expect(cultures).toContain('english');
        expect(cultures.length).toBeGreaterThan(1); // Anna is cross-cultural
    });

    it('returns empty cultures for an unknown name', () => {
        expect(lookupCultures('Zxqwzzpfk')).toEqual([]);
    });

    it('reports a gender for known names, undefined for unknown', () => {
        expect(['m', 'f', 'u']).toContain(genderOf('Anna'));
        expect(genderOf('Zxqwzzpfk')).toBeUndefined();
    });

    describe('drawUnusedName', () => {
        it('draws from the requested culture', () => {
            const picked = drawUnusedName({ cultures: ['japan'], rng: () => 0 });
            expect(picked).toBeTruthy();
            expect(lookupCultures(picked!)).toContain('japan');
        });

        it('never returns an excluded name', () => {
            // Exclude every japanese name → must fall back to another tier, not return excluded.
            const all = new Set<string>();
            // build exclusion of a specific drawn name and ensure re-draw differs
            const first = drawUnusedName({ cultures: ['japan'], rng: () => 0 })!;
            all.add(first.toLowerCase());
            const second = drawUnusedName({ cultures: ['japan'], exclude: all, rng: () => 0 });
            expect(second).toBeTruthy();
            expect(second!.toLowerCase()).not.toBe(first.toLowerCase());
        });

        it('is deterministic under an injected rng', () => {
            const a = drawUnusedName({ cultures: ['japan'], rng: () => 0 });
            const b = drawUnusedName({ cultures: ['japan'], rng: () => 0 });
            expect(a).toBe(b);
        });

        it('falls back across tiers when a culture pool is exhausted', () => {
            // Unknown culture key → no entries in that tier → widen to fantasy-neutral / whole bank.
            const picked = drawUnusedName({ cultures: ['atlantean'], rng: () => 0 });
            expect(picked).toBeTruthy();
        });

        it('prefers requested gender but allows unisex', () => {
            const picked = drawUnusedName({ cultures: ['japan'], gender: 'f', rng: () => 0.5 });
            expect(picked).toBeTruthy();
            const g = genderOf(picked!);
            expect(g === 'f' || g === 'u').toBe(true);
        });
    });
});
