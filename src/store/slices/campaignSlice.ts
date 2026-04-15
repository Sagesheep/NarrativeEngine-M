import type { StateCreator } from 'zustand';
import type { GameContext, ChatMessage, CondenserState, LoreChunk, ArchiveIndexEntry, NPCEntry, ArchiveChapter, SemanticFact, TimelineEvent, EntityEntry } from '../../types';
import { toast } from '../../components/Toast';
import { debouncedSaveSettings } from './settingsSlice';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from './settingsSlice';

// ── Debounced save helpers ─────────────────────────────────────────────

let stateTimer: ReturnType<typeof setTimeout> | null = null;
let loreTimer: ReturnType<typeof setTimeout> | null = null;
let autoBackupTimer: ReturnType<typeof setInterval> | null = null;
let _getStateForSave: (() => { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }) | null = null;

export function debouncedSaveCampaignState(campaignId: string | null, _state: { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }) {
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

export function debouncedSaveLoreChunks(campaignId: string, chunks: import('../../types').LoreChunk[]) {
    if (!campaignId) return;
    if (loreTimer) clearTimeout(loreTimer);
    loreTimer = setTimeout(async () => {
        const { saveLoreChunks } = await import('../../store/campaignStore');
        await saveLoreChunks(campaignId, chunks);
    }, 1000);
}

let npcTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveNPCLedger(campaignId: string | null, npcs: NPCEntry[]) {
    if (!campaignId) return;
    if (npcTimer) clearTimeout(npcTimer);
    npcTimer = setTimeout(async () => {
        try {
            const { saveNPCLedger } = await import('../../store/campaignStore');
            await saveNPCLedger(campaignId, npcs);
        } catch (e) {
            console.error(e);
            toast.error('Failed to save NPC ledger');
        }
    }, 1000);
}

/**
 * Deduplicates the NPC ledger by name comparison:
 *   Rule 1: Exact full-name match -> keep the newer (later in array) entry
 *   Rule 2: First-name-only entry matches a full-name entry -> keep the fuller/newer entry
 *   Rule 3: Same first name but different last names -> do NOT touch
 */
export function dedupeNPCLedger(ledger: NPCEntry[]): NPCEntry[] {
    const removeIndices = new Set<number>();

    for (let i = 0; i < ledger.length; i++) {
        if (removeIndices.has(i)) continue;

        const nameI = ledger[i].name.trim().toLowerCase();
        const partsI = nameI.split(/\s+/);
        const firstI = partsI[0];
        const hasLastI = partsI.length > 1;

        for (let j = i + 1; j < ledger.length; j++) {
            if (removeIndices.has(j)) continue;

            const nameJ = ledger[j].name.trim().toLowerCase();
            const partsJ = nameJ.split(/\s+/);
            const firstJ = partsJ[0];
            const hasLastJ = partsJ.length > 1;

            // Rule 1: Exact full name match -> remove the older (i)
            if (nameI === nameJ) {
                console.log(`[NPC Dedup] Exact match: "${ledger[i].name}" == "${ledger[j].name}" → removing older entry`);
                removeIndices.add(i);
                break;
            }

            // Rule 2: First-name-only entry matches a first+last entry
            if (!hasLastI && hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[i].name}" ⊂ "${ledger[j].name}" → removing shorter entry`);
                removeIndices.add(i);
                break;
            }
            if (hasLastI && !hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[j].name}" ⊂ "${ledger[i].name}" → removing shorter entry`);
                removeIndices.add(j);
                continue;
            }

            // Rule 3: Same first name, different last names -> do NOT touch
        }
    }

    if (removeIndices.size > 0) {
        console.log(`[NPC Dedup] Removed ${removeIndices.size} duplicate(s) from ledger`);
    }

    return ledger.filter((_, idx) => !removeIndices.has(idx));
}

// ── Default context ────────────────────────────────────────────────────

