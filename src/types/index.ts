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
    matureMode?: boolean;            // default false; gates mature-tier NPC traits/wants (NPC Agency Phase 2)

    utilityTimeoutSeconds?: number;   // soft deadline for utility AI calls (reranker, recommender, expandQuery). Default 45. User can EXTEND +1m mid-flight.
    verboseUtilityLogging?: boolean;  // when true, utility call tracker records extra detail (slot waits, retries, payload sizes)
    aiTier?: AiTier;
    imageStylePrompt?: string;       // prepended to every image generation prompt (e.g. "oil painting, fantasy art, dark atmosphere")
    imageNegativePrompt?: string;    // negative prompt for models that support it
    imageTagRewriteEnabled?: boolean; // default false; when true, scene prose is rewritten to comma tags via the aux model before image gen (WO-05)
    ttsEnabled?: boolean;             // default false; master toggle for read-aloud (Web Speech API)
    ttsRate?: number;                 // default 1; playback rate 0.5–2
    providers: LLMProvider[];
    activeProviderId?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;

};

export type CondenserState = {
    condensedUpToIndex: number;
};

/** @deprecated — superseded by DiceSystemConfig. Kept for migration detection only. */
export type DiceConfig = {
    catastrophe: number;
    failure: number;
    success: number;
    triumph: number;
    crit: number;
};

// ─── Generalized dice engine types ──────────────────────────────────────

export type OutcomeBand = {
    id: string;
    label: string;   // "Catastrophe", "Mixed", "Success with boon", etc.
    min: number;      // inclusive
    max: number;      // inclusive
};

export type DieType = {
    id: string;
    name: string;     // "d6", "d20", "d100", "Custom ..."
    faces: number;    // 6, 20, 100, ...
    bands: OutcomeBand[]; // must tile 1..faces with no gaps/overlaps
};

export type RollAggregation = 'pick_one' | 'total_all';
export type RollModifier = 'none' | 'adv' | 'disadv';

export type RollDefinition = {
    modifier: RollModifier;      // Gate 1: None / Advantage / Disadvantage
    count: number;               // Gate 2: number of dice (e.g. 3 for 3d6)
    aggregation: RollAggregation; // Gate 3: Pick one / Total all
};

export type DiceCategory = {
    id: string;
    name: string;         // "Combat", "Stealth", custom — up to 10
    dieTypeId: string;    // references DieType.id
};

export type DiceSystemConfig = {
    dieTypes: DieType[];          // registry of available die types
    categories: DiceCategory[];   // up to 10
    // Note: no global rollDef — pool mode always does a singular roll per category.
    // The 3-gate RollDefinition is per-roll (dice me modal / roll_dice tool args), not global.
};

// Player-called "dice me" arm request (WO-H). Resolved at send time so the result is
// hidden until the player commits; asserted as fact into the turn.
export type ManualRollRequest = {
    dieTypeId: string;       // which DieType to roll
    rollDef: RollDefinition;  // per-roll 3-gate config (local to this roll)
};

/** @deprecated — kept for migration. Old shape was '1d20' | 'adv' | 'disadv'. */
export type ManualRollMode = '1d20' | 'adv' | 'disadv';

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
    characterProfile: CharacterProfileState;
    characterProfileLastScene: string;
    surpriseDC?: number;
    encounterDC?: number;
    worldEventDC?: number;
    agencyTick?: number;          // Phase-3 monotonic tick counter (heartbeat/timeskip advance it)
    agencyHeartbeatDC?: number;   // Phase-3 escalating-DC pity timer (mirrors surpriseDC; §5/§9.3#1)
    diceConfig?: DiceConfig;        // @deprecated — migrated to diceSystem on load
    diceSystem?: DiceSystemConfig;   // generalized dice engine config
    worldEventConfig?: WorldEventConfig;
    // Toggles: whether each field is appended to context
    starterActive: boolean;
    continuePromptActive: boolean;
    inventoryActive: boolean;
    characterProfileActive: boolean;
    characterProfileUserDisabled: boolean;
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
    lastSceneStakes?: SceneStakes;     // Phase-3 §9.3#2: last parsed/fallback scene stakes
    agencyDigest?: string;             // Phase-3 §9.3#7: player-visible tick digest, folded into next GM call
    arcs?: ArcRecord[];                // Arc Engine (System 2): active + retired arcs for this campaign
    arcDigest?: string;                // Arc Engine: current-rung surface line, folded into next GM call (cleared at handlePostTurn top, like agencyDigest)
    statLabelMap?: Record<string, string>;
    // Loot Engine (WO-01/03): a world-declared weighted decision tree the engine walks
    // at send time. undefined = this world has no loot table (manual trigger no-ops).
    lootTree?: LootTree;
    activeLootProfileId?: string;
};

