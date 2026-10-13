import { describe, it, expect } from 'vitest';
import { buildOneShotDirective, ONE_SHOT_EVENT_TYPES } from './oneShotEvents';
import { fitHistory } from '../payload/payloadHistoryFitting';
import type { ChatMessage } from '../../types';

describe('One-Shot Event directive', () => {
    it('builds a bracketed directive for every event type', () => {
        for (const t of ONE_SHOT_EVENT_TYPES) {
            const d = buildOneShotDirective(t.id);
            expect(d.startsWith(`\n[INJECTED EVENT — ${t.label.toUpperCase()}.`)).toBe(true);
            expect(d).toContain(t.directive);
            expect(d.endsWith(']')).toBe(true);
            // One closing bracket only, so the history strip removes the whole block.
            expect(d.indexOf(']')).toBe(d.length - 1);
        }
    });

    it('is stripped from older history so it steers only its own turn', () => {
        const history: ChatMessage[] = [
            { id: 'u1', role: 'user', content: `I walk into the tavern.${buildOneShotDirective('combat')}`, timestamp: 0 },
            { id: 'a1', role: 'assistant', content: 'A bottle smashes against the wall.', timestamp: 0 },
        ];
        const { fitted } = fitHistory(history, -1, 'next', 0, 8192);
        expect(fitted[0].content).toBe('I walk into the tavern.');
    });
});
