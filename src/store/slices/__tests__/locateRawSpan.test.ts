import { describe, it, expect } from 'vitest';
import { locateRawSpan } from '../chatSlice';

// Helper: locate the span, then splice in the replacement the way replaceMessageText does.
function splice(raw: string, selected: string, replacement: string): string | null {
    const span = locateRawSpan(raw, selected);
    if (!span) return null;
    return raw.slice(0, span.start) + replacement + raw.slice(span.end);
}

describe('locateRawSpan', () => {
    it('matches plain prose exactly', () => {
        const raw = 'The keep is called Stormhold.';
        expect(splice(raw, 'The keep is called Stormhold.', 'The keep is called Ironhold.'))
            .toBe('The keep is called Ironhold.');
    });

    it('matches across bold markdown the renderer stripped', () => {
        const raw = 'Aldric drew his **gleaming** blade.';
        // The DOM/selection has no asterisks.
        expect(splice(raw, 'Aldric drew his gleaming blade.', 'Aldric drew his rusty blade.'))
            .toBe('Aldric drew his rusty blade.');
    });

    it('matches a sentence containing a bracketed NPC name and swallows the brackets', () => {
        const raw = '[**Aldric**] drew his blade at dawn.';
        // Selection renders as "Aldric drew his blade at dawn."
        const out = splice(raw, 'Aldric drew his blade at dawn.', 'Aldric sheathed his blade at dawn.');
        expect(out).toBe('Aldric sheathed his blade at dawn.');
        // No orphaned markdown left behind.
        expect(out).not.toMatch(/[*[\]]/);
    });

    it('tolerates whitespace differences (collapsed newlines)', () => {
        const raw = 'He paused.\n\nThen he spoke softly.';
        expect(splice(raw, 'Then he spoke softly.', 'Then he shouted.'))
            .toBe('He paused.\n\nThen he shouted.');
    });

    it('returns null when the text is genuinely absent', () => {
        expect(locateRawSpan('Nothing relevant here.', 'A completely different sentence.')).toBeNull();
    });

    it('preserves surrounding raw markdown outside the matched span', () => {
        const raw = 'Before. [**Mira**] cast a spell of fire. *After.*';
        const out = splice(raw, 'Mira cast a spell of fire.', 'Mira cast a spell of ice.');
        expect(out).toBe('Before. Mira cast a spell of ice. *After.*');
    });
});
