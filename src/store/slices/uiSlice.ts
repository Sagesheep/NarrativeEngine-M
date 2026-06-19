import type { StateCreator } from 'zustand';
import type { PayloadTrace, PipelinePhase, StreamingStats, InventoryProposal } from '../../types';

export type ReindexState = {
    active: boolean;
    total: number;
    done: number;
    reason: 'switch' | 'lazy' | 'progressive' | null;
};

export type UISlice = {
    settingsOpen: boolean;
    drawerOpen: boolean;
    npcLedgerOpen: boolean;
    backupModalOpen: boolean;
    lastPayloadTrace?: PayloadTrace[];
    pipelinePhase: PipelinePhase;
    streamingStats: StreamingStats | null;
    mobileView: 'chat' | 'context' | 'npcs' | 'settings';
    toggleSettings: () => void;
    toggleDrawer: () => void;
    toggleNPCLedger: () => void;
    toggleBackupModal: () => void;
    setLastPayloadTrace: (trace?: PayloadTrace[]) => void;
    setPipelinePhase: (phase: PipelinePhase) => void;
    setStreamingStats: (stats: StreamingStats | null) => void;
    setMobileView: (view: 'chat' | 'context' | 'npcs' | 'settings') => void;
    deepArmed: boolean;
    setDeepArmed: (val: boolean) => void;
    toggleDeepArmed: () => void;
    pendingCombatPrompt: { entitiesReferenced: string[]; originalInput: string } | null;
    setPendingCombatPrompt: (prompt: { entitiesReferenced: string[]; originalInput: string } | null) => void;
    pendingInventoryProposal: InventoryProposal | null;
    setPendingInventoryProposal: (proposal: InventoryProposal | null) => void;
    embeddingsReindexing: ReindexState;
    setEmbeddingsReindexing: (state: ReindexState) => void;
};

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
    settingsOpen: false,
    drawerOpen: true,
    npcLedgerOpen: false,
    backupModalOpen: false,
    pipelinePhase: 'idle' as PipelinePhase,
    streamingStats: null,
    mobileView: 'chat' as const,
    toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
    toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
    toggleNPCLedger: () => set((s) => ({ npcLedgerOpen: !s.npcLedgerOpen })),
    toggleBackupModal: () => set((s) => ({ backupModalOpen: !s.backupModalOpen })),
    setLastPayloadTrace: (trace) => set({ lastPayloadTrace: trace }),
    setPipelinePhase: (phase) => set({ pipelinePhase: phase }),
    setStreamingStats: (stats) => set({ streamingStats: stats }),
    setMobileView: (view) => set({ mobileView: view }),
    deepArmed: false,
    setDeepArmed: (val) => set({ deepArmed: val }),
    toggleDeepArmed: () => set((s) => ({ deepArmed: !s.deepArmed })),
    pendingCombatPrompt: null,
    setPendingCombatPrompt: (prompt) => set({ pendingCombatPrompt: prompt }),
    pendingInventoryProposal: null,
    setPendingInventoryProposal: (proposal) => set({ pendingInventoryProposal: proposal }),
    embeddingsReindexing: { active: false, total: 0, done: 0, reason: null },
    setEmbeddingsReindexing: (state) => set({ embeddingsReindexing: state }),
});

