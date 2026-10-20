import { describe, it, expect } from 'vitest';
import { assembleWorldBlocks, resolveNpcDetailLevel, type NpcStrategy } from '../payloadWorldContext';
import type { ArchiveChapter, ChatMessage, GameContext, NPCEntry } from '../../../types';

const richNpc = (id: string, name: string): NPCEntry => ({
    id, name, aliases: '', appearance: 'scarred', faction: '', storyRelevance: '', disposition: '',
    status: 'Alive', goals: 'legacy-goals', voice: 'gravelly drawl', personality: 'wary', exampleOutput: 'Aye, what now?',
    affinity: 50, pcRelation: 20,
    wants: { short: ['find the key'], medium: ['earn trust'], long: 'rule the harbor' },
    hardBoundaries: ['never betray kin'],
    softBoundaries: ['being lied to'],
    behavioralTriggers: [{ keyword: 'blood', shift: 'goes pale' }, { keyword: 'gold', shift: 'gets greedy' }],
    signatureKit: { equipment: ['rusted cutlass'], abilities: [] },
    previousSnapshot: { personality: 'wary', voice: 'gravelly drawl', affinity: 10 },
} as unknown as NPCEntry);

const chapters = [{ chapterId: 'ch1', npcInnerState: { Mara: 'INNER-MARA', Tom: 'INNER-TOM' } }] as unknown as ArchiveChapter[];

function npcBlock(opts: { strategy?: NpcStrategy; onStage?: string[]; ledger?: NPCEntry[]; history?: ChatMessage[]; userMessage?: string }): string {
    const ledger = opts.ledger ?? [richNpc('a1', 'Mara'), richNpc('b2', 'Tom')];
    const blocks = assembleWorldBlocks({
        context: {} as GameContext,
        history: opts.history ?? [],
        userMessage: opts.userMessage ?? 'Mara and Tom are here.',
        npcLedger: ledger,
        npcStrategy: opts.strategy,
        onStageNpcIds: opts.onStage,
        chapters,
        addTrace: () => {},
    });
    return blocks.find(b => b.source === 'Active NPCs')?.content ?? '';
}

function line(block: string, name: string): string {
    return block.split('\n').find(l => l.startsWith(`[${name.toUpperCase()}`)) ?? '';
}

const FULL_ONLY = ['GOAL: rule the harbor', 'PURSUING: earn trust', 'RESENTS:', 'Example:', 'SHIFT', 'Inner: INNER'];

describe('resolveNpcDetailLevel', () => {
    it('no recommender result → full', () => {
        expect(resolveNpcDetailLevel('x', undefined, false)).toBe('full');
    });
    it('valid recommender level wins over presence', () => {
        expect(resolveNpcDetailLevel('x', { x: 'brief' }, true)).toBe('brief');
        expect(resolveNpcDetailLevel('x', { x: 'full' }, false)).toBe('full');
    });
    it('no level → full if present, brief if absent', () => {
        expect(resolveNpcDetailLevel('x', {}, true)).toBe('full');
        expect(resolveNpcDetailLevel('x', {}, false)).toBe('brief');
    });
});

