export type ApiFormat = 'openai' | 'ollama' | 'claude' | 'gemini';

export type AiTier = 'lite' | 'pro' | 'max';

export type ThinkingEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export type LLMProvider = {
    id: string;
    label: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
    streamingEnabled?: boolean;
    apiFormat?: ApiFormat;
    thinkingEffort?: ThinkingEffort;
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

export type AIPreset = {
    id: string;
    name: string;
    storyAIProviderId: string;
    summarizerAIProviderId?: string;
    utilityAIProviderId?: string;
    auxiliaryAIProviderId?: string;
    imageAIProviderId?: string;
    sampling?: SamplingConfig;
    storyAI?: LLMProvider;
    summarizerAI?: LLMProvider;
    utilityAI?: LLMProvider;
    auxiliaryAI?: LLMProvider;
    imageAI?: LLMProvider;
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
    divergenceScanBudget?: number; // 0 or undefined = auto (75% of contextLimit). Otherwise the explicit max-tokens-per-chunk for divergence extraction.
    autoArchiveStaleNPCsTurns?: number; // 0 disables auto-archive; default 15

    rulesBudgetPct?: number;        // fraction of contextLimit for rules RAG, default 0.10
    autoGenerateRuleKeywords?: boolean; // default true; false = header+bold derivation only
    embeddingModel?: 'standard' | 'high'; // default 'standard'

    utilityTimeoutSeconds?: number;   // soft deadline for utility AI calls (reranker, recommender, expandQuery). Default 45. User can EXTEND +1m mid-flight.
    verboseUtilityLogging?: boolean;  // when true, utility call tracker records extra detail (slot waits, retries, payload sizes)
    aiTier?: AiTier;
    imageStylePrompt?: string;       // prepended to every image generation prompt (e.g. "oil painting, fantasy art, dark atmosphere")
    imageNegativePrompt?: string;    // negative prompt for models that support it
    providers: LLMProvider[];
    activeProviderId?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;

};

export type CondenserState = {
    condensedUpToIndex: number;
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

export type NpcIntroConfig = {
    initialDC: number;
    dcReduction: number;
    characters: CharacterIntroEntry[];
};

export type RuleChunkMeta = {
    id: string;
    activationModes: ('vector' | 'keyword' | 'always')[];
    triggerKeywords?: string[];
    secondaryKeywords?: string[];
    priority?: number;
    keywordsUserEdited?: boolean;
};

export type GameContext = {
    loreRaw: string;
    rulesRaw: string;
    rulesChunkMeta?: Record<string, RuleChunkMeta>;
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
    npcIntroConfig?: NpcIntroConfig;
    npcIntroEngineActive?: boolean;
    npcIntroDC?: number;
    notebook: NotebookNote[];
    notebookActive: boolean;
    combatModeActive?: boolean;
    combatConfig?: {
        mookJitterRange?: number;
        defaultWeaponDie?: number;
        recoveryBands?: Record<'healthy' | 'wounded' | 'critical', number>;
        combatAutoDetect?: boolean;
        autoEnterThreshold?: number;
        askThreshold?: number;
        confirmOnBorderline?: boolean;
        combatKeywords?: string[];
    };
    statLabelMap?: Record<string, string>;
};


export type DivergenceCategory =
    | 'locations'
    | 'npc_events'
    | 'promises_debts'
    | 'world_state'
    | 'party_facts'
    | 'rules_lore'
    | 'misc';

export type DivergenceEntry = {
    id: string;
    chapterId: string;
    category: DivergenceCategory;
    text: string;
    sceneRef: string;
    npcIds: string[];
    knownBy?: string[]; // NPC IDs that witnessed or know this fact; undefined = broadcast
    pinned: boolean;
    enabled?: boolean;
    source: 'auto' | 'manual';
    reviewFlag?: boolean;
    unrecognizedNpcNames?: string[];
};

export type TopicCluster = {
    id: string;
    name: string;
    factIds: string[];
};

export type TopicClusters = {
    groups: TopicCluster[];
    generatedAt: string;
    generatedFromFactCount: number;
};

export type DivergenceRegister = {
    entries: DivergenceEntry[];
    chapterToggles: Record<string, boolean>;
    categoryToggles: Record<string, Record<DivergenceCategory, boolean>>;
    lastUpdatedSceneId: string;
    lastUpdatedAt: number;
    version: 2;
    topicClusters?: TopicClusters;
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
    image?: { status: 'pending' | 'ready' | 'error'; prompt?: string; createdAt: number; error?: string };
};

/** Search index entry — one per scene, auto-built by server on every turn. */
export type WitnessSource = 'header' | 'aux_fallback' | 'body_fallback' | 'seal_correction' | 'empty';

export type SceneEventType =
    | 'combat'
    | 'discovery'
    | 'item_acquired'
    | 'item_lost'
    | 'relationship_shift'
    | 'travel'
    | 'promise'
    | 'betrayal'
    | 'death'
    | 'revelation'
    | 'quest_milestone'
    | 'other';

export type SceneEvent = {
    eventType: SceneEventType;
    importance: number;       // 1-10
    text: string;             // short summary line
    characters?: string[];    // canonical NPC names or IDs
    locations?: string[];
    items?: string[];
    concepts?: string[];
    cause?: string;           // short plain-text cause beat
    result?: string;          // short plain-text result beat
};

export type ArchiveIndexEntry = {
    sceneId: string;         // zero-padded, e.g. "014" — matches ## SCENE header in .archive.md
    timestamp: number;
    keywords: string[];      // proper nouns, quoted strings, [MEMORABLE:] tags
    npcsMentioned: string[]; // NPC names detected in the scene
    npcsWitnessed?: string[]; // NPC IDs physically present/witnessing the scene
    witnessSource?: WitnessSource; // how npcsWitnessed was determined
    userSnippet: string;     // first ~100 chars of user message (human-readable preview)
    keywordStrengths?: Record<string, number>;
    npcStrengths?: Record<string, number>;
    importance?: number;
    events?: SceneEvent[];    // optional: structured events extracted at seal time (back-compat: undefined for pre-existing entries)
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
    triggerKeywords: string[];  // primary keywords that activate this chunk
    secondaryKeywords?: string[]; // contextual disambiguators; if present, one must also match (strict AND-gate)
    scanDepth: number;          // how many recent messages to scan (default: 3)
    category: LoreCategory;
    linkedEntities: string[];   // Names of NPCs, factions, locations referenced
    parentSection?: string;     // The ## parent header this ### belongs under
    priority: number;           // 0-10, higher = more important
    summary?: string;           // One-line auto-summary for recommender index
    keywordsEnriched?: boolean; // true after LLM enrichment pass; undefined = not yet enriched
    enrichedVersion?: number;   // ENRICHER_VERSION the chunk was last enriched at; undefined = pre-versioning
    ragMode?: 'always' | 'keyword' | 'vector'; // explicit mode from <!-- rag: --> hint; authoritative over heuristics
    activationModes?: ('vector' | 'keyword' | 'always')[]; // undefined = derive from alwaysInclude/ragMode (back-compat)
    modesUserEdited?: boolean; // true after UI toggle; preserved across re-imports
    embeddedModelId?: string; // last model id this chunk was embedded with (diff aid)
};

export type CharacterIntroEntry = {
    name: string;
    type: 'wandering' | 'location' | 'wandering+boosted' | 'location+boosted';
    location?: string;
    boostKeywords?: string[];
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
    characterIntros: CharacterIntroEntry[];
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
    previousSnapshot?: { personality: string; voice: string; affinity: number };
    shiftNote?: string;
    shiftTurnCount?: number;
    tier?: 'recurring' | 'oneshot' | 'walkon';
    recalledByEmbedding?: boolean;
    lastUpdateScene?: number;
    isPC?: boolean;
    combatTier?: 'minion' | 'grunt' | 'elite' | 'boss' | 'legendary';
    archetype?: 'bulwark' | 'assassin' | 'caster' | 'skirmisher' | 'brute';
    stats?: {
        VIT: number;
        PWR: number;
        RES: number;
        FOC: number;
        SPD: number;
        WIL: number;
    };
    equippedWeapon?: string;
    knownSkills?: string[];
    inventory?: string[];
    condition?: 'healthy' | 'wounded' | 'critical' | 'dead';
    lastCondition?: 'healthy' | 'wounded' | 'critical' | 'dead';
    lastSeenTimestamp?: number;
    recoveryNote?: string;
    overrides?: NPCOverride[];
    portrait?: boolean;
    portraitSeed?: number;
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
    sceneIds: string[];
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
    npcInnerState?: Record<string, string>; // NPC name -> 1-2 sentence belief/posture note
    resolvedThreads?: string[]; // exact strings from earlier chapters' unresolvedThreads that this chapter settled
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

// ── Pinned Excerpts ────────────────────────────────────────────────────

export type PinnedExcerpt = {
    id: string;                // own ID
    sourceMessageId: string;   // for back-jump / context
    text: string;              // verbatim pinned content (source of truth)
    createdAt: number;
    isFullMessage: boolean;    // affects rendering & dedup
};

// ── Combat Mode Core Types ─────────────────────────────────────────────

export type CombatTier = 'minion' | 'grunt' | 'elite' | 'boss' | 'legendary';
export type Archetype = 'bulwark' | 'assassin' | 'caster' | 'skirmisher' | 'brute';
export type RecoveryBand = 'healthy' | 'wounded' | 'critical';

/**
 * Deterministic enemy-AI personal override (spec A7, tier 1).
 * `trigger` uses a bounded vocab parsed by the engine, e.g.
 *   "onSelfBelow(30)" · "onAllyBelow(30)" · "onAllyFatal" · "onRound(2)"
 * `action` is one of the bounded enemy action labels, e.g.
 *   "attack" · "defend" · "guard" · "reposition" · "cast" · "interpose"
 */
export type NPCOverride = { trigger: string; action: string };

export type StatBlock = {
    VIT: number;
    PWR: number;
    RES: number;
    FOC: number;
    SPD: number;
    WIL: number;
};

export type Combatant = {
    id: string;
    name: string;
    stats: StatBlock;
    currentHP: number;
    maxHP: number;
    currentFOC: number;
    maxFOC: number;
    combatTier: CombatTier;
    archetype: Archetype;
    ac: number;
    proficiencyBonus: number;
    isPC?: boolean;
    position?: 'cover' | 'elevated' | 'exposed';
    statusEffects?: string[];
    /** Personal AI overrides copied from the ledger entry at materialize (named NPCs only). */
    overrides?: NPCOverride[];
};

export type ItemDef = {
    id: string;
    name: string;
    description: string;
    damageDice: number;
    scalingStat: 'PWR' | 'SPD' | 'WIL';
    bonus: number;
    properties: string[];
    range: 'Close' | 'Reach' | 'Ranged';
    rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
};

export type SkillDef = {
    id: string;
    name: string;
    description: string;
    focCost: number;
    type: 'attack' | 'heal' | 'utility';
    damageDice?: number;
    healDice?: number;
    scaling: 'PWR' | 'SPD' | 'WIL';
    properties: string[];
    range: 'Close' | 'Reach' | 'Ranged';
};

export type CombatState = {
    active: boolean;
    round: number;
    turnOrder: string[];
    activeTurnIndex: number;
    combatants: Record<string, Combatant>;
    rangeRelations: Record<string, Record<string, 'Engaged' | 'Apart'>>;
};

export type InventoryProposal = {
    name: string;
    op: 'grant' | 'remove' | 'equip';
    kind: 'weapon' | 'armor' | 'consumable' | 'misc';
    quality: ItemDef['rarity'];
    scalingStat: 'PWR' | 'SPD' | 'WIL';
    range: 'Close' | 'Reach' | 'Ranged';
    properties: string[];
    equip: boolean;
    description: string;
};

