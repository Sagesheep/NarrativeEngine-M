import type { StateCreator } from 'zustand';
import type { ChatMessage, CondenserState, GameContext, LoreCheckSelection, LoreCheckResult, DivergenceRegister, DivergenceEntry, DivergenceCategory, TopicClusters, PinnedExcerpt } from '../../types';
import { EMPTY_REGISTER, toggleChapter, toggleCategory, pinFact, editFact, deleteFact, deleteChapter, toggleFact, dismissReviewFlag, migrateV1ToV2 } from '../../services/campaign-state';
import { debouncedSaveCampaignState } from './campaignSlice';
import { countTokens } from '../../services/infrastructure';
import { uid } from '../../utils/uid';
import { imageStorage } from '../../services/storage/imageStorage';

// Re-export PinnedExcerpt from types for consumers that import from this slice
export type { PinnedExcerpt };

const PINNED_EXCERPTS_TOKEN_CAP = 3000;

// The divergence register persists to its own `divergence_<id>` key, separate from
// the campaign-state payload. UI-edit actions only debounce-saved campaign state
// (which omits the register), so manual MemoryTab edits were lost on reload.
function saveDivergence(campaignId: string | null, register: DivergenceRegister) {
    if (!campaignId) return;
    import('../../store/campaignStore')
        .then(m => m.saveDivergenceRegister(campaignId, register))
        .catch(e => console.error('Failed to save divergence register', e));
}

// ── Slice type ─────────────────────────────────────────────────────────

export type ChatSlice = {
    messages: ChatMessage[];
    isStreaming: boolean;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateMessageContent: (id: string, content: string) => void;
    replaceMessageText: (id: string, oldText: string, newText: string) => void;
    renameAcrossMessages: (from: string, to: string) => number;
    deleteMessage: (id: string) => void;
    deleteMessagesFrom: (id: string) => void;
    setStreaming: (v: boolean) => void;
    clearChat: () => void;
    clearArchive: () => void;

    condenser: CondenserState;
    setCondensed: (upToIndex: number) => void;
    setCondenser: (state: CondenserState) => void;
    resetCondenser: () => void;

    divergenceRegister: DivergenceRegister;
    setDivergenceRegister: (register: DivergenceRegister) => void;
    editDivergenceEntry: (id: string, patch: Partial<DivergenceEntry>) => void;
    updateMessageDivergence: (messageId: string, divergenceIds: string[]) => void;
    resetDivergenceRegister: () => void;
    confirmReviewEntry: (id: string) => void;
    deleteReviewedEntry: (id: string) => void;
    toggleDivergenceChapter: (chapterId: string, on: boolean) => void;
    toggleDivergenceCategory: (chapterId: string, category: DivergenceCategory, on: boolean) => void;
    pinDivergenceFact: (entryId: string) => void;
    editDivergenceFact: (entryId: string, text: string) => void;
    deleteDivergenceFact: (entryId: string) => void;
    dismissDivergenceReviewFlag: (entryId: string) => void;
    deleteDivergenceChapter: (chapterId: string) => void;
    toggleDivergenceFact: (entryId: string, on: boolean) => void;
    setManyFactsEnabled: (updates: Array<{ id: string; enabled: boolean }>) => void;
    setTopicClusters: (clusters: TopicClusters) => void;
    migrateDivergenceIfNeeded: () => void;

    pinnedExcerpts: PinnedExcerpt[];
    addPinnedExcerpt: (sourceMessageId: string, text: string, isFullMessage: boolean) => { ok: true } | { ok: false; reason: string };
    removePinnedExcerpt: (id: string) => void;
    clearPinnedExcerpts: () => void;

    loreCheckOpen: boolean;
    loreCheckLoading: boolean;
    loreCheckSelection: LoreCheckSelection | null;
    loreCheckResult: LoreCheckResult | null;
    loreCheckStatus: string;
    loreCheckError: string | null;
    openLoreCheck: (selection: LoreCheckSelection) => void;
    setLoreCheckStatus: (status: string) => void;
    setLoreCheckResult: (result: LoreCheckResult) => void;
    setLoreCheckError: (err: string) => void;
    closeLoreCheck: () => void;
    setMessageImage: (messageId: string, image: ChatMessage['image']) => void;
};

// ── Cross-slice dependencies ───────────────────────────────────────────

