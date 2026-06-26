import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ContentWithChips } from '../ContentWithChips';

describe('ContentWithChips', () => {
    it('renders plain text with markdown', () => {
        const { container } = render(<ContentWithChips content="Hello **world**" />);
        expect(container.textContent).toContain('Hello');
        expect(container.textContent).toContain('world');
    });

    it('renders dice chip for D20 tags', () => {
        const { container } = render(<ContentWithChips content="[D20: COMBAT=Success]" />);
        expect(container.textContent).toContain('D20: COMBAT=Success');
    });

    it('renders event chip for EVENT tags', () => {
        const { container } = render(<ContentWithChips content="[EVENT: AMBUSH (TENSE)]" />);
        expect(container.textContent).toContain('EVENT: AMBUSH (TENSE)');
    });

    it('renders world chip for WORLD_EVENT tags', () => {
        const { container } = render(<ContentWithChips content="[WORLD_EVENT: war declared]" />);
        expect(container.textContent).toContain('WORLD_EVENT: war declared');
    });

    it('renders mixed content with chips and text', () => {
        const { container } = render(<ContentWithChips content="You enter the cave. [D20: COMBAT=Failure] The goblin attacks!" />);
        expect(container.textContent).toContain('You enter the cave.');
        expect(container.textContent).toContain('D20: COMBAT=Failure');
        expect(container.textContent).toContain('The goblin attacks!');
    });

    it('renders SURPRISE tag as event chip', () => {
        const { container } = render(<ContentWithChips content="[SURPRISE EVENT: ODD_SOUND (CURIOUS)]" />);
        expect(container.textContent).toContain('SURPRISE EVENT: ODD_SOUND (CURIOUS)');
    });

    it('renders ENCOUNTER tag as event chip', () => {
        const { container } = render(<ContentWithChips content="[ENCOUNTER EVENT: AMBUSH]" />);
        expect(container.textContent).toContain('ENCOUNTER EVENT: AMBUSH');
    });

    it('renders DICE OUTCOMES as dice chip', () => {
        const { container } = render(<ContentWithChips content="[DICE OUTCOMES: COMBAT=(...)]" />);
        expect(container.textContent).toContain('DICE OUTCOMES: COMBAT=(...)');
    });

    it('renders [**Name**] as inline bold, kept in the same line as its sentence', () => {
        const { container } = render(<ContentWithChips content="[**Vance**] drew his blade." />);
        const strong = container.querySelector('strong');
        expect(strong).not.toBeNull();
        expect(strong!.textContent).toBe('Vance');
        // Name and sentence flow inside ONE paragraph — no block break, space preserved.
        expect(container.querySelectorAll('p')).toHaveLength(1);
        expect(container.textContent).toBe('Vance drew his blade.');
        expect(container.textContent).not.toContain('[');
        expect(container.textContent).not.toContain('**');
    });

    it('renders plain [Name] as inline bold', () => {
        const { container } = render(<ContentWithChips content="[Noir] nodded." />);
        const strong = container.querySelector('strong');
        expect(strong!.textContent).toBe('Noir');
        expect(container.querySelectorAll('p')).toHaveLength(1);
        expect(container.textContent).toBe('Noir nodded.');
    });

    it('keeps multi-word names inline on one line', () => {
        const { container } = render(<ContentWithChips content="The contact, [**Kael Druen**], waited." />);
        const strong = container.querySelector('strong');
        expect(strong!.textContent).toBe('Kael Druen');
        expect(container.querySelectorAll('p')).toHaveLength(1);
        expect(container.textContent).toBe('The contact, Kael Druen, waited.');
    });

    it('restores bold names nested inside an italic block (no NUL corruption)', () => {
        const content =
            'The Mason — [**Claud**], or [**Sofia**] — note. *Track 1. The Mason — [**Claud**], or [**Sofia**]’s, or [**Cleo**]’s — done.*';
        const { container } = render(<ContentWithChips content={content} />);
        // The italic-nested names must survive as real bold, not raw NUL sentinels.
        expect(container.textContent).not.toContain(String.fromCharCode(0));
        const names = Array.from(container.querySelectorAll('strong')).map((s) => s.textContent);
        expect(names).toContain('Cleo');
        expect(container.querySelector('em')).not.toBeNull();
    });

    it('still renders a colon-bearing tag as a chip even without a known keyword', () => {
        const { container } = render(<ContentWithChips content="[SYSTEM: NPC_ENTRY - Vance]" />);
        expect(container.querySelector('strong')).toBeNull();
        expect(container.textContent).toContain('SYSTEM: NPC_ENTRY - Vance');
    });
});
