import { describe, it, expect } from 'vitest';
import { readingStyleVars, clampReadingSize, READING_DEFAULTS } from '../readingPrefs';
import { migrateSettings } from '../../../store/settingsMigration';

describe('story text settings', () => {
    it('defaults reproduce the pre-setting look (mono, 14px, relaxed)', () => {
        const vars = readingStyleVars(undefined) as Record<string, string>;
        expect(vars['--reading-size']).toBe('14px');
        expect(vars['--reading-leading']).toBe('1.75');
        expect(vars['--reading-font']).toBe('var(--font-mono)');
    });

    it('clamps size and falls back on unknown values', () => {
        expect(clampReadingSize(40)).toBe(22);
        expect(clampReadingSize(3)).toBe(12);
        expect(clampReadingSize('big')).toBe(READING_DEFAULTS.readingSize);
        const vars = readingStyleVars({ readingFont: 'comic' as never, readingLeading: 'loose' as never, readingSize: 18 }) as Record<string, string>;
        expect(vars['--reading-size']).toBe('18px');
        expect(vars['--reading-leading']).toBe('1.75');
        expect(vars['--reading-font']).toBe('var(--font-mono)');
    });

    it('old saved settings migrate to the defaults', () => {
        const migrated = migrateSettings({ contextLimit: 8192 });
        expect(migrated).toMatchObject({ readingFont: 'mono', readingSize: 14, readingLeading: 'relaxed' });
    });
});