export const defaultContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: '',
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    canonStateActive: false,
    headerIndexActive: false,
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
    worldVibe: '',
    enemyPlayerActive: false,
    neutralPlayerActive: false,
    allyPlayerActive: false,
    enemyPlayerPrompt: 'You are the ENEMY AI. Inject narrative friction and opposition.',
    neutralPlayerPrompt: 'You are the NEUTRAL AI. Inject environmental chaos or third-party reactions.',
    allyPlayerPrompt: 'You are the ALLY AI. Inject narrative assistance and beneficial outcomes.',
    interventionChance: 25,
    enemyCooldown: 2,
    neutralCooldown: 2,
    allyCooldown: 2,
    interventionQueue: [],
    worldEventConfig: {
        initialDC: 498,
        dcReduction: 2,
        who: [...DEFAULT_WORLD_WHO],
        where: [...DEFAULT_WORLD_WHERE],
        why: [...DEFAULT_WORLD_WHY],
        what: [...DEFAULT_WORLD_WHAT],
    },
    coreMemorySlots: [],
    notebook: [],
    notebookActive: true,
    inventoryLastScene: 'Never',
    characterProfileLastScene: 'Never',
};

// ── Slice type ─────────────────────────────────────────────────────────

export type CampaignSlice = {
    activeCampaignId: string | null;
    setActiveCampaign: (id: string | null) => void;
    loreChunks: LoreChunk[];
    setLoreChunks: (chunks: LoreChunk[]) => void;
    updateLoreChunk: (id: string, patch: Partial<LoreChunk>) => void;
    archiveIndex: ArchiveIndexEntry[];
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    npcLedger: NPCEntry[];
    setNPCLedger: (npcs: NPCEntry[]) => void;
    addNPC: (npc: NPCEntry) => void;
    addNPCs: (newNpcs: NPCEntry[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    removeNPC: (id: string) => void;

    context: GameContext;
    updateContext: (patch: Partial<GameContext>) => void;

    // Phase 6: Chapter and semantic fact support
    chapters: ArchiveChapter[];
    semanticFacts: SemanticFact[];
    setChapters: (chapters: ArchiveChapter[]) => void;
    setSemanticFacts: (facts: SemanticFact[]) => void;
    preOpBackup: (campaignId: string, trigger: string) => Promise<void>;
    _registerCampaignStateGetter: (getter: () => { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }) => void;

    // Timeline / World State
    timeline: TimelineEvent[];
    setTimeline: (events: TimelineEvent[]) => void;
    addTimelineEvent: (event: TimelineEvent) => void;
    removeTimelineEvent: (eventId: string) => void;

    // Entity Registry
    entities: EntityEntry[];
    setEntities: (entities: EntityEntry[]) => void;

    // Pinned Chapters
    pinnedChapterIds: string[];
    pinChapter: (chapterId: string) => void;
    clearPinnedChapters: () => void;

    // Auto Bookkeeping
    bookkeepingTurnCounter: number;
    autoBookkeepingInterval: number;
    setAutoBookkeepingInterval: (interval: number) => void;
    resetBookkeepingTurnCounter: () => void;
    incrementBookkeepingTurnCounter: () => number;
};

// ── Combined state needed for cross-slice access ───────────────────────

type CampaignDeps = CampaignSlice & {
    settings: import('../../types').AppSettings;
    messages: ChatMessage[];
    condenser: CondenserState;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createCampaignSlice: StateCreator<CampaignDeps, [], [], CampaignSlice> = (set, get) => ({
    activeCampaignId: null,
    setActiveCampaign: async (id) => {
        set({ activeCampaignId: id } as Partial<CampaignDeps>);
        const s = get();
        debouncedSaveSettings(s.settings, id);
        
        import('../../services/backgroundQueue').then(({ backgroundQueue }) => {
            backgroundQueue.clear('Campaign switched');
        }).catch(() => {});

        if (autoBackupTimer) {
            clearInterval(autoBackupTimer);
            autoBackupTimer = null;
        }

        if (id) {
            try {
                const { loadChapters, loadSemanticFacts, loadTimeline, loadEntities } = await import('../../store/campaignStore');
                const [chapters, facts, timeline, entities] = await Promise.all([
                    loadChapters(id),
                    loadSemanticFacts(id),
                    loadTimeline(id).catch(() => []),
                    loadEntities(id).catch(() => []),
                ]);
                set({ chapters, semanticFacts: facts, timeline, entities } as Partial<CampaignDeps>);
            } catch (err) {
                console.warn('[Campaign] Failed to load chapters/facts:', err);
            }

            import('../../services/embedder').then(({ warmupEmbedder }) => {
                return warmupEmbedder();
            }).then(() => {
                console.log('[Embedder] Model warmed up and ready');
            }).catch(e => {
                console.warn('[Embedder] Warmup failed, semantic search will use keyword fallback:', e);
            });

            autoBackupTimer = setInterval(async () => {
                const state = get();
                if (!state.activeCampaignId) return;
                try {
                    const { offlineStorage } = await import('../../services/offlineStorage');
                    await offlineStorage.backup.create(state.activeCampaignId, {
                        trigger: 'auto',
                        isAuto: true,
                    });
                } catch (e) {
                    console.warn('[Auto-Backup] Failed:', e);
                }
            }, 10 * 60 * 1000);
        }
    },
    loreChunks: [],
    setLoreChunks: (chunks) => set({ loreChunks: chunks } as Partial<CampaignDeps>),
    updateLoreChunk: (id, patch) => set((s) => {
        const newChunks = s.loreChunks.map(c => c.id === id ? { ...c, ...patch } : c);
        if (s.activeCampaignId) {
            import('../../store/campaignStore').then(mod => mod.saveLoreChunks(s.activeCampaignId!, newChunks));
        }
        return { loreChunks: newChunks };
    }),
    archiveIndex: [],
    setArchiveIndex: (entries) => set({ archiveIndex: entries } as Partial<CampaignDeps>),
    npcLedger: [],
    setNPCLedger: (npcs) => set((s) => {
        debouncedSaveNPCLedger(s.activeCampaignId, npcs);
        return { npcLedger: npcs };
    }),
    addNPC: (npc) => set((s) => {
        const withNew = [...s.npcLedger, npc];
        const deduped = dedupeNPCLedger(withNew);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    addNPCs: (newNpcs) => set((s) => {
        const withNew = [...s.npcLedger, ...newNpcs];
        const deduped = dedupeNPCLedger(withNew);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    updateNPC: (id, patch) => set((s) => {
        const newLedger = s.npcLedger.map(n => n.id === id ? { ...n, ...patch } : n);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    removeNPC: (id) => set((s) => {
        const newLedger = s.npcLedger.filter(n => n.id !== id);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),

    context: { ...defaultContext },
    updateContext: (patch) =>
        set((s) => {
            const newContext = { ...s.context, ...patch };
            debouncedSaveCampaignState(s.activeCampaignId, { context: newContext, messages: s.messages, condenser: s.condenser });
            return { context: newContext };
        }),

    // Phase 6: Chapter and semantic fact state
    chapters: [],
    semanticFacts: [],
    setChapters: (chapters) => set({ chapters } as Partial<CampaignDeps>),
    setSemanticFacts: (facts) => set({ semanticFacts: facts } as Partial<CampaignDeps>),
    preOpBackup: async (campaignId, trigger) => {
        const { api } = await import('../../services/apiClient');
        await api.backup.create(campaignId, { trigger, isAuto: true });
    },
    _registerCampaignStateGetter: (getter) => {
        _getStateForSave = getter;
    },

    // Timeline
    timeline: [],
    setTimeline: (events) => set({ timeline: events } as Partial<CampaignDeps>),
    addTimelineEvent: (event) => set((s) => ({ timeline: [...s.timeline, event] })) as any,
    removeTimelineEvent: (eventId) => set((s) => ({ timeline: s.timeline.filter((e: TimelineEvent) => e.id !== eventId) })) as any,

    // Entities
    entities: [],
    setEntities: (entities) => set({ entities } as Partial<CampaignDeps>),

    // Pinned Chapters
    pinnedChapterIds: [],
    pinChapter: (chapterId) => set((s) => {
        const pinned = s.pinnedChapterIds.includes(chapterId)
            ? s.pinnedChapterIds.filter((id: string) => id !== chapterId)
            : [...s.pinnedChapterIds, chapterId];
        return { pinnedChapterIds: pinned };
    }) as any,
    clearPinnedChapters: () => set({ pinnedChapterIds: [] } as Partial<CampaignDeps>),

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