// ── Loot Engine — WO-01 contract (01_STRONG_types_contract.md) ──
// A world-declared weighted decision tree the engine walks at send time. Pure
// data + dice — ZERO LLM at runtime. The walker (WO-02) lives in
// src/services/engine/lootEngine.ts; the loader (WO-03) in src/services/lore/lootTreeLoader.ts.

export type LootNodeId = string;

/** Store-number/show-word: `text` ships to the LLM; `tier`/`budget` stay engine-only. */
export type LootPoolEntry = {
    text: string;          // the word the GM sees, e.g. "spearman", "Void", "Sword Saint"
    tier?: number;         // engine-only power rank (gear budgets); omit for pure-flavor entries
    budget?: string;       // engine-only effect budget (epic/legendary gear only); free-text for MVP
};

/** A pool is either a flat list OR a map keyed by a filter axis (e.g. domain). */
export type LootPool = LootPoolEntry[] | Record<string, LootPoolEntry[]>;

/** PICK — weighted fork. The chosen option maps to the next node id (recursion = the tree). */
export type LootPickNode = {
    kind: 'pick';
    axis: string;                          // bound for later filter/compose, e.g. 'category','rarityClass','domain'
    weights: Record<string, number>;       // option -> weight; NEED NOT sum to 100 (engine normalizes)
    branches: Record<string, LootNodeId>;  // option -> next node id. The `unique` short-circuit is just
                                           // a branch pointing at a Draw node with no aspect draw.
};

/** DRAW — pull entries from one or more pools, optionally filtered by an earlier pick axis. */
export type LootDrawSpec = {
    pool: string;                          // key into LootTree.pools
    as: string;                            // binding name for compose, e.g. 'job','aspect'
    filterBy?: string;                     // an earlier pick axis whose value keys the pool map (e.g. 'domain')
};

export type LootDrawNode = {
    kind: 'draw';
    draws: LootDrawSpec[];
    next?: LootNodeId;                      // usually a compose node; omit to auto-compose (see WO-01 §3)
};

/** AMOUNT — roll a number in a range (currency). */
export type LootAmountNode = {
    kind: 'amount';
    unit: string;                          // 'creds','ingots'
    min: number;
    max: number;
    scaleBySource?: boolean;               // MVP: may ignore; reserved for per-source multipliers
    next?: LootNodeId;
};

/** COMPOSE — assemble bound values into the final label. */
export type LootComposeNode = {
    kind: 'compose';
    template: string;                      // "{job} of the {aspect}" | "{job}" | "{amount} {unit}"
};

export type LootNode =
    | LootPickNode
    | LootDrawNode
    | LootAmountNode
    | LootComposeNode;

export type LootTree = {
    root: LootNodeId;
    nodes: Record<LootNodeId, LootNode>;
    pools: Record<string, LootPool>;
    /** optional: per-source band/roll-count overrides, reserved (spec §1.1). MVP may leave undefined. */
    sources?: Record<string, { rolls?: [number, number] }>;
};

// ── Loot Profile (spec §3 — the only "detector", a lookup not a classifier) ──

export type LootProfile = {
    /** Named-profile identifier (for WO-04 location-lore lookup, deferred). Optional
     *  for the MVP: the orchestrator builds an ad-hoc one-shot profile from the modal
     *  reweight with no id, and the walker only reads entryNode/reweight. */
    id?: string;
    /** Hard override: start the walk here, skipping the category Pick (scroll-dungeon → scroll subtree). */
    entryNode?: LootNodeId;
    /** Soft override: replace weights at named pick nodes, e.g. { root: { scroll: 90, ingots: 10 } }. */
    reweight?: Record<LootNodeId, Record<string, number>>;
};

// ── Loot drop result (WO-02 walker output) ──

export type LootItem = {
    label: string;                         // final composed string, e.g. "Spearman of the Void"
    parts: Record<string, string>;         // bound axis/draw values, e.g. {category,rarityClass,domain,job,aspect}
    tierWord?: string;                     // optional banded power word (gear); from entry.tier via a band fn
};

