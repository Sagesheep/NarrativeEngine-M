export type ApiFormat = 'openai' | 'ollama' | 'claude' | 'gemini';

export type LLMProvider = {
    endpoint: string;
    apiKey: string;
    modelName: string;
    streamingEnabled?: boolean;
    apiFormat?: ApiFormat;
    id?: string;    // only present in saved presets / legacy migrations
    label?: string; // only present in saved presets / legacy migrations
};

export type SamplingConfig = {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    repetition_penalty?: number;
    dry_multiplier?: number;
    dry_base?: number;
    dry_allowed_length?: number;
    max_tokens?: number;
};

export type PipelinePhase =
    | 'idle'
    | 'rolling-dice'
    | 'ai-intervention'
    | 'gathering-context'
    | 'building-prompt'
    | 'generating'
    | 'checking-notes'
    | 'post-processing';

export type StreamingStats = {
    tokens: number;
    elapsed: number;
    speed: number;
};

/** @deprecated Use LLMProvider */
export type EndpointConfig = LLMProvider;
/** @deprecated Use ProviderConfig */
export type ProviderConfig = LLMProvider;

export type AIPreset = {
    id: string;
    name: string;
    storyAI: LLMProvider;
    summarizerAI: LLMProvider;
    utilityAI?: LLMProvider; // Context recommender — optional, fallback to substring scan if empty
    auxiliaryAI?: LLMProvider; // Cheap classifier for NPC validation etc — optional, fallback to storyAI
    enemyAI?: LLMProvider;
    neutralAI?: LLMProvider;
    allyAI?: LLMProvider;
    sampling?: SamplingConfig;
};

export type CondenseAggressiveness = 'aggressive' | 'balanced' | 'quality';

export type AppSettings = {
    presets: AIPreset[];
    activePresetId: string;
    contextLimit: number;
    autoCondenseEnabled: boolean;
    condenseAggressiveness?: CondenseAggressiveness;
    debugMode?: boolean; // Toggles inline payload viewer
    theme?: 'light' | 'dark' | 'system';
    showReasoning?: boolean; // Toggles visibility of LLM thinking blocks
    uiScale?: number;  // 0.75 to 1.25, default 1.0

    enableDeepArchiveSearch?: boolean;
    autoExtractDivergences?: boolean;
    divergenceTokenBudget?: number;
    enableLegacyCondenser?: boolean; // default true; OFF disables prose condenser entirely (injection + button + auto-condense)
    injectProseSummary?: boolean; // default true. When false, prose condensed summary is NOT shipped to AI in payload (still generated and visible in panel for inspection).
    divergenceScanBudget?: number; // 0 or undefined = auto (75% of contextLimit). Otherwise the explicit max-tokens-per-chunk for divergence extraction.
    autoArchiveStaleNPCsTurns?: number; // 0 disables auto-archive; default 15

    // Legacy fields kept for migration only
    providers?: LLMProvider[];
    activeProviderId?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;

};

export type CondenserState = {
    condensedSummary: string;
    condensedUpToIndex: number;
    isCondensing: boolean;
};

export type DiceConfig = {
    catastrophe: number; // e.g. 2 (1-2 is catastrophe)
    failure: number;     // e.g. 6 (3-6 is failure)
    success: number;     // e.g. 15 (7-15 is success)
    triumph: number;     // e.g. 19 (16-19 is triumph)
    crit: number;        // e.g. 20 (20 is crit)
};

export type SurpriseConfig = {
    initialDC: number;
    dcReduction: number;
    types: string[];
    tones: string[];
};

export type EncounterConfig = {
    initialDC: number;
    dcReduction: number;
    types: string[];
    tones: string[];
};

export type WorldEventConfig = {
    initialDC: number; // Starting DC (default: 498)
    dcReduction: number; // Amount DC drops per turn (default: 2)
    who?: string[]; // The custom 'who' table
    where?: string[]; // The custom 'where' table
    why?: string[]; // The custom 'why' table
    what?: string[]; // The custom 'what' table
};

