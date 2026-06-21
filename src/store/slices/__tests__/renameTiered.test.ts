import { describe, it, expect, vi, beforeEach } from 'vitest';

// The store registers itself with the embedding scheduler at import time; stub
// it so importing the store has no side effects (mirrors useAppStore.wiring.test).
vi.mock('../../../services/embedding/embeddingScheduler', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../services/embedding/embeddingScheduler')>();
    return { ...actual, registerStore: vi.fn() };
});

import { useAppStore } from '../../useAppStore';
import type { ChatMessage } from '../../../types';

const msg = (id: string, role: ChatMessage['role'], content: string, ts = 0): ChatMessage => ({
    id, role, content, timestamp: ts,
});

describe('renameFirstNameInLatestAssistant', () => {
    beforeEach(() => useAppStore.setState({ messages: [], activeCampaignId: null }));

    it('replaces the first name in the latest assistant message only', () => {
        useAppStore.setState({
            messages: [
                msg('u1', 'user', 'Pell Gravatt walks in'),
                msg('a1', 'assistant', 'Pell sneaks past the guard. Pell Gravatt hides.'),
                msg('u2', 'user', 'continue'),
                msg('a2', 'assistant', 'Pell strikes. The guard sees Pell.'),
            ],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Gravatt');
        expect(changed).toBe(1);
        const msgs = useAppStore.getState().messages;
        // latest assistant: first name replaced
        expect(msgs[3].content).toBe('Dirk strikes. The guard sees Dirk.');
        // earlier assistant: untouched (first-name pass is current-scene only)
        expect(msgs[1].content).toBe('Pell sneaks past the guard. Pell Gravatt hides.');
    });

    it('also patches displayContent when present on the latest assistant', () => {
        useAppStore.setState({
            messages: [
                msg('a1', 'assistant', 'Pell sneaks past the guard.', 0) as ChatMessage,
                { ...msg('a2', 'assistant', 'Pell strikes. The guard sees Pell.', 1), displayContent: 'Pell strikes. The guard sees Pell.' },
            ],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Gravatt');
        expect(changed).toBe(1);
        const msgs = useAppStore.getState().messages;
        expect(msgs[1].content).toBe('Dirk strikes. The guard sees Dirk.');
        expect(msgs[1].displayContent).toBe('Dirk strikes. The guard sees Dirk.');
    });

    it('returns 0 when from is a single token (no first-name tier)', () => {
        useAppStore.setState({
            messages: [msg('a1', 'assistant', 'Pell sneaks past the guard.')],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell', 'Dirk');
        expect(changed).toBe(0);
        expect(useAppStore.getState().messages[0].content).toBe('Pell sneaks past the guard.');
    });

    it('returns 0 when there is no assistant message', () => {
        useAppStore.setState({
            messages: [msg('u1', 'user', 'Pell Gravatt walks in')],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Gravatt');
        expect(changed).toBe(0);
    });

    it('skips trailing system messages (finds the last assistant, not messages[length-1])', () => {
        useAppStore.setState({
            messages: [
                msg('a1', 'assistant', 'Pell sneaks past the guard.'),
                msg('u2', 'user', 'continue'),
                msg('a2', 'assistant', 'Pell strikes. The guard sees Pell.'),
                { id: 's1', role: 'system', name: 'scene-marker', content: 'Scene 003', timestamp: 2 } as ChatMessage,
            ],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Gravatt');
        expect(changed).toBe(1);
        const msgs = useAppStore.getState().messages;
        // The scene-marker (last message, system) is untouched
        expect(msgs[3].content).toBe('Scene 003');
        // The last assistant (index 2) is fixed
        expect(msgs[2].content).toBe('Dirk strikes. The guard sees Dirk.');
    });

    it('returns 0 when the first name is not present in the latest assistant', () => {
        useAppStore.setState({
            messages: [
                msg('a1', 'assistant', 'Pell sneaks past the guard.'),
                msg('a2', 'assistant', 'The guard sees nothing.'),
            ],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Gravatt');
        expect(changed).toBe(0);
        expect(useAppStore.getState().messages[1].content).toBe('The guard sees nothing.');
    });

    it('is whole-word (does not replace Pell inside Pellory)', () => {
        useAppStore.setState({
            messages: [msg('a1', 'assistant', 'Pellory picks a lock. Pell waits.')],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Gravatt');
        expect(changed).toBe(1);
        const msgs = useAppStore.getState().messages;
        expect(msgs[0].content).toBe('Pellory picks a lock. Dirk waits.');
    });

    it('is case-insensitive (PELL → Dirk)', () => {
        useAppStore.setState({
            messages: [msg('a1', 'assistant', 'PELL stands. pell sits.')],
        });
        const changed = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Gravatt');
        expect(changed).toBe(1);
        const msgs = useAppStore.getState().messages;
        expect(msgs[0].content).toBe('Dirk stands. Dirk sits.');
    });
});

describe('mergeOrRenameNpc — exact-only match (no startsWith prefix)', () => {
    const makeNPC = (name: string, id?: string, aliases = ''): import('../../../types').NPCEntry => ({
        id: id || name.toLowerCase().replace(/\s+/g, '-'),
        name,
        aliases,
        appearance: '', faction: '', storyRelevance: '', disposition: '',
        status: '', goals: '', voice: '', personality: '', exampleOutput: '',
        affinity: 50,
    });

    beforeEach(() => useAppStore.setState({ npcLedger: [], activeCampaignId: null }));

    it('matches an exact name case-insensitively and renames it', () => {
        useAppStore.setState({ npcLedger: [makeNPC('Pell Gravatt', 'pg')] });
        const result = useAppStore.getState().mergeOrRenameNpc('pell gravatt', 'Dirk Gravatt', 1);
        expect(result).toBe('renamed');
        expect(useAppStore.getState().npcLedger[0].name).toBe('Dirk Gravatt');
    });

    it('matches via an alias case-insensitively and renames the owning NPC', () => {
        useAppStore.setState({ npcLedger: [makeNPC('Dirk Gravatt', 'dg', 'Pell Gravatt')] });
        const result = useAppStore.getState().mergeOrRenameNpc('Pell Gravatt', 'Dirk Vance', 1);
        expect(result).toBe('renamed');
        expect(useAppStore.getState().npcLedger[0].name).toBe('Dirk Vance');
    });

    it('does NOT match a longer name that starts with the from key (Pell Gravatt Jr)', () => {
        useAppStore.setState({ npcLedger: [makeNPC('Pell Gravatt Jr', 'pgj')] });
        const result = useAppStore.getState().mergeOrRenameNpc('Pell Gravatt', 'Dirk Gravatt', 1);
        expect(result).toBe('none');
        expect(useAppStore.getState().npcLedger[0].name).toBe('Pell Gravatt Jr');
    });

    it('does NOT match a first-name-only entry when from is full-name (Pell ≠ Pell Gravatt)', () => {
        useAppStore.setState({ npcLedger: [makeNPC('Pell', 'p')] });
        const result = useAppStore.getState().mergeOrRenameNpc('Pell Gravatt', 'Dirk Gravatt', 1);
        expect(result).toBe('none');
        expect(useAppStore.getState().npcLedger[0].name).toBe('Pell');
    });

    it('merges into the existing target NPC when `to` matches another entry', () => {
        useAppStore.setState({ npcLedger: [makeNPC('Pell Gravatt', 'pg'), makeNPC('Dirk Gravatt', 'dg')] });
        const result = useAppStore.getState().mergeOrRenameNpc('Pell Gravatt', 'Dirk Gravatt', 1);
        expect(result).toBe('merged');
        // fromNpc (Pell Gravatt) removed; toNpc (Dirk Gravatt) remains
        const ids = useAppStore.getState().npcLedger.map(n => n.id);
        expect(ids).toEqual(['dg']);
    });

    it('returns none when from == to (case-insensitive)', () => {
        useAppStore.setState({ npcLedger: [makeNPC('Pell Gravatt', 'pg')] });
        const result = useAppStore.getState().mergeOrRenameNpc('Pell Gravatt', 'pell gravatt', 1);
        expect(result).toBe('none');
    });
});