describe('NPC detail levels in the payload', () => {
    it('without recommender detail every NPC keeps the full profile (unchanged behavior)', () => {
        const block = npcBlock({ onStage: ['a1'] });
        for (const name of ['Mara', 'Tom']) {
            const l = line(block, name);
            expect(l).toContain('GOAL: rule the harbor');
            expect(l).toContain('ON "gold"');
            expect(l).toContain('KIT: rusted cutlass');
        }
    });

    it('full includes every field', () => {
        const block = npcBlock({
            strategy: { mode: 'recommended', recommendedNames: ['Mara'], detailLevels: { a1: 'full' } },
            onStage: ['a1'],
        });
        const l = line(block, 'Mara');
        for (const f of FULL_ONLY) expect(l).toContain(f);
        expect(l).toContain("WON'T: never betray kin");
        expect(l).toContain('ON "blood"');
        expect(l).toContain('ON "gold"');
        expect(l).toContain('KIT: rusted cutlass');
        expect(l).toContain('Voice: gravelly drawl');
        expect(l).toContain('NOW: find the key');
    });

    it('brief + present keeps core, voice, hard boundaries, kit; omits full-only fields', () => {
        const block = npcBlock({
            strategy: { mode: 'recommended', recommendedNames: ['Mara'], detailLevels: { a1: 'brief' } },
            onStage: ['a1'],
        });
        const l = line(block, 'Mara');
        expect(l).toContain('[MARA] Alive | scarred | wary | legacy-goals');
        expect(l).toContain('NOW: find the key');
        expect(l).toContain('Voice: gravelly drawl');
        expect(l).toContain("WON'T: never betray kin");
        expect(l).toContain('KIT: rusted cutlass');
        for (const f of FULL_ONLY) expect(l).not.toContain(f);
        expect(l).not.toContain('ON "');
    });

    it('brief + absent also drops hard boundaries and kit, keeps the frozen marker', () => {
        const block = npcBlock({
            strategy: { mode: 'recommended', recommendedNames: ['Tom'], detailLevels: { b2: 'brief' } },
            onStage: ['a1'],
            ledger: [richNpc('b2', 'Tom')],
        });
        const l = line(block, 'Tom');
        expect(l).toContain('[KNOWLEDGE FROZEN]');
        expect(l).toContain('Voice: gravelly drawl');
        expect(l).not.toContain("WON'T:");
        expect(l).not.toContain('KIT:');
    });

    it('brief includes only triggers whose keyword appears in the latest exchange or input', () => {
        const history = [
            { id: '1', role: 'user', content: 'I mention the gold.' },        // too old
            { id: '2', role: 'assistant', content: 'The tide rolls in.' },
            { id: '3', role: 'user', content: 'I look around.' },
        ] as ChatMessage[];
        const block = npcBlock({
            strategy: { mode: 'recommended', recommendedNames: ['Mara'], detailLevels: { a1: 'brief' } },
            onStage: ['a1'],
            history,
            userMessage: 'There is BLOOD on Mara\'s sleeve.',
        });
        const l = line(block, 'Mara');
        expect(l).toContain('ON "blood": goes pale');
        expect(l).not.toContain('ON "gold"');
    });

    it('engine-added NPCs with no level: full if present, brief if absent', () => {
        // Recommender succeeded but gave no levels (e.g. semantic recall / name match).
        const block = npcBlock({
            strategy: { mode: 'recommended', recommendedNames: ['Mara', 'Tom'], detailLevels: {} },
            onStage: ['a1'],
        });
        expect(line(block, 'Mara')).toContain('GOAL: rule the harbor');
        expect(line(block, 'Tom')).not.toContain('GOAL: rule the harbor');
        expect(line(block, 'Tom')).toContain('NOW: find the key');
    });

    it('semantically recalled NPCs get the presence default', () => {
        const block = npcBlock({
            strategy: { mode: 'recommended', recommendedNames: ['Mara'], semanticallyRecalledNpcIds: ['b2'], detailLevels: { a1: 'full' } },
            onStage: ['a1'],
        });
        expect(line(block, 'Tom')).not.toContain('Example:');
    });

    it('orders present NPCs first, then by id, regardless of ledger order', () => {
        const ledger = [richNpc('z9', 'Zed'), richNpc('c3', 'Cat'), richNpc('a1', 'Mara'), richNpc('b2', 'Tom')];
        const block = npcBlock({
            strategy: { mode: 'recommended', recommendedNames: ['Zed', 'Cat', 'Mara', 'Tom'], detailLevels: {} },
            onStage: ['z9', 'b2'],
            ledger,
            userMessage: 'everyone',
        });
        const order = block.split('\n').filter(l => l.startsWith('[') && !l.startsWith('[ACTIVE') && !l.startsWith('[END') && !l.startsWith('[ON-STAGE'))
            .map(l => l.slice(1, l.indexOf(']')));
        expect(order).toEqual(['TOM', 'ZED', 'MARA', 'CAT']);
    });
});
