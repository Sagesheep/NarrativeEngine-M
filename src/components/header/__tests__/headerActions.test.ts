import { describe, it, expect } from 'vitest';
import {
    HEADER_ACTIONS,
    DEFAULT_HEADER_SHORTCUTS,
    normalizeHeaderShortcuts,
    toggleHeaderShortcut,
    moveHeaderShortcut,
    contextTabOf,
} from '../headerActions';
import { CONTEXT_TABS } from '../../context-drawer/contextTabs';
import { migrateSettings } from '../../../store/settingsMigration';

describe('headerActions', () => {
    it('has unique ids and a shortcut for every context drawer tab', () => {
        const ids = HEADER_ACTIONS.map(a => a.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const tab of CONTEXT_TABS) expect(ids).toContain(`tab:${tab.id}`);
    });

    it('maps a tab action back to its drawer tab', () => {
        expect(contextTabOf('tab:notes')).toBe('notes');
        expect(contextTabOf('tab:rules-mgr')).toBe('rules-mgr');
    });

    describe('normalizeHeaderShortcuts', () => {
        it('falls back to the default for missing or non-list values', () => {
            expect(normalizeHeaderShortcuts(undefined)).toEqual(DEFAULT_HEADER_SHORTCUTS);
            expect(normalizeHeaderShortcuts('dice')).toEqual(DEFAULT_HEADER_SHORTCUTS);
        });

        it('keeps an empty list (everything in the menu)', () => {
            expect(normalizeHeaderShortcuts([])).toEqual([]);
        });

        it('drops unknown and duplicate ids, keeping order', () => {
            expect(normalizeHeaderShortcuts(['tab:notes', 'bogus', 'dice', 'tab:notes', 42])).toEqual(['tab:notes', 'dice']);
        });

        it('is applied when settings load', () => {
            expect(migrateSettings({ settings: {} }).headerShortcuts).toEqual(DEFAULT_HEADER_SHORTCUTS);
            expect(migrateSettings({ settings: { headerShortcuts: ['tab:notes', 'nope'] } }).headerShortcuts).toEqual(['tab:notes']);
        });
    });

    it('toggles an action into the end of the bar and back out', () => {
        const shown = toggleHeaderShortcut(['dice'], 'tab:notes');
        expect(shown).toEqual(['dice', 'tab:notes']);
        expect(toggleHeaderShortcut(shown, 'dice')).toEqual(['tab:notes']);
    });

    describe('moveHeaderShortcut', () => {
        it('swaps with the neighbour', () => {
            expect(moveHeaderShortcut(['dice', 'pin', 'tab:notes'], 'tab:notes', -1)).toEqual(['dice', 'tab:notes', 'pin']);
            expect(moveHeaderShortcut(['dice', 'pin', 'tab:notes'], 'dice', 1)).toEqual(['pin', 'dice', 'tab:notes']);
        });

        it('ignores moves past either end or of a hidden action', () => {
            expect(moveHeaderShortcut(['dice', 'pin'], 'dice', -1)).toEqual(['dice', 'pin']);
            expect(moveHeaderShortcut(['dice', 'pin'], 'pin', 1)).toEqual(['dice', 'pin']);
            expect(moveHeaderShortcut(['dice', 'pin'], 'loot', 1)).toEqual(['dice', 'pin']);
        });
    });
});
