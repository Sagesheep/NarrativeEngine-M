import type { StateCreator } from 'zustand';
import type { GameContext, ChatMessage, CondenserState, DivergenceRegister } from '../../types';
import { buildDefaultDiceSystem, migrateDiceSystem } from '../../types';
import type { ArchiveSlice } from './archiveSlice';
import type { LoreSlice } from './loreSlice';
import type { NPCSlice } from './npcSlice';
import type { ChatSlice } from './chatSlice';
import { notify } from '../../services/ports/notify';
import { debouncedSaveSettings } from './settingsSlice';
import { runFullReindex, abortForCampaignSwitch } from '../../services/embedding';
import { embeddingStorage } from '../../services/storage/embeddingStorage';
import { EMPTY_REGISTER } from '../../services/campaign-state';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from './settingsSlice';

// ── Debounced save helpers ─────────────────────────────────────────────

let stateTimer: ReturnType<typeof setTimeout> | null = null;
let autoBackupTimer: ReturnType<typeof setInterval> | null = null;
import type { PinnedExcerpt } from '../../types';
let _getStateForSave: (() => { context: GameContext; messages: ChatMessage[]; condenser: CondenserState; pinnedExcerpts?: PinnedExcerpt[] }) | null = null;

export function debouncedSaveCampaignState(campaignId: string | null, _state: { context: GameContext; messages: ChatMessage[]; condenser: CondenserState; pinnedExcerpts?: PinnedExcerpt[] }) {
    if (!campaignId) return;
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(async () => {
        const state = _getStateForSave ? _getStateForSave() : _state;
        try {
            const { saveCampaignState } = await import('../../store/campaignStore');
            await saveCampaignState(campaignId, state);
        } catch (e) {
            console.error(e);
            notify.error('Failed to save campaign state');
        }
    }, 1000);
}

// ── Default context ────────────────────────────────────────────────────

export const defaultContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: { identity: {}, activeTraits: [] },
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    characterProfileUserDisabled: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceSystem: buildDefaultDiceSystem(),
    surpriseConfig: {
        initialDC: 95,
        dcReduction: 3,
        types: [...DEFAULT_SURPRISE_TYPES],
        tones: [...DEFAULT_SURPRISE_TONES],
    },
    encounterConfig: {
        initialDC: 198,
        dcReduction: 2,
        types: [...DEFAULT_ENCOUNTER_TYPES],
        tones: [...DEFAULT_ENCOUNTER_TONES],
    },
    worldEventConfig: {
        initialDC: 498,
        dcReduction: 2,
        who: [...DEFAULT_WORLD_WHO],
        where: [...DEFAULT_WORLD_WHERE],
        why: [...DEFAULT_WORLD_WHY],
        what: [...DEFAULT_WORLD_WHAT],
    },
    npcIntroConfig: {
        initialDC: 196,
        dcReduction: 2,
        characters: [],
    },
    npcIntroEngineActive: true,
    npcIntroDC: 196,
    notebook: [],
    notebookActive: true,
    inventoryLastScene: 'Never',
    characterProfileLastScene: 'Never',
    lastSceneStakes: 'calm',
    agencyDigest: '',
    arcs: [],
    arcDigest: '',
};

// ── Slice type ─────────────────────────────────────────────────────────

export type CampaignSlice = {
    activeCampaignId: string | null;
    setActiveCampaign: (id: string | null) => Promise<void>;

    context: GameContext;
    updateContext: (patch: Partial<GameContext>) => void;

    preOpBackup: (campaignId: string, trigger: string) => Promise<void>;
    _registerCampaignStateGetter: (getter: () => { context: GameContext; messages: ChatMessage[]; condenser: CondenserState; pinnedExcerpts?: PinnedExcerpt[] }) => void;

    // Auto Bookkeeping
    bookkeepingTurnCounter: number;
    autoBookkeepingInterval: number;
    setAutoBookkeepingInterval: (interval: number) => void;
    resetBookkeepingTurnCounter: () => void;
    incrementBookkeepingTurnCounter: () => number;
};

// ── Combined state needed for cross-slice access ───────────────────────

