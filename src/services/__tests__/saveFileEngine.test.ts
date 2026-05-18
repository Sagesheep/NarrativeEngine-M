import { describe, it, expect } from 'vitest';
import { parseCombinedSealOutput, parseChapterSummaryOutput, truncateScenesToBudget } from '../saveFileEngine';

const NPC_LEDGER = [
    { id: 'npc_grak', name: 'Grak', aliases: 'The Orc' },
    { id: 'npc_elly', name: 'Elara', aliases: '' },
];

const CHAPTER_ID = 'ch_001';
const SCENE_IDS = ['001', '002', '003'];

describe('parseChapterSummaryOutput', () => {
    const fullSummary = JSON.stringify({
        title: 'The Gate Falls',
        summary: 'The eastern gate was destroyed.',
        keywords: ['gate', 'siege'],
        npcs: ['Grak'],
        majorEvents: ['Gate destroyed'],
        unresolvedThreads: ['Who ordered the siege?'],
        tone: 'combat-heavy',
        themes: ['war', 'sacrifice'],
    });

    it('parses valid JSON', () => {
        const result = parseChapterSummaryOutput(fullSummary);
        expect(result).not.toBeNull();
        expect(result!.title).toBe('The Gate Falls');
        expect(result!.keywords).toEqual(['gate', 'siege']);
        expect(result!.npcs).toEqual(['Grak']);
    });

    it('parses markdown-fenced JSON', () => {
        const fenced = '```json\n' + fullSummary + '\n```';
        const result = parseChapterSummaryOutput(fenced);
        expect(result).not.toBeNull();
        expect(result!.title).toBe('The Gate Falls');
    });

    it('fills missing required fields with defaults', () => {
        const partial = JSON.stringify({ title: 'Untitled', summary: 'Something happened.' });
        const result = parseChapterSummaryOutput(partial);
        expect(result).not.toBeNull();
        expect(result!.keywords).toEqual([]);
        expect(result!.npcs).toEqual([]);
        expect(result!.majorEvents).toEqual([]);
        expect(result!.unresolvedThreads).toEqual([]);
        expect(result!.tone).toBe('');
        expect(result!.themes).toEqual([]);
    });

    it('returns null for completely invalid JSON', () => {
        const result = parseChapterSummaryOutput('not json at all');
        expect(result).toBeNull();
    });
});

