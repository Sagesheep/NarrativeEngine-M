import type { StateCreator } from 'zustand';
import type { ChatMessage, CondenserState, GameContext, LoreCheckSelection, LoreCheckResult, DivergenceRegister, DivergenceEntry, DivergenceCategory } from '../../types';
import { EMPTY_REGISTER, toggleChapter, toggleCategory, pinFact, editFact, deleteFact, dismissReviewFlag, migrateV1ToV2 } from '../../services/divergenceRegister';
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
    migrateDivergenceIfNeeded: () => void;

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
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: register };
        }),
    editDivergenceEntry: (id, patch) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e => {
                if (e.id !== id) return e;
                return { ...e, ...patch };
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
        set({ divergenceRegister: { ...EMPTY_REGISTER } } as Partial<ChatDeps>),
    confirmReviewEntry: (id) =>
        set((s) => {
            const reg = dismissReviewFlag(s.divergenceRegister, id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    deleteReviewedEntry: (id) =>
        set((s) => {
            const reg = deleteFact(s.divergenceRegister, id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    toggleDivergenceChapter: (chapterId, on) =>
        set((s) => {
            const reg = toggleChapter(s.divergenceRegister, chapterId, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    toggleDivergenceCategory: (chapterId, category, on) =>
        set((s) => {
            const reg = toggleCategory(s.divergenceRegister, chapterId, category, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    pinDivergenceFact: (entryId) =>
        set((s) => {
            const reg = pinFact(s.divergenceRegister, entryId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    editDivergenceFact: (entryId, text) =>
        set((s) => {
            const reg = editFact(s.divergenceRegister, entryId, text);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    deleteDivergenceFact: (entryId) =>
        set((s) => {
            const reg = deleteFact(s.divergenceRegister, entryId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    dismissDivergenceReviewFlag: (entryId) =>
        set((s) => {
            const reg = dismissReviewFlag(s.divergenceRegister, entryId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: reg };
        }),
    migrateDivergenceIfNeeded: () =>
        set((s) => {
            const reg = s.divergenceRegister;
            if (reg.version < 2) {
                const migrated = migrateV1ToV2(reg as any);
                debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
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
        const newCondenser = { condensedUpToIndex: -1 };
        const newDivReg = { ...EMPTY_REGISTER };
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
