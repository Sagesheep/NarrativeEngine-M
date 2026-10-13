import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payloadBuilder';
import { defaultContext } from '../../../store/slices/campaignSlice';
import { defaultSettings } from '../../../store/settingsMigration';
import type { ArchiveChapter, ChatMessage } from '../../../types';

const pad = (n: number) => String(n).padStart(3, '0');

function transcript(scenes: number): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (let n = 1; n <= scenes; n++) {
        out.push({ id: `u${n}`, role: 'user', content: `player ${n}`, timestamp: 0 });
        out.push({ id: `a${n}`, role: 'assistant', content: `gm ${n}`, timestamp: 0 });
        out.push({ id: `m${n}`, role: 'system', name: 'scene-marker', content: `Scene ${pad(n)}`, timestamp: 0 });
    }
    return out;
}

const chapters: ArchiveChapter[] = [
    {
        chapterId: 'CH01', title: 'The Harbor Deal', sceneRange: ['001', '005'], sceneIds: ['001', '002', '003', '004', '005'],
        summary: 'Rin struck a deal with Helena at the harbor. The price was the moon key.',
        keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 5, sealedAt: 1,
    },
];

const base = () => ({
    settings: { ...defaultSettings, contextLimit: 16384 },
    context: defaultContext,
    userMessage: 'What now?',
    history: transcript(10),
    chapters,
    archiveIndex: [],
});

describe('chapter recaps in the payload', () => {
    it('places the recap after the leading system blocks and before verbatim history', () => {
        const { messages } = buildPayload({ ...base(), condensedUpToIndex: 3 * 6 - 1 });
        const recapIdx = messages.findIndex(m => typeof m.content === 'string' && m.content.startsWith('[LOD HISTORY'));
        expect(recapIdx).toBeGreaterThan(0);
        expect(messages[recapIdx].role).toBe('system');
        expect(messages[recapIdx].content).toContain('Chapter CH01 — The Harbor Deal');
        expect(messages.slice(0, recapIdx).every(m => m.role === 'system')).toBe(true);
        // Condensed scenes are gone from the verbatim window; recent ones remain.
        const contents = messages.map(m => m.content);
        expect(contents).not.toContain('gm 3');
        expect(contents).toContain('gm 9');
    });

    it('keeps the cache breakpoint on the last history message, so the recap sits inside the cached prefix', () => {
        const { messages } = buildPayload({ ...base(), condensedUpToIndex: 3 * 6 - 1 });
        const cacheOf = (m: unknown) => (m as { cache_control?: unknown } | undefined)?.cache_control;
        const recap = messages.find(m => typeof m.content === 'string' && m.content.startsWith('[LOD HISTORY'));
        expect(recap).toBeDefined();
        expect(cacheOf(recap)).toBeUndefined();
        const lastHistory = messages[messages.length - 2];
        expect(cacheOf(lastHistory)).toEqual({ type: 'ephemeral' });
    });

    it('is byte-identical across turns with the same condensed state', () => {
        const a = buildPayload({ ...base(), condensedUpToIndex: 3 * 6 - 1 }).messages;
        const b = buildPayload({ ...base(), userMessage: 'Something else entirely', condensedUpToIndex: 3 * 6 - 1 }).messages;
        const recap = (ms: typeof a) => ms.find(m => typeof m.content === 'string' && m.content.startsWith('[LOD HISTORY'))?.content;
        expect(recap(a)).toBe(recap(b));
    });

    it('adds nothing when nothing is condensed', () => {
        const { messages } = buildPayload({ ...base(), condensedUpToIndex: -1 });
        expect(messages.some(m => typeof m.content === 'string' && m.content.startsWith('[LOD HISTORY'))).toBe(false);
    });
});