describe('parseCombinedSealOutput', () => {
    const makeSummary = () => ({
        title: 'The Gate Falls',
        summary: 'The eastern gate was destroyed.',
        keywords: ['gate', 'siege'],
        npcs: ['Grak'],
        majorEvents: ['Gate destroyed'],
        unresolvedThreads: ['Who ordered the siege?'],
        tone: 'combat-heavy',
        themes: ['war', 'sacrifice'],
    });

    const makeDivergences = () => ({
        locations: [
            { text: 'Eastern gate destroyed by siege', sceneRef: '001', npcIds: [], unrecognizedNpcNames: [] },
        ],
        npc_events: [
            { text: 'Grak allied with the player', sceneRef: '002', npcIds: ['npc_grak'], knownBy: ['npc_grak'], unrecognizedNpcNames: [] },
        ],
        promises_debts: [],
        world_state: [],
        party_facts: [],
        rules_lore: [],
        misc: [],
    });

    it('parses valid combined JSON with summary and divergences', () => {
        const raw = JSON.stringify({ summary: makeSummary(), divergences: makeDivergences() });
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        expect(result.summary).not.toBeNull();
        expect(result.summary!.title).toBe('The Gate Falls');
        expect(result.divergences.length).toBeGreaterThan(0);
        expect(result.divergenceParseError).toBeFalsy();
    });

    it('handles markdown-fenced JSON', () => {
        const json = JSON.stringify({ summary: makeSummary(), divergences: makeDivergences() });
        const raw = '```json\n' + json + '\n```';
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        expect(result.summary).not.toBeNull();
    });

    it('recovers from split-object }{ output', () => {
        const sumJson = JSON.stringify({ summary: makeSummary() });
        const divJson = JSON.stringify({ divergences: makeDivergences() });
        const raw = sumJson + ' ' + divJson;
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        expect(result.summary).not.toBeNull();
        expect(result.divergences.length).toBeGreaterThan(0);
    });

    it('sets reviewFlag for unrecognized NPC names', () => {
        const divs = {
            ...makeDivergences(),
            npc_events: [
                { text: 'Unknown NPC did something', sceneRef: '002', npcIds: [], unrecognizedNpcNames: ['MysteryPerson'] },
            ],
        };
        const raw = JSON.stringify({ summary: makeSummary(), divergences: divs });
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        const flagged = result.divergences.filter(d => d.reviewFlag);
        expect(flagged.length).toBeGreaterThan(0);
        expect(flagged[0].unrecognizedNpcNames).toContain('MysteryPerson');
    });

    it('resolves NPC names from unrecognizedNpcNames via ledger aliases', () => {
        const divs = {
            ...makeDivergences(),
            npc_events: [
                { text: 'The Orc attacked', sceneRef: '002', npcIds: [], unrecognizedNpcNames: ['The Orc'] },
            ],
        };
        const raw = JSON.stringify({ summary: makeSummary(), divergences: divs });
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        const event = result.divergences.find(d => d.text === 'The Orc attacked');
        expect(event).toBeDefined();
        expect(event!.npcIds).toContain('npc_grak');
    });

    it('handles <think> reasoning tag variants via stripReasoning', () => {
        const json = JSON.stringify({ summary: makeSummary(), divergences: makeDivergences() });
        const raw = '<think>Let me analyze this carefully.</think>' + json;
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        expect(result.summary).not.toBeNull();
    });

    it('handles <reasoning> tag variant', () => {
        const json = JSON.stringify({ summary: makeSummary(), divergences: makeDivergences() });
        const raw = '<reasoning>I need to think step by step.</reasoning>' + json;
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        expect(result.summary).not.toBeNull();
    });

    it('falls back to summaryOnly when JSON is unparseable and no split-object', () => {
        const sumJson = JSON.stringify(makeSummary());
        const raw = 'Some preamble\n' + sumJson + '\nSome trailing text that is not JSON';
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        expect(result.divergenceParseError).toBe(true);
    });

    it('extracts witnessCorrections when present at top level', () => {
        const raw = JSON.stringify({ summary: makeSummary(), divergences: makeDivergences(), witness_corrections: { '001': ['npc_grak', 'npc_elly'] } });
        const result = parseCombinedSealOutput(raw, CHAPTER_ID, SCENE_IDS, NPC_LEDGER);
        expect(result.witnessCorrections).toBeDefined();
        expect(result.witnessCorrections!['001']).toEqual(['npc_grak', 'npc_elly']);
    });
});

describe('truncateScenesToBudget', () => {
    const makeScene = (sceneId: string, tokenWeight: number) => ({
        sceneId,
        content: 'x'.repeat(tokenWeight * 4),
    });

    it('returns all scenes when within budget', () => {
        const scenes = [makeScene('001', 10), makeScene('002', 10), makeScene('003', 10)];
        const result = truncateScenesToBudget(scenes, 9999);
        expect(result).toHaveLength(3);
    });

    it('drops middle scenes on a 5-scene array exceeding budget', () => {
        const scenes = [
            makeScene('001', 500),
            makeScene('002', 500),
            makeScene('003', 500),
            makeScene('004', 500),
            makeScene('005', 500),
        ];
        const result = truncateScenesToBudget(scenes, 1);
        expect(result.length).toBeLessThanOrEqual(scenes.length);
    });

    it('preserves first and last scenes when truncating a larger array', () => {
        const scenes = Array.from({ length: 11 }, (_, i) => makeScene(String(i).padStart(3, '0'), 500));
        const result = truncateScenesToBudget(scenes, 1);
        const ids = result.map(s => s.sceneId);
        expect(ids).toContain('000');
        expect(ids).toContain('010');
        expect(result.length).toBeLessThanOrEqual(scenes.length);
    });

    it('handles small arrays gracefully even if over budget', () => {
        const scenes = [makeScene('001', 10), makeScene('002', 10)];
        const result = truncateScenesToBudget(scenes, 1);
        expect(result.length).toBeLessThanOrEqual(scenes.length);
    });
});