type ChatDeps = ChatSlice & {
    activeCampaignId: string | null;
    context: GameContext;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createChatSlice: StateCreator<ChatDeps, [], [], ChatSlice> = (set) => ({
    // Condenser defaults
    condenser: {
        condensedUpToIndex: -1,
    },
    setCondensed: (upToIndex) =>
        set((s) => ({
            condenser: { ...s.condenser, condensedUpToIndex: upToIndex },
        })),
    setCondenser: (newState) => set({ condenser: newState }),
    resetCondenser: () =>
        set({ condenser: { condensedUpToIndex: -1 } } as Partial<ChatDeps>),

    divergenceRegister: { ...EMPTY_REGISTER },
    setDivergenceRegister: (register) =>
        set((s) => {
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, register);
            return { divergenceRegister: register };
        }),
    editDivergenceEntry: (id, patch) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e => {
                if (e.id !== id) return e;
                return { ...e, ...patch };
            });
            const reg = { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() };
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    updateMessageDivergence: (messageId, divergenceIds) =>
        set((s) => {
            const msgs = s.messages.map(m =>
                m.id === messageId ? { ...m, divergenceIds } : m
            );
            return { messages: msgs };
        }),
    resetDivergenceRegister: () =>
        set({ divergenceRegister: { ...EMPTY_REGISTER } } as Partial<ChatDeps>),
    confirmReviewEntry: (id) =>
        set((s) => {
            const reg = dismissReviewFlag(s.divergenceRegister, id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    deleteReviewedEntry: (id) =>
        set((s) => {
            const reg = deleteFact(s.divergenceRegister, id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    toggleDivergenceChapter: (chapterId, on) =>
        set((s) => {
            const reg = toggleChapter(s.divergenceRegister, chapterId, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    toggleDivergenceCategory: (chapterId, category, on) =>
        set((s) => {
            const reg = toggleCategory(s.divergenceRegister, chapterId, category, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    pinDivergenceFact: (entryId) =>
        set((s) => {
            const reg = pinFact(s.divergenceRegister, entryId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    editDivergenceFact: (entryId, text) =>
        set((s) => {
            const reg = editFact(s.divergenceRegister, entryId, text);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    deleteDivergenceFact: (entryId) =>
        set((s) => {
            let reg = deleteFact(s.divergenceRegister, entryId);
            if (reg.topicClusters) {
                const groups = reg.topicClusters.groups.map(g => ({
                    ...g,
                    factIds: g.factIds.filter(id => id !== entryId),
                })).filter(g => g.factIds.length > 0);
                reg = { ...reg, topicClusters: { ...reg.topicClusters, groups } };
            }
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    dismissDivergenceReviewFlag: (entryId) =>
        set((s) => {
            const reg = dismissReviewFlag(s.divergenceRegister, entryId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    deleteDivergenceChapter: (chapterId) =>
        set((s) => {
            const reg = deleteChapter(s.divergenceRegister, chapterId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    toggleDivergenceFact: (entryId, on) =>
        set((s) => {
            const reg = toggleFact(s.divergenceRegister, entryId, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    setManyFactsEnabled: (updates) =>
        set((s) => {
            const updateMap = new Map(updates.map(u => [u.id, u.enabled]));
            let reg = s.divergenceRegister;
            for (const [id, on] of updateMap) {
                reg = toggleFact(reg, id, on);
            }
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    setTopicClusters: (clusters) =>
        set((s) => {
            const reg = { ...s.divergenceRegister, topicClusters: clusters };
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    migrateDivergenceIfNeeded: () =>
        set((s) => {
            const reg = s.divergenceRegister;
            if (reg.version < 2) {
                const migrated = migrateV1ToV2(reg as any);
                debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
                saveDivergence(s.activeCampaignId, migrated);
                return { divergenceRegister: migrated };
            }
            return s;
        }),

    // Chat defaults
    messages: [],
    isStreaming: false,
    addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
    updateLastAssistant: (content) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
                msgs[lastIdx] = { ...msgs[lastIdx], content };
            }
            return { messages: msgs };
        }),
    updateLastMessage: (patch) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0) {
                msgs[lastIdx] = { ...msgs[lastIdx], ...patch };
            }
            return { messages: msgs };
        }),
    updateMessageContent: (id, content) =>
        set((s) => {
            const msgs = s.messages.map(m => m.id === id ? { ...m, content } : m);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
    replaceMessageText: (id, oldText, newText) =>
        set((s) => {
            const msgs = s.messages.map(m => {
                if (m.id !== id) return m;
                const next = { ...m };
                if (typeof m.content === 'string' && m.content.includes(oldText)) {
                    next.content = m.content.replace(oldText, newText);
                }
                if (typeof m.displayContent === 'string' && m.displayContent.includes(oldText)) {
                    next.displayContent = m.displayContent.replace(oldText, newText);
                }
                return next;
            });
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
    renameAcrossMessages: (from, to) => {
        const fromTrim = from.trim();
        if (!fromTrim || !to.trim()) return 0;
        // Whole-word, case-insensitive. \b sits before a trailing possessive so
        // "Elara's" → "<to>'s". Replacement keeps the user-typed casing verbatim.
        // Fresh regex per call; replace-and-compare avoids global-regex lastIndex bugs.
        const pat = `\\b${fromTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        let changed = 0;
        set((s) => {
            const msgs = s.messages.map(m => {
                const next = { ...m };
                let touched = false;
                if (typeof m.content === 'string') {
                    const rep = m.content.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.content) { next.content = rep; touched = true; }
                }
                if (typeof m.displayContent === 'string') {
                    const rep = m.displayContent.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.displayContent) { next.displayContent = rep; touched = true; }
                }
                if (touched) changed++;
                return next;
            });
            if (changed === 0) return {};
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        });
        return changed;
    },
    deleteMessage: (id) =>
        set((s) => {
            const msgs = s.messages.filter(m => m.id !== id);
            if (s.activeCampaignId) imageStorage.delete(s.activeCampaignId, id).catch(() => {});
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
    deleteMessagesFrom: (id) =>
        set((s) => {
            const index = s.messages.findIndex(m => m.id === id);
            if (index === -1) return { messages: s.messages };
            const removed = s.messages.slice(index);
            if (s.activeCampaignId) {
                for (const m of removed) {
                    imageStorage.delete(s.activeCampaignId, m.id).catch(() => {});
                }
            }
            const msgs = s.messages.slice(0, index);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v } as Partial<ChatDeps>),
    clearChat: () => set((s) => {
        const newCondenser = { condensedUpToIndex: -1 };
        const newDivReg = { ...EMPTY_REGISTER };
        if (s.activeCampaignId) imageStorage.deleteAll(s.activeCampaignId).catch(() => {});
        debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: [], condenser: newCondenser, pinnedExcerpts: [] });
        return { messages: [], condenser: newCondenser, divergenceRegister: newDivReg, pinnedExcerpts: [] };
    }),
    clearArchive: () => set({ archiveIndex: [] } as unknown as Partial<ChatDeps>),

    // Pinned Excerpts
    pinnedExcerpts: [],
    addPinnedExcerpt: (sourceMessageId, text, isFullMessage) => {
        let result: { ok: true } | { ok: false; reason: string } = { ok: true };
        set((s) => {
            const newTokens = countTokens(text);
            const currentTotal = s.pinnedExcerpts.reduce((sum, e) => sum + countTokens(e.text), 0);
            if (currentTotal + newTokens > PINNED_EXCERPTS_TOKEN_CAP) {
                result = { ok: false, reason: 'Pinned memories full — unpin something first' };
                return s;
            }
            const excerpt: PinnedExcerpt = {
                id: `pin_${uid()}`,
                sourceMessageId,
                text,
                createdAt: Date.now(),
                isFullMessage,
            };
            const pinnedExcerpts = [...s.pinnedExcerpts, excerpt];
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts });
            return { pinnedExcerpts };
        });
        return result;
    },
    removePinnedExcerpt: (id) =>
        set((s) => {
            const pinnedExcerpts = s.pinnedExcerpts.filter(e => e.id !== id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts });
            return { pinnedExcerpts };
        }),
    clearPinnedExcerpts: () =>
        set((s) => {
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: [] });
            return { pinnedExcerpts: [] };
        }),

    loreCheckOpen: false,
    loreCheckLoading: false,
    loreCheckSelection: null,
    loreCheckResult: null,
    loreCheckStatus: '',
    loreCheckError: null,
    openLoreCheck: (selection) =>
        set({
            loreCheckOpen: true,
            loreCheckLoading: true,
            loreCheckSelection: selection,
            loreCheckResult: null,
            loreCheckStatus: 'Preparing...',
            loreCheckError: null,
        }),
    setLoreCheckStatus: (status) => set({ loreCheckStatus: status }),
    setLoreCheckResult: (result) =>
        set({ loreCheckResult: result, loreCheckLoading: false, loreCheckStatus: '' }),
    setLoreCheckError: (err) =>
        set({ loreCheckError: err, loreCheckLoading: false, loreCheckStatus: '' }),
    closeLoreCheck: () =>
        set({
            loreCheckOpen: false,
            loreCheckLoading: false,
            loreCheckSelection: null,
            loreCheckResult: null,
            loreCheckStatus: '',
            loreCheckError: null,
        }),
    setMessageImage: (messageId, image) =>
        set((s) => {
            const msgs = s.messages.map(m =>
                m.id === messageId ? { ...m, image } : m
            );
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
});
