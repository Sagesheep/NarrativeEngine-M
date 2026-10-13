import type { CSSProperties } from 'react';
import type { AppSettings, ReadingFont, ReadingLeading } from '../../types';

/**
 * Story typography — the story text's own settings, separate from UI Scale.
 * Mobile port of mainApp's readingPrefs.ts: font, size and line spacing only
 * (a phone's story column is always full width, so desktop's width and
 * alignment controls don't apply).
 *
 * UI Scale zooms the whole interface; these set only the GM's story text, as
 * CSS variables read by `.gm-prose` (index.css). Both multiply. Defaults match
 * the story's look before this setting existed (mono, 14px, relaxed).
 */

export const READING_FONTS: { value: ReadingFont; label: string; family: string }[] = [
    { value: 'mono', label: 'Mono', family: 'var(--font-mono)' },
    { value: 'serif', label: 'Serif', family: `'Noto Serif', Georgia, serif, 'Noto Color Emoji', 'Noto Sans Symbols2', 'Segoe UI Emoji'` },
    { value: 'sans', label: 'Sans', family: `Roboto, 'Segoe UI', system-ui, sans-serif, 'Noto Color Emoji', 'Noto Sans Symbols2', 'Segoe UI Emoji'` },
];

export const READING_LEADINGS: { value: ReadingLeading; label: string; lineHeight: number }[] = [
    { value: 'tight', label: 'Tight', lineHeight: 1.4 },
    { value: 'normal', label: 'Normal', lineHeight: 1.55 },
    { value: 'relaxed', label: 'Relaxed', lineHeight: 1.75 },
];

export const READING_SIZE_MIN = 12;
export const READING_SIZE_MAX = 22;

export const READING_DEFAULTS = {
    readingFont: 'mono' as ReadingFont,
    readingSize: 14,
    readingLeading: 'relaxed' as ReadingLeading,
};

export function clampReadingSize(size: unknown): number {
    const n = typeof size === 'number' && Number.isFinite(size) ? Math.round(size) : READING_DEFAULTS.readingSize;
    return Math.min(READING_SIZE_MAX, Math.max(READING_SIZE_MIN, n));
}

export function normalizeReadingFont(v: unknown): ReadingFont {
    return READING_FONTS.some(o => o.value === v) ? (v as ReadingFont) : READING_DEFAULTS.readingFont;
}

export function normalizeReadingLeading(v: unknown): ReadingLeading {
    return READING_LEADINGS.some(o => o.value === v) ? (v as ReadingLeading) : READING_DEFAULTS.readingLeading;
}

type ReadingSettings = Pick<AppSettings, 'readingFont' | 'readingSize' | 'readingLeading'>;

/** The CSS variables the story text reads. Unknown values fall back to defaults. */
export function readingStyleVars(settings: ReadingSettings | null | undefined): CSSProperties {
    const font = READING_FONTS.find(o => o.value === normalizeReadingFont(settings?.readingFont))!;
    const leading = READING_LEADINGS.find(o => o.value === normalizeReadingLeading(settings?.readingLeading))!;
    return {
        '--reading-size': `${clampReadingSize(settings?.readingSize)}px`,
        '--reading-leading': String(leading.lineHeight),
        '--reading-font': font.family,
    } as CSSProperties;
}