export type LootDropResult = {
    appendToInput: string;                 // "[LOOT DROP: Spearman of the Void]" — SAME shape as rollEngines
    items: LootItem[];
    trace: string[];                        // debug: walked node ids + rolls (DebugPanel; never to GM payload)
};

export type ResolveLootOpts = {
    profile?: LootProfile;
    source?: string;                       // selects sources[source].rolls if present
    rolls?: number;                        // how many items; default 1 (MVP); else from source
    rng?: () => number;                    // injectable for tests (default Math.random)
};

// ── Arc Engine (System 2 / Oracle Function) — WO-01 contract ──
// An arc is a staged track: a 5–12 rung ladder authored once at spawn, advanced by
// dice, bent by player stance, surfaced indirectly. The engine owns currentRung +
// tickDC; the LLM only authors the ladder at birth and narrates the rung through
// the existing GM call. See Upgrade/OpusPlans/Oracle_Function/02_ARCHITECT_contract.md.
export type ArcType =
    | 'economic' | 'political' | 'factional' | 'social'
    | 'supernatural' | 'criminal' | 'environmental';

export type ArcStance = 'opposed' | 'aided' | 'ignored' | 'fled' | 'unaware';

export type ArcSurface = 'ambient' | 'rumor' | 'direct';

export type ArcStage = {
    label: string;          // authored-once prose, ONE rung of the ladder
    surface: ArcSurface;    // how this rung reaches the player
};

export type ArcRecord = {
    id: string;
    type: ArcType;
    title: string;          // short, for logs/debug — NOT shown to the player as-is
    seed: string;           // the one grounding sentence the ladder grew from
    ladder: ArcStage[];     // 5–12 rungs, quiet → crisis (LADDER_MIN..LADDER_MAX)
    currentRung: number;    // engine-owned index into ladder; starts 0
    tickDC: number;         // escalating-DC tempo timer; starts ARC_TICK_DC.initial
    stance: ArcStance;      // last value from scanArcStance; defaults 'unaware'
    status: 'active' | 'resolved' | 'boiled_over' | 'defused';
    bornScene: string;      // sceneId at spawn
    lastTickScene: string;  // sceneId of the last rung change (recency signal)
};


export type DivergenceCategory =
    | 'locations'
    | 'npc_events'
    | 'promises_debts'
    | 'world_state'
    | 'party_facts'
    | 'rules_lore'
    | 'misc';

/**
 * A single structured narrative fact about the player character.
 * Replaces the legacy flat-string `characterProfile` blob.
 *
 * - `category` reuses DivergenceCategory (party_facts is the natural home for
 *   most PC narrative state, but locations/promises_debts/world_state are valid
 *   too — e.g., "Lives at Tellis Court" is `locations`, "Owes Garrick 200 gold"
 *   is `promises_debts`).
 * - `eventTags` drives scene-aware retrieval: the planner emits eventTypes per
 *   turn; traits whose tags don't intersect the planner's set are dropped from
 *   the extended tier. Core-tier traits (see CORE_FLOOR) bypass this filter.
 * - `superseded: true` marks a trait that has been replaced by a newer one with
 *   the same `subject` + `category`. The parser sets this instead of appending,
 *   fixing the AVERIN "14 Halsen Court vs Tellis Court" append-only bug.
 */
export type CharacterTrait = {
    id: string;
    subject: string;             // PC name (or entity name for PC-adjacent traits)
    category: DivergenceCategory; // which kind of fact this is
    text: string;                // the narrative fact, e.g. "Lives at Tellis Court, Unit 4A"
    importance: number;           // 1-10 narrative weight; drives retrieval scoring
    eventTags: SceneEventType[];  // which scene types this trait is relevant to
    sceneEstablished: string;     // sceneId where this trait was first recorded
    superseded: boolean;           // true if a newer trait with same subject+category replaced this
    source: 'llm' | 'manual' | 'seed';  // origin: parser / user edit / wizard seed
};

/**
 * Core identity fields that are ALWAYS injected for the PC, regardless of
 * scene tags. These live outside the trait list because they're structural
 * (name/race/class don't change per scene and aren't subject to supersession).
 */
export type CharacterIdentity = {
    name?: string;
    race?: string;
    class?: string;
    archetype?: Archetype;
    level?: number;
    appearance?: string;     // stable PC look for scene images — prose OR tags; the composer adapts
    portraitSeed?: number;   // optional single-subject seed lock (parity with NPCEntry.portraitSeed)
};