export type GameContext = {
    loreRaw: string;
    rulesRaw: string;
    starter: string;
    continuePrompt: string;
    inventory: string;
    inventoryLastScene: string;
    characterProfile: string;
    characterProfileLastScene: string;
    surpriseDC?: number;
    encounterDC?: number;
    worldEventDC?: number;
    diceConfig?: DiceConfig;
    worldEventConfig?: WorldEventConfig;
    // Toggles: whether each field is appended to context
    starterActive: boolean;
    continuePromptActive: boolean;
    inventoryActive: boolean;
    characterProfileActive: boolean;
    surpriseEngineActive: boolean;
    encounterEngineActive: boolean;
    worldEngineActive: boolean;
    diceFairnessActive: boolean;
    sceneNote: string;
    sceneNoteActive: boolean;
    sceneNoteDepth: number;
    surpriseConfig?: SurpriseConfig;
    encounterConfig?: EncounterConfig;
    coreMemorySlots?: CoreMemorySlot[];
    notebook: NotebookNote[];
    notebookActive: boolean;
    // --- AI Players (Enemy, Neutral, Ally) ---
    worldVibe: string; // Global genre constraints (e.g. "Low fantasy, no magic")
    enemyPlayerActive: boolean;
    neutralPlayerActive: boolean;
    allyPlayerActive: boolean;
    enemyPlayerPrompt: string;
    neutralPlayerPrompt: string;
    allyPlayerPrompt: string;
    interventionChance: number; // 0-100%
    enemyCooldown: number;
    neutralCooldown: number;
    allyCooldown: number;
    interventionQueue: ('enemy' | 'neutral' | 'ally')[];
    canonState?: string;
    canonStateActive?: boolean;
    headerIndex?: string;
    headerIndexActive?: boolean;
};


export type DivergenceCategory =
    | 'canon_override'
    | 'world_change'
    | 'entity_state'
    | 'player_state'
    | 'obligation';

export type DivergenceEntry = {
    id: string;
    category: DivergenceCategory;
    subject: string;
    divergence: string;
    sceneRef: string;
    linkedSceneIds: string[];
    importance: number;
    supersedes?: string;
    resolved?: boolean;
    source: 'auto' | 'manual';
    parseError?: boolean;
    reviewFlag?: boolean;
};

export type PrunedEntry = {
    originalEntry: DivergenceEntry;
    prunedAt: number;
    chapterId: string;
    verdict: 'auto_pruned' | 'user_deleted_review';
    reason: string;
};

export type DivergenceRegister = {
    entries: DivergenceEntry[];
    prunedLog: PrunedEntry[];
    lastUpdatedSceneId: string;
    lastUpdatedAt: number;
    version: number;
};

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    displayContent?: string;
    timestamp: number;
    debugPayload?: unknown;
    name?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
    reasoning_content?: string;
    ephemeral?: boolean;
    divergenceIds?: string[];
};

/** Search index entry — one per scene, auto-built by server on every turn. */
export type ArchiveIndexEntry = {
    sceneId: string;         // zero-padded, e.g. "014" — matches ## SCENE header in .archive.md
    timestamp: number;
    keywords: string[];      // proper nouns, quoted strings, [MEMORABLE:] tags
    npcsMentioned: string[]; // NPC names detected in the scene
    userSnippet: string;     // first ~100 chars of user message (human-readable preview)
    keywordStrengths?: Record<string, number>;
    npcStrengths?: Record<string, number>;
    importance?: number;
};

/** Full verbatim scene content fetched from .archive.md for recall injection. */
export type ArchiveScene = {
    sceneId: string;
    content: string;
    tokens: number;
};

export type Campaign = {
    id: string;
    name: string;
    coverImage: string; // base64 data URL
    createdAt: number;
    lastPlayedAt: number;
};

export type LoreCategory = 
    | 'world_overview'
    | 'faction'
    | 'location'
    | 'character'
    | 'power_system'
    | 'economy'
    | 'event'
    | 'relationship'
    | 'rules'
    | 'culture'
    | 'misc';

export type LoreChunk = {
    id: string;
    header: string;
    content: string;
    tokens: number;
    alwaysInclude: boolean;
    triggerKeywords: string[];  // exact keywords that activate this chunk
    scanDepth: number;          // how many recent messages to scan (default: 3)
    category: LoreCategory;
    linkedEntities: string[];   // Names of NPCs, factions, locations referenced
    parentSection?: string;     // The ## parent header this ### belongs under
    priority: number;           // 0-10, higher = more important
    summary?: string;           // One-line auto-summary for recommender index
};

export type EngineSeed = {
    surpriseTypes: string[];
    surpriseTones: string[];
    encounterTypes: string[];
    encounterTones: string[];
    worldWho: string[];
    worldWhere: string[];
    worldWhy: string[];
    worldWhat: string[];
};

