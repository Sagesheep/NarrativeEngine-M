import type { StateCreator } from 'zustand';
import type { ChatMessage, CondenserState, GameContext, LoreCheckSelection, LoreCheckResult, DivergenceRegister, DivergenceEntry, PrunedEntry } from '../../types';
import { debouncedSaveCampaignState } from './campaignSlice';

// ── Slice type ─────────────────────────────────────────────────────────

export type ChatSlice = {
    messages: ChatMessage[];
    isStreaming: boolean;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateMessageContent: (id: string, content: string) => void;
    replaceMessageText: (id: string, oldText: string, newText: string) => void;
    deleteMessage: (id: string) => void;
    deleteMessagesFrom: (id: string) => void;
    setStreaming: (v: boolean) => void;
    clearChat: () => void;
    clearArchive: () => void;

    condenser: CondenserState;
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondenser: (state: CondenserState) => void;
    setCondensing: (v: boolean) => void;
    resetCondenser: () => void;

    divergenceRegister: DivergenceRegister;
    setDivergenceRegister: (register: DivergenceRegister) => void;
    editDivergenceEntry: (id: string, patch: Partial<DivergenceEntry>) => void;
    updateMessageDivergence: (messageId: string, divergenceIds: string[]) => void;
    resetDivergenceRegister: () => void;
    confirmReviewEntry: (id: string) => void;
    deleteReviewedEntry: (id: string) => void;
    restorePrunedEntry: (prunedIndex: number) => void;

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
        condensedSummary: '',
        condensedUpToIndex: -1,
        isCondensing: false,
    },
    setCondensed: (summary, upToIndex) =>
        set((s) => {
            const safeSummary = summary || s.condenser.condensedSummary;
            return {
                condenser: { ...s.condenser, condensedSummary: safeSummary, condensedUpToIndex: upToIndex },
            };
        }),
    setCondenser: (newState) => set({ condenser: newState }),
    setCondensing: (v) =>
        set((s) => ({ condenser: { ...s.condenser, isCondensing: v } })),
    resetCondenser: () =>
        set({ condenser: { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false } } as Partial<ChatDeps>),

    divergenceRegister: { entries: [], prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 },
    setDivergenceRegister: (register) =>
        set((s) => {
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: register };
        }),
    editDivergenceEntry: (id, patch) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e => {
                if (e.id !== id) return e;
                const updated = { ...e, ...patch };
                const fieldsChanged = patch.category !== undefined || patch.subject !== undefined || patch.divergence !== undefined || patch.sceneRef !== undefined;
                if (fieldsChanged && updated.parseError) updated.parseError = false;
                return updated;
            });
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    updateMessageDivergence: (messageId, divergenceIds) =>
        set((s) => {
            const msgs = s.messages.map(m =>
                m.id === messageId ? { ...m, divergenceIds } : m
            );
            return { messages: msgs };
        }),
    resetDivergenceRegister: () =>
        set({ divergenceRegister: { entries: [], prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 } } as Partial<ChatDeps>),
    confirmReviewEntry: (id) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === id ? { ...e, reviewFlag: false } : e
            );
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    deleteReviewedEntry: (id) =>
        set((s) => {
            const entry = s.divergenceRegister.entries.find(e => e.id === id);
            if (!entry) return s;
            const entries = s.divergenceRegister.entries.filter(e => e.id !== id);
            const newPruned: PrunedEntry = {
                originalEntry: entry,
                prunedAt: Date.now(),
                chapterId: '',
                verdict: 'user_deleted_review',
                reason: 'User manually deleted after review',
            };
            const prunedLog = [...(s.divergenceRegister.prunedLog ?? []), newPruned];
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: { ...s.divergenceRegister, entries, prunedLog, lastUpdatedAt: Date.now() } };
        }),
    restorePrunedEntry: (prunedIndex) =>
        set((s) => {
            const prunedLog = s.divergenceRegister.prunedLog ?? [];
            if (prunedIndex < 0 || prunedIndex >= prunedLog.length) return s;
            const restored = prunedLog[prunedIndex];
            const entry: DivergenceEntry = { ...restored.originalEntry, reviewFlag: false };
            const newLog = prunedLog.filter((_, i) => i !== prunedIndex);
            const entries = [...s.divergenceRegister.entries, entry];
            entries.sort((a, b) => parseInt(a.sceneRef) - parseInt(b.sceneRef));
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: { ...s.divergenceRegister, entries, prunedLog: newLog, lastUpdatedAt: Date.now() } };
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
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser });
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
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser });
            return { messages: msgs };
        }),
    deleteMessage: (id) =>
        set((s) => {
            const msgs = s.messages.filter(m => m.id !== id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser });
            return { messages: msgs };
        }),
    deleteMessagesFrom: (id) =>
        set((s) => {
            const index = s.messages.findIndex(m => m.id === id);
            if (index === -1) return { messages: s.messages };
            const msgs = s.messages.slice(0, index);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser });
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v } as Partial<ChatDeps>),
    clearChat: () => set((s) => {
        const newCondenser = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };
        const newDivReg = { entries: [], prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 };
        debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: [], condenser: newCondenser });
        return { messages: [], condenser: newCondenser, divergenceRegister: newDivReg };
    }),
    clearArchive: () => set({ archiveIndex: [] } as unknown as Partial<ChatDeps>),

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
});