type CampaignDeps = CampaignSlice & ArchiveSlice & LoreSlice & NPCSlice & ChatSlice & {
    settings: import('../../types').AppSettings;
    messages: ChatMessage[];
    condenser: CondenserState;
    divergenceRegister: DivergenceRegister;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createCampaignSlice: StateCreator<CampaignDeps, [], [], CampaignSlice> = (set, get) => ({
    activeCampaignId: null,
    setActiveCampaign: async (id) => {
        abortForCampaignSwitch();

        // Swipe Generation v1: commit any pending swipe turn before switching
        // campaigns. The pending turn belongs to the OUTGOING campaign; once
        // we hydrate the new campaign's messages, the pending GM bubble is
        // gone from the store and the commit would be lost. Commit first.
        if (id !== get().activeCampaignId) {
            import('../../services/turn').then(({ commitPendingTurn }) => {
                commitPendingTurn().catch(e => console.warn('[CampaignSwitch] commitPendingTurn failed:', e));
            }).catch(() => {});
        }

        // Release the outgoing campaign's in-memory vector cache so only the
        // active campaign's vectors stay resident (covers switch and close).
        const previousCampaignId = get().activeCampaignId;
        if (previousCampaignId && previousCampaignId !== id) {
            import('../../services/storage').then(({ offlineStorage }) => {
                offlineStorage.embeddings.releaseCache(previousCampaignId);
            }).catch(() => {});
        }

        import('../../services/infrastructure').then(({ backgroundQueue }) => {
            backgroundQueue.clear('Campaign switched');
        }).catch(() => {});

        if (autoBackupTimer) {
            clearInterval(autoBackupTimer);
            autoBackupTimer = null;
        }

        debouncedSaveSettings(get().settings, id);

        if (!id) {
            set({ activeCampaignId: null } as Partial<CampaignDeps>);
            return;
        }

        // Canonical campaign-load path. Hydrate every campaign-scoped slice, then
        // commit it together with activeCampaignId in a single set() so consumers
        // never observe a campaign id without its data.
        const {
            loadCampaignState, getLoreChunks, getNPCLedger, loadArchiveIndex,
            loadDivergenceRegister, loadChapters, loadSemanticFacts, loadTimeline, loadEntities,
        } = await import('../../store/campaignStore');

        const [campaignState, loreChunks, npcLedger, archiveIndex, divReg] = await Promise.all([
            loadCampaignState(id),
            getLoreChunks(id),
            getNPCLedger(id),
            loadArchiveIndex(id),
            loadDivergenceRegister(id),
        ]);
        const [chapters, semanticFacts, timeline, entities] = await Promise.all([
            loadChapters(id).catch(() => []),
            loadSemanticFacts(id).catch(() => []),
            loadTimeline(id).catch(() => []),
            loadEntities(id).catch(() => []),
        ]);

        set({
            activeCampaignId: id,
            context: migrateDiceSystem({ ...defaultContext, ...(campaignState?.context ?? {}) }),
            messages: campaignState?.messages ?? [],
            condenser: campaignState?.condenser ?? { condensedUpToIndex: -1 },
            pinnedExcerpts: campaignState?.pinnedExcerpts ?? [],
            loreChunks,
            npcLedger,
            archiveIndex,
            divergenceRegister: divReg ?? { ...EMPTY_REGISTER },
            chapters,
            semanticFacts,
            timeline,
            entities,
        } as Partial<CampaignDeps>);

        import('../../services/embedding').then(async ({ warmupEmbedder, getCurrentModelId }) => {
            await warmupEmbedder();
            console.log('[Embedder] Model warmed up and ready');
            const { useAppStore } = await import('../../store/useAppStore');
            const hasStale = await embeddingStorage.hasStaleVectors(id, getCurrentModelId());
            if (hasStale) {
                console.log('[Campaign] Stale embedding vectors detected, triggering lazy re-index');
                useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'lazy' });
                runFullReindex(id, (progress) => {
                    useAppStore.getState().setEmbeddingsReindexing({
                        active: true,
                        total: progress.total,
                        done: progress.done,
                        reason: 'lazy',
                    });
                }).then(() => {
                    useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                    notify.success('Re-indexing complete');
                }).catch((_e) => {
                    console.error('[Campaign] Lazy re-index failed:', _e);
                    useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                });
            }
        }).catch(e => {
            console.warn('[Embedder] Warmup failed, semantic search will use keyword fallback:', e);
        });

        autoBackupTimer = setInterval(async () => {
            const state = get();
            if (!state.activeCampaignId) return;
            try {
                const { offlineStorage } = await import('../../services/storage');
                await offlineStorage.backup.create(state.activeCampaignId, {
                    trigger: 'auto',
                    isAuto: true,
                });
            } catch (e) {
                console.warn('[Auto-Backup] Failed:', e);
            }
        }, 10 * 60 * 1000);
    },

    context: { ...defaultContext },
    updateContext: (patch) =>
        set((s) => {
            const newContext = { ...s.context, ...patch };
            debouncedSaveCampaignState(s.activeCampaignId, { context: newContext, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { context: newContext };
        }),

    preOpBackup: async (campaignId, trigger) => {
        const { api } = await import('../../services/apiClient');
        await api.backup.create(campaignId, { trigger, isAuto: true });
    },
    _registerCampaignStateGetter: (getter) => {
        _getStateForSave = getter;
    },

    // Auto Bookkeeping
    bookkeepingTurnCounter: 0,
    autoBookkeepingInterval: 5,
    setAutoBookkeepingInterval: (interval) => set({ autoBookkeepingInterval: interval } as Partial<CampaignDeps>),
    resetBookkeepingTurnCounter: () => set({ bookkeepingTurnCounter: 0 } as Partial<CampaignDeps>),
    incrementBookkeepingTurnCounter: () => {
        const s = get();
        const newVal = s.bookkeepingTurnCounter + 1;
        set({ bookkeepingTurnCounter: newVal } as Partial<CampaignDeps>);
        return newVal;
    },
});
