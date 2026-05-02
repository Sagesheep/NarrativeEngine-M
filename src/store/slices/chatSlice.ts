import type { StateCreator } from 'zustand';
import type { ChatMessage, CondenserState, GameContext, LoreCheckSelection, LoreCheckResult, DivergenceRegister } from '../../types';
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
    updateMessageDivergence: (messageId: string, divergenceIds: string[]) => void;
    resetDivergenceRegister: () => void;

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

    divergenceRegister: { entries: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 },
    setDivergenceRegister: (register) =>
        set((s) => {
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser });
            return { divergenceRegister: register };
        }),
    updateMessageDivergence: (messageId, divergenceIds) =>
        set((s) => {
            const msgs = s.messages.map(m =>
                m.id === messageId ? { ...m, divergenceIds } : m
            );
            return { messages: msgs };
        }),
    resetDivergenceRegister: () =>
        set({ divergenceRegister: { entries: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 } } as Partial<ChatDeps>),

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
        const newDivReg = { entries: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 };
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
