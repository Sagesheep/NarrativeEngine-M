import { describe, it, expect, vi } from 'vitest';

const mockLlmCall = vi.fn();
vi.mock('../../../utils/llmCall', () => ({ llmCall: (...args: unknown[]) => mockLlmCall(...args) }));

import { mergeLifecycleEntries, isFactActive, isValidStateKey, normalizeStateKey, renderRegisterForPayload, applyStateKeys, restoreFact, EMPTY_REGISTER } from '../divergenceRegister';
import { parseCombinedSealOutput, sealChapterCombined } from '../../archive/divergenceExtractor';
import type { DivergenceEntry, DivergenceRegister } from '../../../types';

function entry(over: Partial<DivergenceEntry> & { id: string }): DivergenceEntry {
    return {
        chapterId: 'CH01', category: 'party_facts', text: `fact ${over.id}`, sceneRef: '010',
        npcIds: [], pinned: false, source: 'auto', ...over,
    };
}
const register = (entries: DivergenceEntry[]): DivergenceRegister => ({ ...EMPTY_REGISTER, entries });

describe('isValidStateKey', () => {
    it('accepts only the narrow single-value slots', () => {
        expect(isValidStateKey('item:moon-key:holder')).toBe(true);
        expect(isValidStateKey('npc:npc_5:status')).toBe(true);
        expect(isValidStateKey('npc:npc_5:mood')).toBe(false);
        expect(isValidStateKey('Item:Moon Key:holder')).toBe(false);
        expect(isValidStateKey(undefined)).toBe(false);
        expect(isValidStateKey('faction:red-hand:leader')).toBe(true);
        expect(isValidStateKey('quest:missing-heir:status')).toBe(true);
        expect(isValidStateKey('npc:npc_5:secrets')).toBe(false);
    });

    it('normalizes case and whitespace from the extractor', () => {
        expect(normalizeStateKey(' Item:Moon-Key:Holder ')).toBe('item:moon-key:holder');
        expect(normalizeStateKey('npc:npc_5:mood')).toBeUndefined();
        expect(normalizeStateKey(42)).toBeUndefined();
    });
});

describe('mergeLifecycleEntries', () => {
    const previous = entry({ id: 'div_mira_key', text: 'Mira holds the moon key', stateKey: 'item:moon-key:holder' });

    it('supersedes an active, unpinned fact in the exact same state slot', () => {
        const replacement = entry({ id: 'div_kaelen_key', text: 'Kaelen holds the moon key', stateKey: 'item:moon-key:holder', supersedesFactId: 'div_mira_key' });
        const merged = mergeLifecycleEntries(register([previous]), [replacement], '025');
        expect(merged.entries[0]).toMatchObject({ status: 'superseded', supersededBy: 'div_kaelen_key' });
        expect(merged.entries[1]).toMatchObject({ status: 'active', stateKey: 'item:moon-key:holder' });
        expect(merged.entries[1].supersedesFactId).toBeUndefined();
        expect(merged.lastUpdatedSceneId).toBe('025');
    });

    it('a different state slot only adds a fact', () => {
        const replacement = entry({ id: 'div_x', stateKey: 'item:other-key:holder', supersedesFactId: 'div_mira_key' });
        const merged = mergeLifecycleEntries(register([previous]), [replacement], '025');
        expect(isFactActive(merged.entries[0])).toBe(true);
        expect(merged.entries).toHaveLength(2);
    });

    it('the slot alone decides: same key replaces without naming the old fact', () => {
        const merged = mergeLifecycleEntries(register([previous]), [
            entry({ id: 'div_kaelen_key', text: 'Kaelen holds the moon key', stateKey: 'item:moon-key:holder' }),
        ], '025');
        expect(merged.entries[0]).toMatchObject({ status: 'superseded', supersededBy: 'div_kaelen_key' });
        expect(isFactActive(merged.entries[1])).toBe(true);
    });

    it('never supersedes a pinned fact, and facts without a state key only add', () => {
        const pinned = entry({ id: 'div_pinned', pinned: true, stateKey: 'npc:npc_1:status' });
        const merged = mergeLifecycleEntries(register([pinned, previous]), [
            entry({ id: 'a', stateKey: 'npc:npc_1:status' }),
            entry({ id: 'c', supersedesFactId: 'div_mira_key' }),
        ], '025');
        expect(merged.entries.slice(0, 2).every(isFactActive)).toBe(true);
        expect(merged.entries).toHaveLength(4);
    });

    it('within one batch the latest scene wins the slot', () => {
        const merged = mergeLifecycleEntries(register([]), [
            entry({ id: 'late', sceneRef: '014', stateKey: 'npc:npc_1:location', text: 'Mira is at the docks' }),
            entry({ id: 'early', sceneRef: '012', stateKey: 'npc:npc_1:location', text: 'Mira is at the inn' }),
        ], '014');
        const byId = new Map(merged.entries.map(e => [e.id, e]));
        expect(byId.get('early')).toMatchObject({ status: 'superseded', supersededBy: 'late' });
        expect(isFactActive(byId.get('late')!)).toBe(true);
    });

    it('old facts without lifecycle fields stay active', () => {
        expect(isFactActive(entry({ id: 'old' }))).toBe(true);
    });
});

