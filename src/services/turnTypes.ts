import type {
    AppSettings,
    GameContext,
    ChatMessage,
    NPCEntry,
    LoreChunk,
    CondenserState,
    ArchiveIndexEntry,
    LLMProvider,
    SemanticFact,
    ArchiveChapter,
    TimelineEvent,
    PipelinePhase,
    StreamingStats,
} from '../types';

export type TurnCallbacks = {
    onCheckingNotes: (checking: boolean) => void;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    addNPC: (npc: NPCEntry) => void;
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondensing: (v: boolean) => void;
    setStreaming: (v: boolean) => void;
    setLastPayloadTrace?: (trace: any) => void;
    setLoadingStatus?: (status: string | null) => void;
    setSemanticFacts?: (facts: SemanticFact[]) => void;
    setChapters?: (chapters: ArchiveChapter[]) => void;
    setPipelinePhase?: (phase: PipelinePhase) => void;
    setStreamingStats?: (stats: StreamingStats | null) => void;
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
    forcedInterventions?: ('enemy' | 'neutral' | 'ally')[];
    incrementBookkeepingTurnCounter: () => number;
    autoBookkeepingInterval: number;
    resetBookkeepingTurnCounter: () => void;
    timeline: TimelineEvent[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    deepContextSearch?: boolean; // true when GM long-pressed Send to trigger deep archive scan
};
