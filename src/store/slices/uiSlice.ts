import type { StateCreator } from 'zustand';
import type { ManualRollMode, PayloadTrace, PipelinePhase, StreamingStats } from '../../types';

/** Loot Engine WO-05: armed loot drop config, resolved at send time. Mirrors armedRoll. */
export type ArmedLoot = {
    rolls: number;
    /** Soft override: replace weights at named pick nodes (root pick's options from the modal). */
    reweight?: Record<string, Record<string, number>>;
};

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
    keyboardVisible: boolean;
    setKeyboardVisible: (visible: boolean) => void;
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
    // Player-called dice ("dice me"): the armed MODE, resolved at send time. null = not armed.
    armedRoll: ManualRollMode | null;
    setArmedRoll: (mode: ManualRollMode | null) => void;
    // Loot Engine WO-05: armed loot drop config, resolved at send time. Mirrors armedRoll.
    armedLoot: ArmedLoot | null;
    armLoot: (payload: ArmedLoot) => void;
    clearArmedLoot: () => void;
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
    keyboardVisible: false,
    setKeyboardVisible: (visible) => set({ keyboardVisible: visible }),
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
    armedRoll: null,
    setArmedRoll: (mode) => set({ armedRoll: mode }),
    armedLoot: null,
    armLoot: (payload) => set({ armedLoot: payload }),
    clearArmedLoot: () => set({ armedLoot: null }),
    embeddingsReindexing: { active: false, total: 0, done: 0, reason: null },
    setEmbeddingsReindexing: (state) => set({ embeddingsReindexing: state }),
});