/**
 * Structured replacement for the flat `characterProfile: string` field.
 *
 * - `identity` is always injected (Tier 1 core).
 * - `activeTraits` are scored + scene-filtered + budget-capped at injection
 *   time by `queryTraits` (the PC analogue of `queryFacts`).
 * - `legacyNotes` is a frozen read-only blob from the old flat-string profile.
 *   It is NEVER injected into the prompt — kept only so users don't lose
 *   data on upgrade. The parser rebuilds `activeTraits` over a few turns.
 */
export type CharacterProfileState = {
    identity: CharacterIdentity;
    stats?: StatBlock;
    activeTraits: CharacterTrait[];
    legacyNotes?: string;
};

/** Number of PC traits always injected regardless of scene tags. */
export const CORE_FLOOR_TRAITS = 5;

export type DivergenceEntry = {
    id: string;
    chapterId: string;
    category: DivergenceCategory;
    text: string;
    sceneRef: string;
    npcIds: string[];
    // Who knows this fact. Tokens: "player" | "npc:<id>" | "faction:<name-normalized>".
    // undefined = public/broadcast (common knowledge). [] = secret, no NPC knows it.
    knownBy?: string[];
    // Stable snake_case subject slug shared by ALL facts about the same subject
    // (e.g. "alex_chen.identity"). The scene number is the version axis. undefined = ungrouped.
    subjectToken?: string;
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
    image?: { status: 'pending' | 'ready' | 'error'; prompt?: string; createdAt: number; error?: string; steer?: SceneSteer };
    // ── Swipe Generation (v1) ──
    // Present ONLY on the LATEST assistant message while it's still browsable
    // (before commit). Holds 1–5 variants. `pendingCommit` is the crash-safety
    // marker: set true the moment swipe 1/1 completes, cleared on commit/discard.
    // On launch, if a message carries pendingCommit, the reconciliation path
    // fires handlePostTurn with the visible variant's text, then clears it.
    swipeSet?: SwipeVariant[];
    pendingCommit?: boolean;
    swipeActiveIndex?: number;
    // ── Smart Retry v1 ──
    // `precontext` is captured after gatherContext succeeds but before the story
    // AI runs, and is stamped on the TERMINAL assistant message (atomic with
    // swipeSet on success, or with `retryable` on failure/abort). The collapsed
    // box renders above the assistant prose. `capturedPayloadRef` is a string
    // key matching PendingTurnSnapshot.snapshotId — never a live ref (would
    // bloat storage like debugPayload). On reload it's a dangling key: safe,
    // just doesn't resolve (no Retry button). Stripped from persistence by
    // campaignStore.stripEphemeralFields.
    precontext?: {
        summary: string;            // "Lore · Rules · Archive · 4 NPCs · 2 scenes"
        capturedPayloadRef: string; // matches PendingTurnSnapshot.snapshotId
    };
    // True when the story AI was aborted (Stop) or failed final retry. The
    // bubble keeps its partial text; a Retry button renders below. Cleared on
    // first successful Retry, on new-turn start, and at commit (via the
    // destructure in commitPendingTurn). Not persisted (stripped pre-save).
    retryable?: boolean;
};

export type SwipeVariant = {
    id: string;
    text: string;                  // display text (scene-stakes tag already stripped)
    reasoningContent?: string;
    sceneStakes: SceneStakes;      // parsed from this variant's tag at generation
    tagPresent: boolean;            // whether the [[SCENE_STAKES:]] tag was in this variant
    streaming?: boolean;            // true while this slot is still being filled
};

/**
 * User steering inputs for a single scene image, captured by the Scene Image modal.
 * Persisted onto `message.image.steer` so the modal can reopen prefilled (which is
 * also the "regenerate with a note" flow). See Upgrade/OpusPlans/Image_Consistency/.
 */
