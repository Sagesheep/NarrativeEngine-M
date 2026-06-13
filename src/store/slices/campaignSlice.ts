import type { StateCreator } from 'zustand';
import type { GameContext, ChatMessage, CondenserState, DivergenceRegister } from '../../types';
import type { ArchiveSlice } from './archiveSlice';
import type { LoreSlice } from './loreSlice';
import type { NPCSlice } from './npcSlice';
import { toast } from '../../components/Toast';
import { debouncedSaveSettings } from './settingsSlice';
import { runFullReindex, abortForCampaignSwitch } from '../../services/embedding';
import { embeddingStorage } from '../../services/storage/embeddingStorage';
import { EMPTY_REGISTER } from '../../services/campaign-state';
import type { CombatSlice } from './combatSlice';
import type { ItemSlice } from './itemSlice';
import type { SkillSlice } from './skillSlice';
import { backfillNPCCombatStats } from '../settingsMigration';
import { CANON_SKILL_DEFS } from './skillSlice';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
    DEFAULT_COMBAT_CONFIG, DEFAULT_STAT_LABEL_MAP,
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
            toast.error('Failed to save campaign state');
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
    characterProfile: '',
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceConfig: {
        catastrophe: 2,
        failure: 6,
        success: 15,
        triumph: 19,
        crit: 20
    },
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
    combatModeActive: false,
    combatConfig: { ...DEFAULT_COMBAT_CONFIG },
    statLabelMap: { ...DEFAULT_STAT_LABEL_MAP },
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

type CampaignDeps = CampaignSlice & ArchiveSlice & LoreSlice & NPCSlice & CombatSlice & ItemSlice & SkillSlice & {
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
            getCombatState, getItemCompendium, getSkillCompendium,
        } = await import('../../store/campaignStore');

        const [campaignState, loreChunks, rawNpcLedger, archiveIndex, divReg, combatState, items, skills] = await Promise.all([
            loadCampaignState(id),
            getLoreChunks(id),
            getNPCLedger(id),
            loadArchiveIndex(id),
            loadDivergenceRegister(id),
            getCombatState(id),
            getItemCompendium(id),
            getSkillCompendium(id),
        ]);
        const [chapters, semanticFacts, timeline, entities] = await Promise.all([
            loadChapters(id).catch(() => []),
            loadSemanticFacts(id).catch(() => []),
            loadTimeline(id).catch(() => []),
            loadEntities(id).catch(() => []),
        ]);

        const npcLedger = backfillNPCCombatStats(rawNpcLedger);
        const resolvedSkills = (skills && skills.length > 0) ? skills : [...CANON_SKILL_DEFS];

        set({
            activeCampaignId: id,
            context: { ...defaultContext, ...(campaignState?.context ?? {}) },
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
            combatState,
            items,
            skills: resolvedSkills,
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
                    toast.success('Re-indexing complete');
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
            debouncedSaveCampaignState(s.activeCampaignId, { context: newContext, messages: s.messages, condenser: s.condenser, pinnedExcerpts: (s as any).pinnedExcerpts });
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
