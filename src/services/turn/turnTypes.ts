import type {
    AppSettings,
    GameContext,
    ChatMessage,
    NPCEntry,
    NPCPressure,
    LoreChunk,
    CondenserState,
    ArchiveIndexEntry,
    LLMProvider,
    SemanticFact,
    ArchiveChapter,
    TimelineEvent,
    PipelinePhase,
    StreamingStats,
    DivergenceRegister,
    PayloadTrace,
    PinnedExcerpt,
    ThinkingEffort,
    ManualRollRequest,
} from '../../types';
import type { LLMCallPriority } from '../../utils/llmCall';
import type { ArmedLoot } from '../../store/slices/uiSlice';

// ── UtilityLLM port (Plan 4 — the single injection point for utility LLM access) ──
// Wraps llmCall + utility-endpoint lookup so retrieval stages can be tested with
// scripted responses instead of network mocking. `realUtilityLLM` (utilityLLM.ts)
// is the production adapter; gatherContext defaults to it.

export interface UtilityCallOpts {
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
    priority?: LLMCallPriority;
    thinkingEffort?: ThinkingEffort;
    /** If set, registers the call with utilityCallTracker so the UI can show a countdown. */
    trackingLabel?: string;
    /** Soft deadline in ms; on expiry llmCall rejects with UtilityTimeoutError. */
    timeoutMs?: number;
}

export interface UtilityLLM {
    /** Delegates to llmCall(endpoint(), prompt, opts). Rejects if no endpoint is configured. */
    call(prompt: string, opts?: UtilityCallOpts): Promise<string>;
    /** The current utility endpoint, or undefined if none is configured. */
    endpoint(): LLMProvider | undefined;
}

export type TurnCallbacks = {
    onCheckingNotes: (checking: boolean) => void;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    addNPC: (npc: NPCEntry) => void;
    // Newly-detected names are no longer auto-added; they're surfaced as
    // suggestions the player promotes (or dismisses) in the ledger.
    addNpcSuggestions?: (names: string[], context?: string) => void;
    setCondensed: (upToIndex: number) => void;
    setStreaming: (v: boolean) => void;
    setLastPayloadTrace?: (trace: PayloadTrace[]) => void;
    setLoadingStatus?: (status: string | null) => void;
    setSemanticFacts?: (facts: SemanticFact[]) => void;
    setChapters?: (chapters: ArchiveChapter[]) => void;
    setPipelinePhase?: (phase: PipelinePhase) => void;
    setStreamingStats?: (stats: StreamingStats | null) => void;
    setDivergenceRegister?: (register: DivergenceRegister) => void;
    updateMessageDivergence?: (messageId: string, divergenceIds: string[]) => void;
    applyPressurePatch?: (id: string, p: NPCPressure) => void;
    setOnStageNpcIds?: (ids: string[]) => void;
};

export type TurnState = {
    input: string;
    displayInput: string;
    settings: AppSettings;
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    loreChunks: LoreChunk[];
    npcLedger: NPCEntry[];
    archiveIndex: ArchiveIndexEntry[];
    semanticFacts: SemanticFact[];
    chapters: ArchiveChapter[];
    activeCampaignId: string | null;
    provider: LLMProvider | undefined;
    getMessages: () => ChatMessage[];
    getFreshProvider: () => LLMProvider | undefined;
    getFreshSummarizerProvider?: () => LLMProvider | undefined;
    getUtilityEndpoint?: () => LLMProvider | undefined;
    getFreshAuxiliaryProvider?: () => LLMProvider | undefined;
    getExtractionProvider?: () => LLMProvider | undefined;
    forcedInterventions?: ('enemy' | 'neutral' | 'ally')[];
    incrementBookkeepingTurnCounter: () => number;
    autoBookkeepingInterval: number;
    resetBookkeepingTurnCounter: () => void;
    timeline: TimelineEvent[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    deepContextSearch?: boolean;
    divergenceRegister?: DivergenceRegister;
    onStageNpcIds?: string[];
    npcPressure?: Record<string, NPCPressure>;
    pinnedExcerpts?: PinnedExcerpt[];
    // Player-called dice ("dice me"): armed roll resolved at send time. Replaces the auto
    // pool menu for this turn and is asserted as fact. null/undefined = normal turn.
    // Accepts the new ManualRollRequest shape OR legacy '1d20'|'adv'|'disadv' string.
    armedRoll?: ManualRollRequest | string | null;
    // Loot Engine WO-05: armed loot drop config resolved at send time. The walker
    // runs and the result is appended to the GM turn as a fact. null/undefined = normal turn.
    armedLoot?: ArmedLoot | null;
};