export type SceneSteer = {
    focusNpcIds?: string[];                              // which on-stage NPCs are the focal subjects
    focusPc?: boolean;                                    // PC is an explicit focal subject
    framing?: 'wide' | 'medium' | 'close' | 'portrait';  // shot framing
    pov?: 'pc_pov' | 'pc_visible';                        // camera is the PC's eyes vs the PC is in frame
    note?: string;                                        // short free text appended verbatim
    promptOverride?: string;                              // user hand-edited the whole positive prompt
    rewrite?: boolean;                                    // per-image override of the scene→tag rewrite toggle
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

// ---- NPC Agency (Phase 1: schema only — no dice/heat/karma/tick logic) ----
// Numbers below are engine-internal and are NEVER sent raw to the LLM; they reach
// the model only via word-bands (see src/services/npc/agencyBands.ts).

// Personality hexagon: 6 spectrum axes, each stored -3..+3 (0 = neutral center).
export type HexAxis = 'drive' | 'diligence' | 'boldness' | 'warmth' | 'empathy' | 'composure';
export type PersonalityHex = Record<HexAxis, number>;

// Tiered wants. Sits beside the legacy NPCDrives (seeded from it in Phase 2; not deleted).
export type NPCWants = {
    short: string[];   // needs/flavor pool draws; repeats allowed; no LLM
    medium: string[];  // goal templates (pool); LLM-updated in Phase 2
    long: string;      // single long goal; LLM-generated at creation (Phase 2)
};

// Scene danger gradient (Phase 3 §9.3#2). Gates which goal tiers may tick: `dangerous` blocks
// long-goals + relaxing. Emitted by the GM call (with a cheap classifier fallback).
export type SceneStakes = 'calm' | 'tense' | 'dangerous';

// ---- NPC Agency Phase 3: Goal records (the §9.6 hidden columns) ----
// Engine-internal. ONLY `text` ever reaches the LLM (+ derived word-bands). Everything else stays
// in state. Seeded from NPCWants medium/long strings by the lazy migration (upgradeWantsToGoals).
export type GoalHorizon = 'med' | 'long';
export type GoalState = 'active' | 'achieved' | 'blocked' | 'retired';
export type Goal = {
    text: string;                 // reaches LLM (display); the only payload-visible field
    horizon: GoalHorizon;
    tier: 'default' | 'mature';   // content gate
    base_heat: number;            // Piece A
    lastAdvancedTick: number;     // Piece A: neglect = now − this
    failStreak: number;           // Piece B (karma, NEVER in payload)
    progress: number;             // Piece C
    quota: number;                // Piece C (scales with magnitude)
    state: GoalState;
    justifiedEventFlag?: boolean; // set by Crit Success, consumed by tier-cross (Piece C)
};

// Sparse, directed NPC->NPC relation graph. Key = target NPC id; absent key = Neutral (0).
// Only non-neutral edges are stored. Each value -3..+3.
export type RelationGraph = Record<string, number>;

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
    appearanceTags?: string; // image-only stable "who" tags; does NOT replace `appearance` (which feeds embeddings + narrative payload)
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
    previousSnapshot?: { personality: string; voice: string; affinity: number; personalityHex?: PersonalityHex; pcRelation?: number; skillRung?: number };
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
    inventory?: string[];
    condition?: 'healthy' | 'wounded' | 'critical' | 'dead';
    lastCondition?: 'healthy' | 'wounded' | 'critical' | 'dead';
    lastSeenTimestamp?: number;
    recoveryNote?: string;
    portrait?: boolean;
    portraitSeed?: number;
    // ---- NPC Agency fields (Phase 1, all optional → lazy migration) ----
    wants?: NPCWants;
    personalityHex?: PersonalityHex;
    traits?: string[];            // <=5, controlled vocab (see services/npc/agencyPools.ts)
    region?: string;              // coarse location: 'academy' | 'Ryuten' | ...
    haunt?: string;               // flavor only, for reports ('the garden')
    relations?: RelationGraph;    // NPC->NPC sparse directed edges
    pcRelation?: number;          // -3..+3 — dedicated NPC->PC slot (re-homed from affinity)
    populated?: boolean;          // false/undefined = not yet generated (Phase-2 lazy fill)
    agencyLocked?: boolean;       // true = player authors this NPC; skip agency updates
    goalRecords?: Goal[];         // Phase-3 engine layer (hidden cols); seeded from wants.medium/long
    // ---- NPC Agency Phase 4: power-rung ladder (Piece C) ----
    skillRung?: number;           // 0..4 ladder position; undefined = not yet set (default Novice=0 on fill)
    rungCeiling?: number;         // 0..4 talent cap; LLM-set once, default 3. skillRung may never exceed this.
    // ---- NPC Agency Phase 4: promotion / audition (Piece D) ----
    // Lazy-decay activity accumulator (Opus §2, WO-07). Default-absent = treated as { value: 0, tick: now }
    // on read via currentActivity(). Never persisted as a separate deepTier — membership is derived.
    agencyActivity?: { value: number; tick: number };
    // ---- NPC Inner Repression (peaceful social masking) ----
    // Count of times this NPC has swallowed a hostile/self-interested reaction instead of
    // expressing it. Pure engine-managed gauge: raises the hide-DC (masking gets harder as it
    // climbs) until a forced break discharges it back toward 0 (catharsis). Never sent to the
    // LLM. Default-absent = 0. See services/npc/reactionRepression.ts.
    repressionPressure?: number;
    // ---- Relationship meter (engine-owned affinity accumulator) ----
    // Hidden sub-band progress toward the next pcRelation change. The AI only classifies each
    // scene's tone per NPC (friendly/tense/neutral/bonding/betrayal); the ENGINE rolls a signed
    // step into this meter, and when it crosses a threshold the pcRelation band moves and the
    // meter resets (carry preserved). Asymmetric: slow up (+100 to rise), fast down (−50 to fall);
    // bonding leaps but caps at Friendly; betrayal drops uncapped. Never sent to the LLM.
    // Default-absent = 0. See services/npc/relationMeter.ts.
    relationMeter?: number;
    // ---- NPC Generation Refit (Phase 1) — SOCIAL/disposition groups ----
    // NOTE: these are SOCIAL/disposition archetype keys (e.g. 'scholar', 'brute', 'fool') from
    // dispositionGroups.ts ENVELOPES. They are NOT the combat `archetype` field above
    // (bulwark/assassin/caster/skirmisher/brute). Do not conflate the two.
    // primaryGroup = what they are now (immutable after birth); secondaryGroup = trajectory
    // (update()-able so player action can bend it). Optional → existing saves load unchanged.
    primaryGroup?: string;
    secondaryGroup?: string;
    /**
     * Scene-type tags per profile field, used for smart context injection.
     * Key = field name (e.g. 'voice', 'combatTier'), value = SceneEventType[]
     * indicating which scene types this field is relevant to. Fields not in
     * the map (or NPCs without fieldTags) always inject — preserving today's
     * behavior as the backward-compatible default.
     */
    fieldTags?: Record<string, SceneEventType[]>;
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

export type ContextSourceClassification = 'stable_truth' | 'summary' | 'world_context' | 'volatile_state' | 'scene_local' | 'player_input';

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

export type BackupCreateResult = { skipped: true } | { skipped: false; timestamp: number; hash: string; fileCount: number };

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

export type LoreCheckVerdict = 'consistent' | 'unsupported' | 'contradicts' | 'corrected';

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

// ── Combat & Character Stat Types ──────────────────────────────────────

export type CombatTier = 'minion' | 'grunt' | 'elite' | 'boss' | 'legendary';
export type Archetype = 'bulwark' | 'assassin' | 'caster' | 'skirmisher' | 'brute';

export type StatBlock = {
    VIT: number;
    PWR: number;
    RES: number;
    FOC: number;
    SPD: number;
    WIL: number;
};

// ─── Dice System Defaults & Migration ──────────────────────────────────

function bandId() { return `b_${Math.random().toString(36).slice(2, 9)}`; }

/** Standard 8 polyhedral/percentile die types with sensible default outcome bands. */
export function buildDefaultDieTypes(): DieType[] {
    return [
        {
            id: 'dt_d2', name: 'd2', faces: 2, bands: [
                { id: bandId(), label: 'Failure', min: 1, max: 1 },
                { id: bandId(), label: 'Success', min: 2, max: 2 },
            ],
        },
        {
            id: 'dt_d4', name: 'd4', faces: 4, bands: [
                { id: bandId(), label: 'Failure', min: 1, max: 2 },
                { id: bandId(), label: 'Success', min: 3, max: 4 },
            ],
        },
        {
            id: 'dt_d6', name: 'd6', faces: 6, bands: [
                { id: bandId(), label: 'Catastrophe', min: 1, max: 1 },
                { id: bandId(), label: 'Failure', min: 2, max: 3 },
                { id: bandId(), label: 'Mixed', min: 4, max: 4 },
                { id: bandId(), label: 'Success', min: 5, max: 6 },
            ],
        },
        {
            id: 'dt_d8', name: 'd8', faces: 8, bands: [
                { id: bandId(), label: 'Catastrophe', min: 1, max: 1 },
                { id: bandId(), label: 'Failure', min: 2, max: 4 },
                { id: bandId(), label: 'Success', min: 5, max: 7 },
                { id: bandId(), label: 'Triumph', min: 8, max: 8 },
            ],
        },
        {
            id: 'dt_d10', name: 'd10', faces: 10, bands: [
                { id: bandId(), label: 'Catastrophe', min: 1, max: 1 },
                { id: bandId(), label: 'Failure', min: 2, max: 5 },
                { id: bandId(), label: 'Success', min: 6, max: 9 },
                { id: bandId(), label: 'Triumph', min: 10, max: 10 },
            ],
        },
        {
            id: 'dt_d12', name: 'd12', faces: 12, bands: [
                { id: bandId(), label: 'Catastrophe', min: 1, max: 2 },
                { id: bandId(), label: 'Failure', min: 3, max: 6 },
                { id: bandId(), label: 'Success', min: 7, max: 10 },
                { id: bandId(), label: 'Triumph', min: 11, max: 12 },
            ],
        },
        {
            id: 'dt_d20', name: 'd20', faces: 20, bands: [
                { id: bandId(), label: 'Catastrophe', min: 1, max: 2 },
                { id: bandId(), label: 'Failure', min: 3, max: 6 },
                { id: bandId(), label: 'Success', min: 7, max: 15 },
                { id: bandId(), label: 'Triumph', min: 16, max: 19 },
                { id: bandId(), label: 'Narrative Boon', min: 20, max: 20 },
            ],
        },
        {
            id: 'dt_d100', name: 'd100', faces: 100, bands: [
                { id: bandId(), label: 'Fumble', min: 1, max: 5 },
                { id: bandId(), label: 'Failure', min: 6, max: 50 },
                { id: bandId(), label: 'Success', min: 51, max: 95 },
                { id: bandId(), label: 'Critical', min: 96, max: 100 },
            ],
        },
    ];
}

const DEFAULT_CATEGORY_NAMES = ['Combat', 'Perception', 'Stealth', 'Social', 'Movement', 'Knowledge'];

export function buildDefaultDiceSystem(): DiceSystemConfig {
    const dieTypes = buildDefaultDieTypes();
    return {
        dieTypes,
        categories: DEFAULT_CATEGORY_NAMES.map((name, i) => ({
            id: `cat_default_${i}`,
            name,
            dieTypeId: 'dt_d20',
        })),
    };
}

/**
 * Migrate legacy `diceConfig` (d20-only threshold object) → `diceSystem`.
 * If `diceSystem` already exists, leave it. If only `diceConfig` exists, build
 * a d20 die type whose bands reflect the old thresholds.
 */
function migrateDiceConfig(ctx: Partial<GameContext>): DiceSystemConfig {
    if (ctx.diceSystem) return ctx.diceSystem;
    const sys = buildDefaultDiceSystem();
    const old = ctx.diceConfig;
    if (old) {
        const d20 = sys.dieTypes.find(d => d.id === 'dt_d20');
        if (d20) {
            d20.bands = [
                { id: bandId(), label: 'Catastrophe', min: 1, max: Math.max(1, old.catastrophe) },
                { id: bandId(), label: 'Failure', min: old.catastrophe + 1, max: Math.max(old.catastrophe + 1, old.failure) },
                { id: bandId(), label: 'Success', min: old.failure + 1, max: Math.max(old.failure + 1, old.success) },
                { id: bandId(), label: 'Triumph', min: old.success + 1, max: Math.max(old.success + 1, old.triumph) },
                { id: bandId(), label: 'Narrative Boon', min: old.triumph + 1, max: Math.max(old.triumph + 1, old.crit) },
            ];
        }
    }
    return sys;
}

/**
 * Migrate a partial/legacy GameContext into a complete one. Currently handles
 * the dice-system migration (old `diceConfig` → new `diceSystem`); callers
 * spread the result with `defaultContext` to fill any other gaps. Mirrors the
 * mainApp `migrateLegacyContext` precedent (scoped to the dice concern).
 */
export function migrateDiceSystem(ctx: Partial<GameContext>): GameContext {
    const merged = { ...ctx } as GameContext;
    if (!merged.diceSystem) {
        merged.diceSystem = migrateDiceConfig(merged);
    }
    return merged;
}

