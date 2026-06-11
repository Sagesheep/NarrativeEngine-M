import { describe, it, expect } from 'vitest';
import type { ChatMessage, DivergenceEntry, DivergenceRegister, PayloadTrace } from '../../../types';
import { trimWorldBlocks, type WorldBlock } from '../payloadWorldContext';
import { fitHistory } from '../payloadHistoryFitting';
import { buildDivergenceBlock } from '../payloadStableContent';
import { countTokens } from '../../infrastructure';

const noTrace = (_t: PayloadTrace) => {};

describe('trimWorldBlocks per-scene truncation (AUDIT F5)', () => {
    const rewrap = (kept: string[]) => `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${kept.join('\n\n')}\n[END ARCHIVE RECALL]`;
    const seg = (n: number) => `[SCENE #${n}]\n` + 'narrative words here '.repeat(15);
    const segments = [seg(1), seg(2), seg(3)];

    it('keeps the largest scene prefix that fits instead of dropping the whole block', () => {
        const fullText = rewrap(segments);
        const block: WorldBlock = {
            source: 'Archive Recall', content: fullText, tokens: countTokens(fullText),
            reason: 'r', segments, rewrap,
        };
        // Budget that fits exactly two scenes.
        const budget = countTokens(rewrap(segments.slice(0, 2)));

        const { worldContent, currentWorldTokens } = trimWorldBlocks([block], budget, noTrace);

        expect(worldContent).toContain('[SCENE #1]');
        expect(worldContent).toContain('[SCENE #2]');
        expect(worldContent).not.toContain('[SCENE #3]');
        expect(currentWorldTokens).toBeLessThanOrEqual(budget);
    });

    it('drops a non-segmented block whole when it does not fit', () => {
        const content = 'lore '.repeat(100);
        const block: WorldBlock = { source: 'RAG Lore', content, tokens: countTokens(content), reason: 'r' };
        const { worldContent } = trimWorldBlocks([block], 5, noTrace);
        expect(worldContent).toBe('');
    });
});

describe('fitHistory budget clamp (AUDIT F6)', () => {
    it('clamps history budget to 0 when the preamble already exceeds the limit', () => {
        const history: ChatMessage[] = [
            { id: '1', role: 'user', content: 'hello there', timestamp: 0 },
        ];
        const { fitted, historyBudget } = fitHistory(history, undefined, 'current turn', 100_000, 8192);
        expect(historyBudget).toBe(0);
        expect(fitted).toEqual([]);
    });
});

describe('divergence register cap (AUDIT F6)', () => {
    const entry = (chapterId: string, n: number): DivergenceEntry => ({
        id: `${chapterId}-${n}`,
        chapterId,
        category: 'world_state',
        text: `Established fact number ${n} in chapter ${chapterId} with enough words to cost tokens`,
        sceneRef: '001',
        npcIds: [],
        pinned: false,
        source: 'auto',
    });

    it('collapses oldest chapters first, keeping newest canon, when over the cap', () => {
        const entries: DivergenceEntry[] = [];
        for (const ch of ['CH01', 'CH02', 'CH03', 'CH04']) {
            for (let i = 0; i < 6; i++) entries.push(entry(ch, i));
        }
        const register: DivergenceRegister = {
            entries, chapterToggles: {}, categoryToggles: {},
            lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2,
        };

        const uncapped = buildDivergenceBlock({ divergenceRegister: register, addTrace: noTrace });
        const cap = Math.floor(uncapped.divergenceTokens / 2);

        const capped = buildDivergenceBlock({ divergenceRegister: register, cap, addTrace: noTrace });

        expect(capped.divergenceTokens).toBeLessThan(uncapped.divergenceTokens);
        expect(capped.divergenceContent).toContain('collapsed to fit budget');
        expect(capped.divergenceContent).toContain('CH04'); // newest chapter survives
        expect(capped.divergenceContent).not.toContain('CH01'); // oldest dropped first
    });

    it('leaves the register untouched when under the cap', () => {
        const register: DivergenceRegister = {
            entries: [entry('CH01', 0)], chapterToggles: {}, categoryToggles: {},
            lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2,
        };
        const capped = buildDivergenceBlock({ divergenceRegister: register, cap: 100_000, addTrace: noTrace });
        expect(capped.divergenceContent).not.toContain('collapsed');
        expect(capped.divergenceContent).toContain('CH01');
    });
});
