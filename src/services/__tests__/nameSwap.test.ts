import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../types';
import { detectCollisions, decideSwap, applySwap, swapDuplicateNames } from '../npc';

// Minimal NPCEntry fixture — only the fields the swap logic reads matter.
function npc(partial: Partial<NPCEntry> & { id: string; name: string }): NPCEntry {
    return {
        aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '',
        status: '', goals: '', voice: '', personality: '', exampleOutput: '', affinity: 50,
        ...partial,
    } as NPCEntry;
}

describe('nameSwap', () => {
    describe('detectCollisions (first-name keyed)', () => {
        it('flags a same-first-name collision', () => {
            const ledger = [npc({ id: 'n1', name: 'Voss' })];
            const cols = detectCollisions(['Voss'], ledger);
            expect(cols).toHaveLength(1);
            expect(cols[0].npc.id).toBe('n1');
        });

        it('respects the relation exception — shared surname, different first name is NOT a collision', () => {
            const ledger = [npc({ id: 'n1', name: 'Rick Ashwood' })];
            const cols = detectCollisions(['John Ashwood'], ledger);
            expect(cols).toHaveLength(0);
        });

        it('matches an introduced full name against a ledger first name', () => {
            const ledger = [npc({ id: 'n1', name: 'Voss' })];
            const cols = detectCollisions(['Voss the Younger'], ledger);
            expect(cols).toHaveLength(1);
        });

        it('matches against aliases', () => {
            const ledger = [npc({ id: 'n1', name: 'Sera', aliases: 'The Hawk, Maren' })];
            const cols = detectCollisions(['Maren'], ledger);
            expect(cols).toHaveLength(1);
        });
    });

    describe('decideSwap (the decision table)', () => {
        const base = npc({ id: 'n1', name: 'Voss' });

        it('row 1: on-stage NPC → leave (hard veto)', () => {
            expect(decideSwap({ npc: base, onStage: true, inPayload: true })).toBe('leave');
        });

        it('PC → leave', () => {
            expect(decideSwap({ npc: npc({ id: 'pc', name: 'Voss', isPC: true }), onStage: false, inPayload: false })).toBe('leave');
        });

        it('row 2: not in payload → confident swap', () => {
            expect(decideSwap({ npc: base, onStage: false, inPayload: false })).toBe('swap');
        });

        it('row 3: dead (status text) → swap', () => {
            expect(decideSwap({ npc: npc({ id: 'n1', name: 'Voss', status: 'was slain' }), onStage: false, inPayload: true })).toBe('swap');
        });

        it('row 3: dead (condition) → swap', () => {
            expect(decideSwap({ npc: npc({ id: 'n1', name: 'Voss', condition: 'dead' }), onStage: false, inPayload: true })).toBe('swap');
        });

        it('rows 4/5/6: in payload, off-stage, alive → flag (bias to non-destructive)', () => {
            expect(decideSwap({ npc: base, onStage: false, inPayload: true })).toBe('flag');
        });
    });

    describe('applySwap', () => {
        it('replaces whole-word occurrences including possessive', () => {
            const out = applySwap("Voss drew his blade. Voss's grin widened.", 'voss', 'Maddox');
            expect(out).toBe("Maddox drew his blade. Maddox's grin widened.");
        });

        it('does not replace substrings', () => {
            const out = applySwap('The albatross circled.', 'ross', 'Maddox');
            expect(out).toBe('The albatross circled.');
        });
    });

    describe('swapDuplicateNames (integration)', () => {
        const rng = () => 0; // deterministic draw

        it('swaps a coincidence-mint duplicate (off-stage, not in payload)', () => {
            const ledger = [npc({ id: 'n1', name: 'Voss' })];
            const text = 'A grizzled man named Voss stepped out of the shadows.';
            const res = swapDuplicateNames(text, { ledger, onStageNpcIds: [], activeNpcIds: [], rng });
            expect(res.swaps).toHaveLength(1);
            expect(res.text).not.toMatch(/\bVoss\b/);
        });

        it('leaves a reference to an on-stage NPC untouched', () => {
            const ledger = [npc({ id: 'n1', name: 'Voss' })];
            const text = 'Voss said, "Welcome back."';
            const res = swapDuplicateNames(text, { ledger, onStageNpcIds: ['n1'], activeNpcIds: ['n1'], rng });
            expect(res.swaps).toHaveLength(0);
            expect(res.text).toBe(text);
        });

        it('flags the gray zone (in payload, off-stage) without rewriting', () => {
            const ledger = [npc({ id: 'n1', name: 'Voss' })];
            const text = 'A man named Voss approached the gate.';
            const res = swapDuplicateNames(text, { ledger, onStageNpcIds: [], activeNpcIds: ['n1'], rng });
            expect(res.swaps).toHaveLength(0);
            expect(res.flags).toHaveLength(1);
            expect(res.text).toBe(text);
        });

        it('does not confidently swap when the payload signal is unavailable', () => {
            const ledger = [npc({ id: 'n1', name: 'Voss' })];
            const text = 'A man named Voss approached the gate.';
            // activeNpcIds undefined → unknown → treat as in-payload → flag, never blind swap
            const res = swapDuplicateNames(text, { ledger, onStageNpcIds: [], rng });
            expect(res.swaps).toHaveLength(0);
            expect(res.flags).toHaveLength(1);
        });

        it('no collision → text unchanged', () => {
            const ledger = [npc({ id: 'n1', name: 'Aldric' })];
            const text = 'A man named Voss approached the gate.';
            const res = swapDuplicateNames(text, { ledger, onStageNpcIds: [], activeNpcIds: [], rng });
            expect(res.swaps).toHaveLength(0);
            expect(res.flags).toHaveLength(0);
            expect(res.text).toBe(text);
        });
    });
});
