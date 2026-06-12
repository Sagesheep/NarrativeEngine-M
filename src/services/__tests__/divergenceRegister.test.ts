import { describe, it, expect } from 'vitest';
import {
    EMPTY_REGISTER,
    coerceCategory,
    toggleChapter,
    toggleCategory,
    pinFact,
    editFact,
    deleteFact,
    dismissReviewFlag,
    getEntriesForNpc,
    mergeSealEntries,
    renderRegisterForPayload,
    stripReasoning,
    countRegisterTokens,
} from '../campaign-state';
import type { DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveChapter, NPCEntry } from '../../types';

const makeEntry = (overrides: Partial<DivergenceEntry> & { id: string; chapterId: string; category: DivergenceCategory; text: string; sceneRef: string }): DivergenceEntry => ({
    npcIds: [],
    pinned: false,
    source: 'auto',
    ...overrides,
});

describe('divergenceRegister', () => {
    describe('coerceCategory', () => {
        it('maps known categories to themselves', () => {
            expect(coerceCategory('locations')).toBe('locations');
            expect(coerceCategory('npc_events')).toBe('npc_events');
            expect(coerceCategory('promises_debts')).toBe('promises_debts');
            expect(coerceCategory('world_state')).toBe('world_state');
            expect(coerceCategory('party_facts')).toBe('party_facts');
            expect(coerceCategory('rules_lore')).toBe('rules_lore');
            expect(coerceCategory('misc')).toBe('misc');
        });

        it('normalizes spacing and hyphens', () => {
            expect(coerceCategory('NPC Events')).toBe('npc_events');
            expect(coerceCategory('promises-debts')).toBe('promises_debts');
            expect(coerceCategory('  WORLD STATE  ')).toBe('world_state');
            expect(coerceCategory('Rules Lore')).toBe('rules_lore');
        });

        it('falls back to misc for unknown categories', () => {
            expect(coerceCategory('quests')).toBe('misc');
            expect(coerceCategory('')).toBe('misc');
            expect(coerceCategory('random_junk')).toBe('misc');
        });
    });

    describe('toggleChapter and toggleCategory', () => {
        const entry1 = makeEntry({ id: 'e1', chapterId: 'ch1', category: 'locations', text: 'Gate destroyed', sceneRef: '001' });
        const entry2 = makeEntry({ id: 'e2', chapterId: 'ch1', category: 'npc_events', text: 'Grak allied', sceneRef: '002', npcIds: ['npc_1'] });
        const reg: DivergenceRegister = { ...EMPTY_REGISTER, entries: [entry1, entry2] };

        it('toggles a chapter off', () => {
            const toggled = toggleChapter(reg, 'ch1', false);
            expect(toggled.chapterToggles['ch1']).toBe(false);
        });

        it('toggles a chapter back on', () => {
            const off = toggleChapter(reg, 'ch1', false);
            const back = toggleChapter(off, 'ch1', true);
            expect(back.chapterToggles['ch1']).toBe(true);
        });

        it('toggles a category off within a chapter', () => {
            const toggled = toggleCategory(reg, 'ch1', 'locations', false);
            expect(toggled.categoryToggles['ch1']?.['locations']).toBe(false);
        });

        it('toggles a category back on', () => {
            const off = toggleCategory(reg, 'ch1', 'locations', false);
            const back = toggleCategory(off, 'ch1', 'locations', true);
            expect(back.categoryToggles['ch1']?.['locations']).toBe(true);
        });
    });

    describe('pinFact, editFact, deleteFact', () => {
        const entry1 = makeEntry({ id: 'e1', chapterId: 'ch1', category: 'locations', text: 'Gate destroyed', sceneRef: '001' });
        const reg: DivergenceRegister = { ...EMPTY_REGISTER, entries: [entry1] };

        it('pins a fact (toggles pinned true)', () => {
            const pinned = pinFact(reg, 'e1');
            expect(pinned.entries[0].pinned).toBe(true);
        });

        it('unpins a fact (toggles pinned back to false)', () => {
            const pinned = pinFact(reg, 'e1');
            const unpinned = pinFact(pinned, 'e1');
            expect(unpinned.entries[0].pinned).toBe(false);
        });

        it('edits fact text and marks source as manual', () => {
            const edited = editFact(reg, 'e1', 'Gate rebuilt');
            expect(edited.entries[0].text).toBe('Gate rebuilt');
            expect(edited.entries[0].source).toBe('manual');
        });

        it('deletes a fact', () => {
            const deleted = deleteFact(reg, 'e1');
            expect(deleted.entries).toHaveLength(0);
        });

        it('pinFact on nonexistent id is a no-op', () => {
            const result = pinFact(reg, 'nonexistent');
            expect(result.entries[0].pinned).toBe(false);
        });

        it('editFact on nonexistent id is a no-op', () => {
            const result = editFact(reg, 'nonexistent', 'new text');
            expect(result.entries[0].text).toBe('Gate destroyed');
        });

        it('deleteFact on nonexistent id is a no-op', () => {
            const result = deleteFact(reg, 'nonexistent');
            expect(result.entries).toHaveLength(1);
        });
    });

    describe('dismissReviewFlag and getEntriesForNpc', () => {
        const entry1 = makeEntry({
            id: 'e1', chapterId: 'ch1', category: 'npc_events', text: 'Grak allied', sceneRef: '002',
            npcIds: ['npc_grak'],
        });
        const entry2 = makeEntry({
            id: 'e2', chapterId: 'ch1', category: 'npc_events', text: 'Shadow Blade acquired', sceneRef: '003',
            npcIds: ['npc_grak', 'npc_smith'],
            reviewFlag: true,
            unrecognizedNpcNames: ['The Stranger'],
        });
        const reg: DivergenceRegister = { ...EMPTY_REGISTER, entries: [entry1, entry2] };

        it('dismisses review flag and clears unrecognizedNpcNames', () => {
            const dismissed = dismissReviewFlag(reg, 'e2');
            const e2 = dismissed.entries.find(e => e.id === 'e2')!;
            expect(e2.reviewFlag).toBeUndefined();
            expect(e2.unrecognizedNpcNames).toBeUndefined();
        });

        it('getEntriesForNpc returns entries referencing that NPC', () => {
            const grakEntries = getEntriesForNpc(reg, 'npc_grak');
            expect(grakEntries).toHaveLength(2);
            expect(grakEntries.map(e => e.id)).toContain('e1');
            expect(grakEntries.map(e => e.id)).toContain('e2');
        });

        it('getEntriesForNpc returns entries for a different NPC', () => {
            const smithEntries = getEntriesForNpc(reg, 'npc_smith');
            expect(smithEntries).toHaveLength(1);
            expect(smithEntries[0].id).toBe('e2');
        });

        it('getEntriesForNpc returns empty for unknown NPC', () => {
            expect(getEntriesForNpc(reg, 'npc_unknown')).toHaveLength(0);
        });
    });

    describe('mergeSealEntries and renderRegisterForPayload', () => {
        it('merges new entries into register', () => {
            const newEntries: DivergenceEntry[] = [
                makeEntry({ id: 'div_1', chapterId: 'ch1', category: 'locations', text: 'Tavern burned', sceneRef: '010' }),
                makeEntry({ id: 'div_2', chapterId: 'ch1', category: 'npc_events', text: 'Grak died', sceneRef: '011', npcIds: ['npc_grak'] }),
            ];
            const merged = mergeSealEntries(EMPTY_REGISTER, newEntries, '011');
            expect(merged.entries).toHaveLength(2);
            expect(merged.lastUpdatedSceneId).toBe('011');
            expect(merged.version).toBe(2);
        });

        it('renders register for payload with chapters', () => {
            const entries: DivergenceEntry[] = [
                makeEntry({ id: 'e1', chapterId: 'ch_battle', category: 'locations', text: 'Gate destroyed', sceneRef: '001', pinned: true }),
                makeEntry({ id: 'e2', chapterId: 'ch_battle', category: 'npc_events', text: 'Grak allied', sceneRef: '002', npcIds: ['npc_grak'] }),
            ];
            const reg: DivergenceRegister = { ...EMPTY_REGISTER, entries };
            const chapters = [
                { chapterId: 'ch_battle', title: 'The Siege', sceneRange: ['001', '015'] as [string, string], sceneIds: ['001', '002', '003'], sealedAt: Date.now(), sceneCount: 3, summary: 'Battle chapter', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: 'combat-heavy', themes: [] },
            ];
            const rendered = renderRegisterForPayload(reg, chapters);
            expect(rendered).toContain('[ESTABLISHED FACTS]');
            expect(rendered).toContain('The Siege');
            expect(rendered).toContain('LOCATIONS');
            expect(rendered).toContain('Gate destroyed');
            expect(rendered).toContain('NPC EVENTS');
            expect(rendered).toContain('Grak allied');
            expect(rendered).toContain('★');
            expect(rendered).toContain('[END ESTABLISHED FACTS]');
        });

        it('renders empty string for empty register', () => {
            expect(renderRegisterForPayload(EMPTY_REGISTER)).toBe('');
        });

        it('respects chapter and category toggles in rendering', () => {
            const entries: DivergenceEntry[] = [
                makeEntry({ id: 'e1', chapterId: 'ch1', category: 'locations', text: 'Gate destroyed', sceneRef: '001' }),
                makeEntry({ id: 'e2', chapterId: 'ch1', category: 'npc_events', text: 'Grak allied', sceneRef: '002' }),
            ];
            const regWithChapterOff: DivergenceRegister = {
                ...EMPTY_REGISTER,
                entries,
                chapterToggles: { ch1: false },
            };
            const rendered = renderRegisterForPayload(regWithChapterOff);
            expect(rendered).toBe('');

            const regWithCatOff: DivergenceRegister = {
                ...EMPTY_REGISTER,
                entries,
                categoryToggles: { ch1: { locations: false } as Partial<Record<DivergenceCategory, boolean>> } as Record<string, Record<DivergenceCategory, boolean>>,
            };
            const rendered2 = renderRegisterForPayload(regWithCatOff);
            expect(rendered2).toContain('Grak allied');
            expect(rendered2).not.toContain('Gate destroyed');
        });

        it('always renders pinned entries regardless of toggles', () => {
            const entries: DivergenceEntry[] = [
                makeEntry({ id: 'e1', chapterId: 'ch1', category: 'locations', text: 'Gate destroyed', sceneRef: '001', pinned: true }),
            ];
            const reg: DivergenceRegister = {
                ...EMPTY_REGISTER,
                entries,
                chapterToggles: { ch1: false },
            };
            const rendered = renderRegisterForPayload(reg);
            expect(rendered).toContain('Gate destroyed');
        });
    });

    describe('stripReasoning', () => {
        it('strips think blocks', () => {
            const input = '<think>I am reasoning</think>Actual output';
            expect(stripReasoning(input)).toBe('Actual output');
        });

        it('extracts JSON from markdown code fences', () => {
            const input = '```json\n{"key": "value"}\n```';
            expect(stripReasoning(input)).toBe('{"key": "value"}');
        });

        it('returns trimmed input when no fences or think blocks', () => {
            expect(stripReasoning('  plain text  ')).toBe('plain text');
        });
    });

    describe('token budget with 50+ scene fixture', () => {
        it('renders and counts tokens for a 50-scene register within default budget', () => {
            const categories: DivergenceCategory[] = ['locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc'];
            const entries: DivergenceEntry[] = [];

            for (let ch = 0; ch < 5; ch++) {
                const chapterId = `ch_${ch}`;
                for (let sc = 0; sc < 10; sc++) {
                    const sceneRef = String(ch * 10 + sc).padStart(3, '0');
                    const cat = categories[(ch * 10 + sc) % categories.length];
                    entries.push(makeEntry({
                        id: `div_${ch}_${sc}`,
                        chapterId,
                        category: cat,
                        text: `Fact from chapter ${ch} scene ${sc}: something important happened that would break continuity if contradicted`,
                        sceneRef,
                        npcIds: sc % 3 === 0 ? [`npc_${sc}`] : [],
                    }));
                }
            }

            const reg: DivergenceRegister = { ...EMPTY_REGISTER, entries };

            const chapters: ArchiveChapter[] = Array.from({ length: 5 }, (_, i) => ({
                chapterId: `ch_${i}`,
                title: `Chapter ${i + 1}: The ${['Siege', 'Journey', 'Betrayal', 'Reckoning', 'Dawn'][i]}`,
                sceneRange: [String(i * 10).padStart(3, '0'), String(i * 10 + 9).padStart(3, '0')] as [string, string],
                sceneIds: Array.from({ length: 10 }, (_, j) => String(i * 10 + j).padStart(3, '0')),
                sealedAt: Date.now(),
                sceneCount: 10,
                summary: '',
                keywords: [],
                npcs: [],
                majorEvents: [],
                unresolvedThreads: [],
                tone: '',
                themes: [],
            }));

            const rendered = renderRegisterForPayload(reg, chapters);
            expect(rendered).toContain('[ESTABLISHED FACTS]');
            expect(rendered).toContain('Chapter 1: The Siege');
            expect(rendered).toContain('[END ESTABLISHED FACTS]');

            const tokens = countRegisterTokens(reg);
            expect(tokens).toBeGreaterThan(0);
            expect(tokens).toBeLessThan(4000);

            console.log(`[TokenBudget] 50 entries across 5 chapters: ${tokens} tokens (budget: 2000-4000)`);
        });
    });

    describe('cast-independent rendering (cache regression)', () => {
        it('renders identically with and without onStageNpcIds', () => {
            const entries: DivergenceEntry[] = [
                makeEntry({ id: 'e1', chapterId: 'ch1', category: 'locations', text: 'Gate destroyed', sceneRef: '001' }),
                makeEntry({ id: 'e2', chapterId: 'ch1', category: 'npc_events', text: 'Grak allied', sceneRef: '002', npcIds: ['npc_grak'] }),
                makeEntry({ id: 'e3', chapterId: 'ch1', category: 'npc_events', text: 'Shadow Blade acquired', sceneRef: '003', npcIds: ['npc_grak', 'npc_smith'] }),
            ];
            const reg: DivergenceRegister = { ...EMPTY_REGISTER, entries };
            const chapters: ArchiveChapter[] = [
                { chapterId: 'ch1', title: 'The Siege', sceneRange: ['001', '003'] as [string, string], sceneIds: ['001', '002', '003'], sealedAt: Date.now(), sceneCount: 3, summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [] },
            ];

            const withoutCast = renderRegisterForPayload(reg, chapters);
            const withUndefined = renderRegisterForPayload(reg, chapters, undefined, undefined);

            expect(withoutCast).toBe(withUndefined);
            expect(withoutCast).toContain('[ESTABLISHED FACTS]');
            expect(withoutCast).toContain('[END ESTABLISHED FACTS]');
            expect(withoutCast).not.toContain('[ESTABLISHED FACTS — ON-STAGE]');
        });

        it('partitioned rendering activates only when onStageNpcIds and off-stage NPCs are present', () => {
            const entries: DivergenceEntry[] = [
                makeEntry({ id: 'e1', chapterId: 'ch1', category: 'npc_events', text: 'Grak allied', sceneRef: '002', npcIds: ['npc_grak'], knownBy: ['npc_grak'] }),
                makeEntry({ id: 'e2', chapterId: 'ch1', category: 'locations', text: 'Village burned', sceneRef: '003', npcIds: [] }),
            ];
            const reg: DivergenceRegister = { ...EMPTY_REGISTER, entries };

            const noCastResult = renderRegisterForPayload(reg);
            expect(noCastResult).toContain('[ESTABLISHED FACTS]');
            expect(noCastResult).not.toContain('[ESTABLISHED FACTS — ON-STAGE]');

            const onStageResult = renderRegisterForPayload(reg, undefined, ['npc_grak'], [
                { id: 'npc_grak', name: 'Grak', aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '', status: '', goals: '', voice: '', personality: '', exampleOutput: '', affinity: 10, archived: false },
                { id: 'npc_smith', name: 'Smith', aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '', status: '', goals: '', voice: '', personality: '', exampleOutput: '', affinity: 10, archived: false },
            ] as unknown as NPCEntry[]);

            expect(onStageResult).toContain('[ESTABLISHED FACTS — ON-STAGE]');
            expect(onStageResult).toContain('[ESTABLISHED FACTS — OFF-STAGE]');
        });
    });
});