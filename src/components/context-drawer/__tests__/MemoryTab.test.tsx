import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryTab } from '../MemoryTab';
import { useAppStore } from '../../../store/useAppStore';
import { buildNpcNameMap, matchesFactFilter } from '../memoryTabHelpers';
import type { DivergenceEntry, DivergenceRegister, NPCEntry } from '../../../types';

const fact = (n: number, overrides: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id: `f${n}`,
    chapterId: 'CH01',
    category: 'world_state',
    text: `Fact number ${n}`,
    sceneRef: String(n).padStart(3, '0'),
    npcIds: [],
    pinned: false,
    source: 'auto',
    ...overrides,
});

const register = (entries: DivergenceEntry[]): DivergenceRegister => ({
    entries, chapterToggles: {}, categoryToggles: {},
    lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2,
});

describe('matchesFactFilter', () => {
    const npcNames = buildNpcNameMap([{ id: 'n1', name: 'Mira' } as NPCEntry]);

    it('searches text, subject token and knower names case-insensitively', () => {
        expect(matchesFactFilter(fact(1, { text: 'The bridge burned' }), 'all', 'BRIDGE', npcNames)).toBe(true);
        expect(matchesFactFilter(fact(1, { subjectToken: 'mira.status' }), 'all', 'mira', npcNames)).toBe(true);
        expect(matchesFactFilter(fact(1, { knownBy: ['npc:n1'] }), 'all', 'mira', npcNames)).toBe(true);
        expect(matchesFactFilter(fact(1), 'all', 'mira', npcNames)).toBe(false);
    });

    it('applies the status filter', () => {
        expect(matchesFactFilter(fact(1, { enabled: false }), 'disabled', '', npcNames)).toBe(true);
        expect(matchesFactFilter(fact(1), 'disabled', '', npcNames)).toBe(false);
        expect(matchesFactFilter(fact(1, { status: 'superseded' }), 'replaced', '', npcNames)).toBe(true);
        expect(matchesFactFilter(fact(1, { knownBy: [] }), 'secret', '', npcNames)).toBe(true);
        expect(matchesFactFilter(fact(1), 'secret', '', npcNames)).toBe(false);
    });
});

describe('MemoryTab', () => {
    beforeEach(() => {
        const entries = Array.from({ length: 120 }, (_, i) => fact(i + 1));
        entries.push(fact(500, { text: 'Mira owes the guild', subjectToken: 'mira.debt' }));
        useAppStore.setState({ divergenceRegister: register(entries), chapters: [], npcLedger: [] });
    });

    it('pages large groups instead of rendering every fact', () => {
        render(<MemoryTab />);
        fireEvent.click(screen.getByText('CH01'));
        fireEvent.click(screen.getByText('WORLD STATE'));
        expect(screen.getByText('Fact number 1')).toBeTruthy();
        expect(screen.queryByText('Fact number 51')).toBeNull();
        fireEvent.click(screen.getByText(/Show 50 more/));
        expect(screen.getByText('Fact number 51')).toBeTruthy();
    });

    it('folds untagged facts into one Ungrouped bucket in the subject view', () => {
        render(<MemoryTab />);
        fireEvent.click(screen.getByText('By Subject'));
        expect(screen.getByText('Ungrouped')).toBeTruthy();
        expect(screen.getByText('120 facts')).toBeTruthy();
        expect(screen.getByText('Mira · Debt')).toBeTruthy();
    });

    it('search shows a flat list of matches', async () => {
        render(<MemoryTab />);
        fireEvent.change(screen.getByPlaceholderText(/Search facts/), { target: { value: 'guild' } });
        await waitFor(() => expect(screen.getByText('1 match')).toBeTruthy());
        expect(screen.getByText('Mira owes the guild')).toBeTruthy();
    });
});
