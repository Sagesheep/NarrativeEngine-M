import type { StateCreator } from 'zustand';
import type { PayloadTrace, PipelinePhase, StreamingStats, ManualRollRequest } from '../../types';
import type { OneShotEventId } from '../../services/oneshot/oneShotEvents';

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
    /** Soft-keyboard height in CSS px as reported by Capacitor Keyboard events,
     *  0 when hidden. Used to lift only the chat input above the keyboard, not
     *  shrink the whole reading area. */
    keyboardHeight: number;
    setKeyboardVisible: (visible: boolean) => void;
    setKeyboardHeight: (height: number) => void;
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
    /** Optional user query staged from the Deep Search sheet. '' = classic keying. */
    deepSearchQuery: string;
    /** Atomic arm + query set; setDeepSearch(false, '') disarms and clears. */
    setDeepSearch: (armed: boolean, query: string) => void;
    // Player-called dice ("dice me"): the armed roll request, resolved at send time. null = not armed.
    // Accepts the new ManualRollRequest shape OR legacy '1d20'|'adv'|'disadv' string.
    armedRoll: ManualRollRequest | string | null;
    setArmedRoll: (mode: ManualRollRequest | string | null) => void;
    // Dice roll modal (3-gate configurator)
    diceRollModalOpen: boolean;
    openDiceRollModal: () => void;
    closeDiceRollModal: () => void;
    // Loot Engine WO-05: armed loot drop config, resolved at send time. Mirrors armedRoll.
    armedLoot: ArmedLoot | null;
    armLoot: (payload: ArmedLoot) => void;
    clearArmedLoot: () => void;
    /** Absolute Command: a binding out-of-character instruction for the next send only. null = not armed. */
    armedAbsoluteCommand: string | null;
    setArmedAbsoluteCommand: (text: string | null) => void;
    /** One-Shot Event Injector: the event type that fires on the next send. null = not armed. */
    armedOneShot: OneShotEventId | null;
    setArmedOneShot: (id: OneShotEventId | null) => void;
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
    keyboardHeight: 0,
    setKeyboardVisible: (visible) => set({ keyboardVisible: visible }),
    setKeyboardHeight: (height) => set({ keyboardHeight: height }),
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
    deepSearchQuery: '',
    setDeepSearch: (armed, query) => set({ deepArmed: armed, deepSearchQuery: query }),
    armedRoll: null,
    setArmedRoll: (mode) => set({ armedRoll: mode }),
    diceRollModalOpen: false,
    openDiceRollModal: () => set({ diceRollModalOpen: true }),
    closeDiceRollModal: () => set({ diceRollModalOpen: false }),
    armedLoot: null,
    armLoot: (payload) => set({ armedLoot: payload }),
    clearArmedLoot: () => set({ armedLoot: null }),
    armedAbsoluteCommand: null,
    setArmedAbsoluteCommand: (text) => set({ armedAbsoluteCommand: text }),
    armedOneShot: null,
    setArmedOneShot: (id) => set({ armedOneShot: id }),
    embeddingsReindexing: { active: false, total: 0, done: 0, reason: null },
    setEmbeddingsReindexing: (state) => set({ embeddingsReindexing: state }),
});

