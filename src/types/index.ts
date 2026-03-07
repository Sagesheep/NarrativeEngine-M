export type ProviderConfig = {
    id: string;
    label: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
};

export type DiceConfig = {
    catastrophe: number;
    failure: number;
    mixedSuccess: number;
    cleanSuccess: number;
    exceptionalSuccess: number;
};

export type SurpriseConfig = {
    types: string[];  // Event types (e.g. "ENVIRONMENTAL_HAZARD")
    tones: string[];  // Event tones (e.g. "GOOD", "BAD")
    initialDC: number; // Starting DC after a reset (default: 98)
    dcReduction: number; // Amount DC drops per turn (default: 3)
};

// Bundles GM + Summarizer provider together for quick-switching
export type ProviderPreset = {
    id: string;
    label: string;              // e.g. "Cloud Full", "Hybrid", "Budget"
    gmProviderId: string;       // which provider is the Main GM
    summarizerProviderId?: string; // which provider summarizes. Empty = same as GM
};

export type AppSettings = {
    providers: ProviderConfig[];
    activeProviderId: string;
    summarizerProviderId?: string; // Which provider does condensation. Empty = use activeProviderId.
    presets: ProviderPreset[];
    activePresetId?: string;
    contextLimit: number;
    autoCondenseEnabled: boolean;
    debugMode?: boolean; // Toggles inline payload viewer
    theme?: 'light' | 'dark'; // UI theme
    // Legacy fields kept for migration only
    endpoint?: string;
    apiKey?: string;
    modelName?: string;

    // Image API
    imageApiEndpoint?: string;
    imageApiKey?: string;
    imageApiModel?: string;
};

export type CondenserState = {
    condensedSummary: string;
    condensedUpToIndex: number;
    isCondensing: boolean;
};

export type WorldEventConfig = {
    initialDC: number; // Starting DC (default: 198)
    dcReduction: number; // Amount DC drops per turn (default: 3)
    who?: string[]; // The custom 'who' table
    where?: string[]; // The custom 'where' table
    why?: string[]; // The custom 'why' table
    what?: string[]; // The custom 'what' table
};

export type GameContext = {
    loreRaw: string;
    rulesRaw: string;
    canonState: string;
    headerIndex: string;
    starter: string;
    continuePrompt: string;
    inventory: string;
    characterProfile: string;
    surpriseDC?: number;
    worldEventDC?: number;
    diceConfig?: DiceConfig;
    worldEventConfig?: WorldEventConfig;
    // Toggles: whether each field is appended to context
    canonStateActive: boolean;
    headerIndexActive: boolean;
    starterActive: boolean;
    continuePromptActive: boolean;
    inventoryActive: boolean;
    characterProfileActive: boolean;
    surpriseEngineActive: boolean;
    worldEngineActive: boolean;
    diceFairnessActive: boolean;
    surpriseConfig?: SurpriseConfig;
};

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    displayContent?: string; // Clean text for UI (without dice/surprise blocks)
    timestamp: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debugPayload?: any; // Stores the exact JSON LLM payload
    name?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
};

export type Campaign = {
    id: string;
    name: string;
    coverImage: string; // base64 data URL
    createdAt: number;
    lastPlayedAt: number;
};

export type LoreChunk = {
    id: string;
    header: string;
    content: string;
    tokens: number;
    alwaysInclude: boolean;
    triggerKeywords: string[];  // exact keywords that activate this chunk
    scanDepth: number;          // how many recent messages to scan (default: 3)
};

export type NPCEntry = {
    id: string;
    name: string;
    aliases: string;
    appearance: string;
    disposition: string;
    status: string;
    goals: string;
    nature: number;   // 1-10
    training: number; // 1-10
    emotion: number;  // 1-10
    social: number;   // 1-10
    belief: number;   // 1-10
    ego: number;      // 1-10
    affinity: number; // 0-100
    portrait?: string; // Image path or base64
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
