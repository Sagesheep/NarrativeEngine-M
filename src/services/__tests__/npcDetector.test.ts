import { describe, it, expect } from 'vitest';
import { extractNPCNames, classifyNPCNames } from '../npc';

describe('npcDetector', () => {
    describe('extractNPCNames', () => {
        // ── Bracketed patterns ─────────────────────────────────────────────
        it('extracts bracketed names', () => {
            const content = 'The merchant [Orin] approaches.';
            const names = extractNPCNames(content);
            expect(names).toContain('Orin');
        });

        it('works with SYSTEM: NPC_ENTRY tags', () => {
            const content = 'The innkeeper is [SYSTEM: NPC_ENTRY - Bram], a kindly fellow.';
            const names = extractNPCNames(content);
            expect(names).toContain('Bram');
        });

        // ── Title-prefix pass ──────────────────────────────────────────────
        it('strips leading titles from prose names', () => {
            const content = 'Captain Aldric drew his sword.';
            const names = extractNPCNames(content);
            expect(names).toContain('Aldric');
            expect(names).not.toContain('Captain Aldric');
        });

        it('strips multiple titles', () => {
            const content = 'Sir Reginald and Lady Elara entered the hall.';
            const names = extractNPCNames(content);
            expect(names).toContain('Reginald');
            expect(names).toContain('Elara');
        });

        it('filters Guard 1 and Clone A style names', () => {
            const content = 'Guard 1 attacks Clone A from the shadows.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('Guard 1');
            expect(names).not.toContain('Clone A');
        });

        it('drops title-only candidates', () => {
            const content = 'Captain stood alone.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('Captain');
        });

        it('extracts title-prefixed instructor name and strips title', () => {
            const content = 'Instructor Roderick Vaul addressed the class.';
            const names = extractNPCNames(content);
            expect(names).toContain('Roderick Vaul');
            expect(names).not.toContain('Instructor Roderick Vaul');
        });

        // ── Speech-tag attribution ─────────────────────────────────────────
        it('extracts names from speech-tag attribution (name then verb)', () => {
            const content = '"Stand down," Aldric commanded. Maren whispered a warning.';
            const names = extractNPCNames(content);
            expect(names).toContain('Aldric');
            expect(names).toContain('Maren');
        });

        it('extracts names from speech-tag attribution (verb then name)', () => {
            const content = '"Move out," said Aldric. She turned to leave.';
            const names = extractNPCNames(content);
            expect(names).toContain('Aldric');
            expect(names).not.toContain('She');
        });

        // ── Apposition / introduction ─────────────────────────────────────
        it('extracts prose proper nouns via role-apposition', () => {
            const content = 'The guard Orin approaches the inn.';
            const names = extractNPCNames(content);
            expect(names).toContain('Orin');
        });

        it('extracts names from role-apposition patterns', () => {
            const content = 'The merchant Orin waved. A man named Bram entered.';
            const names = extractNPCNames(content);
            expect(names).toContain('Orin');
            expect(names).toContain('Bram');
        });

        // ── Connective pass ────────────────────────────────────────────────
        it('keeps names with connectives like "of"', () => {
            const content = 'Aldric of Westhold arrived.';
            const names = extractNPCNames(content);
            expect(names).toContain('Aldric of Westhold');
        });

        // ── Multi-word names require a signal (Pass 7 removed) ─────────────
        it('keeps legit multi-word names introduced with a signal', () => {
            const content = '"Welcome," said Seraphine Thornmere. The knight Dorian Ashworth bowed.';
            const names = extractNPCNames(content);
            expect(names).toContain('Seraphine Thornmere');
            expect(names).toContain('Dorian Ashworth');
        });

        it('drops signal-less Title Case noun phrases (no Pass 7 prose fishing)', () => {
            // These were the real graveyard offenders — capitalized prose with no
            // introduction signal that the old two-cap-token pass turned into NPCs.
            const content = 'They crossed the Inner Courtyard. A Tactical Decision loomed. The Rescue Force mobilized as Standard Convergence held the line.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('Inner Courtyard');
            expect(names).not.toContain('Tactical Decision');
            expect(names).not.toContain('Rescue Force');
            expect(names).not.toContain('Standard Convergence');
        });

        // ── Exclusion / deduplication ──────────────────────────────────────
        it('drops excluded names', () => {
            const content = 'The merchant Lyra met the innkeeper Orin at the inn.';
            const names = extractNPCNames(content, ['Lyra']);
            expect(names).not.toContain('Lyra');
            expect(names).toContain('Orin');
        });

        it('deduplicates repeated names within a single response', () => {
            const content = '"Forward!" Aldric commanded. Aldric struck. Aldric won.';
            const names = extractNPCNames(content);
            const aldricCount = names.filter(n => n === 'Aldric').length;
            expect(aldricCount).toBe(1);
        });

        it('handles multiple names in one passage', () => {
            const content = 'Captain Aldric and Sir Reginald met [Orin] the merchant. "Welcome," Bram said.';
            const names = extractNPCNames(content);
            expect(names).toContain('Aldric');
            expect(names).toContain('Reginald');
            expect(names).toContain('Orin');
            expect(names).toContain('Bram');
        });

        // ── Regression: contractions ───────────────────────────────────────
        it('drops contractions that get capitalized at sentence start', () => {
            const content = "That's the plan. You're not ready. It's too late. Haven't you heard? Don't go.";
            const names = extractNPCNames(content);
            expect(names).not.toContain("That's");
            expect(names).not.toContain("You're");
            expect(names).not.toContain("It's");
            expect(names).not.toContain("Haven't");
            expect(names).not.toContain("Don't");
        });

        // ── Regression: single-word noise ─────────────────────────────────
        it('drops single capitalized words with no introduction signal', () => {
            const content = 'Threat approached. Take cover! Squad scattered. Danger lurked.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('Threat');
            expect(names).not.toContain('Take');
            expect(names).not.toContain('Squad');
            expect(names).not.toContain('Danger');
        });

        it('drops dice mechanics terms that get capitalized', () => {
            const content = 'Disadvantage Catastrophe! The blade slips. A Normal Failure follows. Triumph eludes you.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('Catastrophe');
            expect(names).not.toContain('Failure');
            expect(names).not.toContain('Triumph');
            expect(names).not.toContain('Disadvantage Catastrophe');
            expect(names).not.toContain('Normal Failure');
        });

        it('drops common sentence-initial words that get capitalized', () => {
            const content = 'Two guards stood watch. Not a sound. Every breath was tense. Equipment lay strewn. Academy training kicked in.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('Two');
            expect(names).not.toContain('Not');
            expect(names).not.toContain('Every');
            expect(names).not.toContain('Equipment');
            expect(names).not.toContain('Academy');
        });

        // ── Regression: organization / institution names ───────────────────
        it('drops organization names like Convergence Business Office', () => {
            const content = 'They entered the Convergence Business Office. The Merchant Guild was closed.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('Convergence Business Office');
            expect(names).not.toContain('Convergence Business');
            expect(names).not.toContain('Business Office');
            expect(names).not.toContain('Merchant Guild');
        });

        it('filters common blocklisted words', () => {
            const content = 'The man and The woman talk. "Well met," said Orin.';
            const names = extractNPCNames(content);
            expect(names).not.toContain('The');
            expect(names).toContain('Orin');
        });
    });

    describe('classifyNPCNames', () => {
        it('marks unknown names as new', () => {
            const names = ['Aldric', 'Orin'];
            const ledger: any[] = [];
            const { newNames, existingNpcs } = classifyNPCNames(names, ledger);
            expect(newNames).toEqual(['Aldric', 'Orin']);
            expect(existingNpcs).toEqual([]);
        });

        it('matches existing NPC by exact name', () => {
            const names = ['Orin'];
            const ledger: any[] = [{ name: 'Orin', aliases: '' }];
            const { newNames, existingNpcs } = classifyNPCNames(names, ledger);
            expect(newNames).toEqual([]);
            expect(existingNpcs).toHaveLength(1);
        });

        it('matches epithet variants against existing ledger names', () => {
            const names = ['Aldric the Younger'];
            const ledger: any[] = [{ name: 'Aldric', aliases: '' }];
            const { newNames, existingNpcs } = classifyNPCNames(names, ledger);
            expect(newNames).toEqual([]);
            expect(existingNpcs).toHaveLength(1);
            expect(existingNpcs[0].name).toBe('Aldric');
        });

        it('matches full-name variants against a first-name-only ledger entry', () => {
            const names = ['Maren Blackwood'];
            const ledger: any[] = [{ name: 'Maren', aliases: '' }];
            const { newNames, existingNpcs } = classifyNPCNames(names, ledger);
            expect(newNames).toEqual([]);
            expect(existingNpcs).toHaveLength(1);
        });

        it('still treats genuinely new names as new', () => {
            const names = ['Thorne'];
            const ledger: any[] = [{ name: 'Aldric', aliases: '' }];
            const { newNames } = classifyNPCNames(names, ledger);
            expect(newNames).toEqual(['Thorne']);
        });

        it('respects exclude list', () => {
            const names = ['Lyra', 'Orin'];
            const ledger: any[] = [];
            const { newNames } = classifyNPCNames(names, ledger, ['Lyra']);
            expect(newNames).toEqual(['Orin']);
        });

        it('normalizes all-caps names to title case', () => {
            const names = ['ALDRIC'];
            const ledger: any[] = [];
            const { newNames } = classifyNPCNames(names, ledger);
            expect(newNames).toEqual(['Aldric']);
        });
    });
});