describe('applyStateKeys (migration) and restoreFact', () => {
    it('keys facts, keeps the newest per slot, supersedes the rest', () => {
        const reg = register([
            entry({ id: 'a', sceneRef: '003', text: 'Mira is injured' }),
            entry({ id: 'b', sceneRef: '009', text: 'Mira recovered' }),
            entry({ id: 'c', sceneRef: '005', text: 'Mira swore an oath' }),
        ]);
        const { register: out, keyed, superseded } = applyStateKeys(reg, [
            { id: 'a', stateKey: 'npc:mira:condition' },
            { id: 'b', stateKey: 'npc:mira:condition' },
            { id: 'c', stateKey: 'npc:mira:feelings' },
        ]);
        expect(keyed).toBe(2);
        expect(superseded).toBe(1);
        const byId = new Map(out.entries.map(e => [e.id, e]));
        expect(byId.get('a')).toMatchObject({ status: 'superseded', supersededBy: 'b' });
        expect(isFactActive(byId.get('b')!)).toBe(true);
        expect(byId.get('c')!.stateKey).toBeUndefined();

        const restored = restoreFact(out, 'a');
        expect(restored.entries.find(e => e.id === 'a')).toMatchObject({ status: 'active' });
        expect(restored.entries.find(e => e.id === 'a')!.supersededBy).toBeUndefined();
    });
});

describe('rendering skips replaced facts', () => {
    it('renders slot facts in one CURRENT STATE list ahead of chapter facts', () => {
        const text = renderRegisterForPayload(register([
            entry({ id: 'x', text: 'The party burned the mill' }),
            entry({ id: 'y', text: 'Kaelen holds the moon key', stateKey: 'item:moon-key:holder' }),
        ]));
        expect(text).toContain('CURRENT STATE:\n• Kaelen holds the moon key');
        expect(text.indexOf('CURRENT STATE')).toBeLessThan(text.indexOf('The party burned the mill'));
    });

    it('the GM sees only the current holder', () => {
        const merged = mergeLifecycleEntries(register([entry({ id: 'div_mira_key', text: 'Mira holds the moon key', stateKey: 'item:moon-key:holder' })]), [
            entry({ id: 'div_kaelen_key', text: 'Kaelen holds the moon key', stateKey: 'item:moon-key:holder', supersedesFactId: 'div_mira_key' }),
        ], '025');
        const text = renderRegisterForPayload(merged);
        expect(text).toContain('Kaelen holds the moon key');
        expect(text).not.toContain('Mira holds the moon key');
    });
});

describe('seal prompt', () => {
    it('lists only active, valid state facts as current values, after the input anchor', async () => {
        mockLlmCall.mockResolvedValue('{"summary": {"title": "T", "summary": "S"}, "divergences": {}}');
        const provider = { id: 'p', label: 'p', endpoint: 'http://x', apiKey: '', modelName: 'm' };
        await sealChapterCombined(provider, [{ sceneId: '012', content: 'scene' }], 'CH02', 'T', ['012'], [], undefined, 0, undefined, undefined, [
            entry({ id: 'div_live', text: 'Mira holds the moon key', stateKey: 'item:moon-key:holder' }),
            entry({ id: 'div_gone', text: 'Old holder', stateKey: 'item:moon-key:holder', status: 'superseded' }),
            entry({ id: 'div_plain', text: 'No slot' }),
        ]);
        const prompt = mockLlmCall.mock.calls[0][1] as string;
        expect(prompt).toContain('[STATE: item:moon-key:holder] Mira holds the moon key');
        expect(prompt).not.toContain('div_gone');
        expect(prompt).not.toContain('div_plain');
        expect(prompt.indexOf('CURRENT STATE (reuse')).toBeGreaterThan(prompt.indexOf('"stateKey"'));
    });
});

describe('seal output parsing', () => {
    it('keeps a valid stateKey + supersedesFactId and drops a supersede without a valid slot', () => {
        const raw = JSON.stringify({
            summary: { title: 'T', summary: 'S', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [] },
            divergences: {
                party_facts: [
                    { text: 'Kaelen holds the moon key', sceneRef: '012', npcIds: [], stateKey: 'item:moon-key:holder', supersedesFactId: 'div_mira_key' },
                    { text: 'Kaelen is tired', sceneRef: '012', npcIds: [], stateKey: 'npc:kaelen:mood', supersedesFactId: 'div_other' },
                ],
            },
        });
        const result = parseCombinedSealOutput(raw, 'CH02', ['012'], []);
        const [valid, invalid] = result.divergences;
        expect(valid).toMatchObject({ stateKey: 'item:moon-key:holder', supersedesFactId: 'div_mira_key' });
        expect(invalid.stateKey).toBeUndefined();
        expect(invalid.supersedesFactId).toBeUndefined();
    });
});