export type NPCDrives = {
    coreWant: string;
    sessionWant: string;
    sceneWant: string;
};

export type NPCBehavioralTrigger = {
    keyword: string;
    shift: string;
};

export type NPCPressureHistory = {
    turn: number;
    type: 'ignored' | 'engaged';
    delta: number;
    reason: string;
};

export type NPCPressure = {
    ignored: number;
    engaged: number;
    lastDecayTurn: number;
    history: NPCPressureHistory[];
};

export type NPCEntry = {
    id: string;
    name: string;
    aliases: string;
    appearance: string;
    faction: string;
    storyRelevance: string;
    disposition: string;
    status: string;
    goals: string;
    voice: string;
    personality: string;
    exampleOutput: string;
    affinity: number;
    drives?: NPCDrives;
    behavioralTriggers?: NPCBehavioralTrigger[];
    hardBoundaries?: string[];
    softBoundaries?: string[];
    pressure?: NPCPressure;
    previousSnapshot?: { personality: string; voice: string; affinity: number };
    shiftNote?: string;
    shiftTurnCount?: number;
    archived?: boolean;
    archivedAtTurn?: number;
    archivedReason?: string;
};


export type OpenAITool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
};

export type ContextSourceClassification = 'stable_truth' | 'summary' | 'world_context' | 'volatile_state' | 'scene_local';

export type PayloadTrace = {
    source: string;
    classification: ContextSourceClassification;
    tokens: number;
    reason: string;
    preview?: string;
    included: boolean;
    position?: string;
    childMessages?: Array<{ role: string; tokens: number; preview: string }>;
};

export type CoreMemorySlot = {
    key: string;
    value: string;
    priority: number;
    sceneId: string;
};

export type SemanticFact = {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    importance: number;
    sceneId: string;
    timestamp: number;
    source?: 'regex' | 'llm';
    confidence?: number;
};

export type ArchiveChapter = {
    chapterId: string;
    title: string;
    sceneRange: [string, string];
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
    sceneCount: number;
    sealedAt?: number;
    invalidated?: boolean;
    _lastSeenSessionId?: string;
};

export type NotebookNote = {
    id: string;
    text: string;
    timestamp: number;
};

export type BackupMeta = {
    timestamp: number;
    label: string;
    trigger: string;
    hash: string;
    fileCount: number;
    isAuto: boolean;
    campaignName: string;
};

export type EntityEntry = {
    id: string;
    name: string;
    type: 'npc' | 'location' | 'object' | 'concept' | 'faction' | 'event';
    aliases: string[];
    firstSeen?: string;
    factCount?: number;
};

export const CHAPTER_SCENE_SOFT_CAP = 25;

export const TIMELINE_PREDICATES = [
    'status',
    'located_in',
    'holds',
    'allied_with',
    'enemy_of',
    'killed_by',
    'controls',
    'relationship_to',
    'seeks',
    'knows_about',
    'destroyed',
    'misc',
] as const;

export type TimelinePredicate = typeof TIMELINE_PREDICATES[number];

export const SUPERSEDE_RULES: Record<string, string[]> = {
    killed_by:  ['status', 'located_in', 'seeks', 'allied_with'],
    destroyed:  ['located_in', 'controls', 'holds'],
    status:     [],
};

export type TimelineEvent = {
    id: string;
    sceneId: string;
    chapterId: string;
    subject: string;
    predicate: TimelinePredicate;
    object: string;
    summary: string;
    importance: number;
    source: 'regex' | 'llm' | 'manual';
};

export type LoreCheckCategory = 'wrong-fact' | 'contradicts-lore' | 'wrong-entity' | 'tone-voice' | 'out-of-character';

export type LoreCheckVerdict = 'consistent' | 'unsupported' | 'contradicts';

export type LoreCheckSelection = {
    messageId: string;
    selectedText: string;
    start: number;
    end: number;
    surroundingContext: string;
};

export type LoreCheckCitation = {
    ref: string;
    label: string;
};

export type LoreCheckResult = {
    verdict: LoreCheckVerdict;
    issues: string[];
    citations: LoreCheckCitation[];
    suggestedRewrite: string | null;
    originalText: string;
    /** Raw LLM output, populated on parse failure for debugging */
    rawResponse?: string;
};

