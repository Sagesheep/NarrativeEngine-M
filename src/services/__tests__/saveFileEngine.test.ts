import { describe, it, expect } from 'vitest';
import { countTokens } from '../infrastructure';
import { parseCombinedSealOutput, parseChapterSummaryOutput, truncateScenesToBudget } from '../archive';

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
    const words = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
    // Same shape archiveStorage.getScenes produces. Unique markers at the start and
    // end of the GM reply stand in for the setup and the outcome.
    const scene = (id: string, gmWords: number, userWords = 20) => ({
        sceneId: id,
        content: `## SCENE ${id}
*time*

**[USER]**
ACTION${id} ${words('u', userWords)}

**[GM]**
SETUP${id} ${words('g', gmWords)} OUTCOME${id}

---`,
    });
    const tokens = (xs: { content: string }[]) => xs.reduce((n, x) => n + countTokens(x.content), 0);

    it('returns the scenes untouched when within budget', () => {
        const scenes = [scene('001', 50), scene('002', 50)];
        expect(truncateScenesToBudget(scenes, 99999)).toBe(scenes);
    });

    it('keeps every scene, stays within budget, and keeps each scene action, setup and outcome', () => {
        // Roughly a real 25-scene chapter: mostly ~1k-token scenes, a few long ones.
        const scenes = Array.from({ length: 25 }, (_, i) => scene(String(i + 1).padStart(3, '0'), i % 6 === 0 ? 1800 : 500));
        expect(tokens(scenes)).toBeGreaterThan(12000);
        const out = truncateScenesToBudget(scenes, 12000);
        expect(out.map(s => s.sceneId)).toEqual(scenes.map(s => s.sceneId));
        expect(tokens(out)).toBeLessThanOrEqual(12000);
        for (const s of out) {
            expect(s.content).toContain(`## SCENE ${s.sceneId}`);
            expect(s.content).toContain(`ACTION${s.sceneId}`);
            expect(s.content).toContain(`SETUP${s.sceneId}`);
            expect(s.content).toContain(`OUTCOME${s.sceneId}`);
            expect(s.content).toContain('**[GM]**');
        }
    }, 20000);

    it('short scenes keep everything and hand their unused share to long ones', () => {
        const short = scene('001', 20);
        const long = scene('002', 3000);
        const out = truncateScenesToBudget([short, long], 1200);
        expect(out[0]).toBe(short);
        expect(countTokens(out[1].content)).toBeGreaterThan(1200 - countTokens(short.content) - 60);
        expect(tokens(out)).toBeLessThanOrEqual(1200);
    }, 20000);

    it('trims an over-long player turn too, without losing the GM outcome', () => {
        const out = truncateScenesToBudget([scene('001', 400, 2000)], 300);
        expect(countTokens(out[0].content)).toBeLessThanOrEqual(300);
        expect(out[0].content).toContain('ACTION001');
        expect(out[0].content).toContain('OUTCOME001');
    }, 20000);
});
