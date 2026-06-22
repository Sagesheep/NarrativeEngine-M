import type { CombatTier, Archetype, StatBlock, CharacterProfileState, CharacterTrait, SceneEventType, DivergenceCategory } from '../../types';

// ─── Point-buy budget tables ──────────────────────────────────────────────────

export const PC_POINT_BUY: {
    NORMAL: { totalPoints: number; min: number; max: number; tier: CombatTier };
    OP: { totalPoints: number; min: number; max: number; tier: CombatTier };
} = {
    NORMAL: { totalPoints: 27, min: 8, max: 15, tier: 'grunt' },
    OP: { totalPoints: 37, min: 8, max: 20, tier: 'elite' },
};

export const STAT_KEYS = ['VIT', 'PWR', 'RES', 'FOC', 'SPD', 'WIL'] as const;
export type StatKey = typeof STAT_KEYS[number];

// ─── Point-buy cost table (D&D 5e standard) ───────────────────────────────────

const POINT_BUY_COST: Record<number, number> = {
    8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};

const OP_POINT_BUY_COST: Record<number, number> = {
    8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9, 16: 11, 17: 13, 18: 15, 19: 17, 20: 19,
};

export function getPointCost(value: number, budget: 'NORMAL' | 'OP'): number {
    if (budget === 'OP') return OP_POINT_BUY_COST[value] ?? 99;
    return POINT_BUY_COST[value] ?? 99;
}

// ─── Point-buy allocation logic ───────────────────────────────────────────────

export type PointBuyAllocation = {
    stats: StatBlock;
    budget: 'NORMAL' | 'OP';
    pointsSpent: number;
    pointsRemaining: number;
    isValid: boolean;
};

export const DEFAULT_STATS: StatBlock = { VIT: 8, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 };

export function validateAllocation(stats: StatBlock, budget: 'NORMAL' | 'OP'): PointBuyAllocation {
    const cfg = PC_POINT_BUY[budget];
    let pointsSpent = 0;
    let isValid = true;

    for (const key of STAT_KEYS) {
        const val = stats[key];
        if (val < cfg.min || val > cfg.max) {
            isValid = false;
        }
        pointsSpent += getPointCost(val, budget);
    }

    if (pointsSpent > cfg.totalPoints) isValid = false;

    return {
        stats,
        budget,
        pointsSpent,
        pointsRemaining: cfg.totalPoints - pointsSpent,
        isValid,
    };
}

export function allocateStat(
    current: StatBlock,
    key: StatKey,
    value: number,
    budget: 'NORMAL' | 'OP',
): StatBlock {
    const cfg = PC_POINT_BUY[budget];
    const clamped = Math.max(cfg.min, Math.min(cfg.max, value));
    return { ...current, [key]: clamped };
}

// ─── Quick-allocate presets ────────────────────────────────────────────────────

export const ARCHETYPE_PRESETS: Record<Archetype, StatBlock> = {
    bulwark:   { VIT: 15, PWR: 10, RES: 14, FOC:  8, SPD:  8, WIL: 10 },
    assassin:  { VIT: 10, PWR: 13, RES: 10, FOC: 10, SPD: 15, WIL: 11 },
    caster:    { VIT:  8, PWR:  8, RES: 10, FOC: 15, SPD: 10, WIL: 14 },
    skirmisher:{ VIT: 12, PWR: 11, RES: 10, FOC: 10, SPD: 14, WIL: 10 },
    brute:     { VIT: 14, PWR: 15, RES: 10, FOC:  8, SPD: 10, WIL:  8 },
};

// ─── Creation question script (engine-static, no LLM) ──────────────────────────

export type CreationQuestion = {
    id: string;
    prompt: string;
    field: string;
    type: 'text' | 'textarea' | 'select';
    options?: string[];
    required: boolean;
};

export const CREATION_QUESTIONS: CreationQuestion[] = [
    { id: 'name', prompt: 'What is your character\'s name?', field: 'name', type: 'text', required: true },
    { id: 'concept', prompt: 'Describe your character\'s concept or background in a sentence or two.', field: 'concept', type: 'textarea', required: true },
    { id: 'playstyle', prompt: 'How do you prefer to approach challenges?', field: 'playstyle', type: 'select', options: ['Stand firm and protect allies (Bulwark)', 'Strike from shadows with precision (Assassin)', 'Wield arcane power from range (Caster)', 'Move fast and adapt (Skirmisher)', 'Overwhelm with raw force (Brute)'], required: true },
    { id: 'voice', prompt: 'How does your character speak? (Accent, vocabulary, verbal quirks)', field: 'voice', type: 'textarea', required: false },
    { id: 'drives', prompt: 'What drives your character? What do they want most?', field: 'drives', type: 'textarea', required: false },
    { id: 'archetype', prompt: 'Choose your combat archetype:', field: 'archetype', type: 'select', options: ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'], required: true },
];

// ─── OP toggle ────────────────────────────────────────────────────────────────

export function getPCTier(isOP: boolean): CombatTier {
    return PC_POINT_BUY[isOP ? 'OP' : 'NORMAL'].tier;
}

export function getPCBudget(isOP: boolean): 'NORMAL' | 'OP' {
    return isOP ? 'OP' : 'NORMAL';
}

// ─── Build structured character profile state for [CHARACTER PROFILE] block ──────
//
// Replaces buildCharacterProfileText. Returns a CharacterProfileState with:
//   - identity (always injected, Tier 1 core)
//   - stats (structured, projected from the allocation)
//   - activeTraits (3-5 seed traits derived from concept/voice/drives, tagged
//     with SceneEventType so the retrieval layer can scene-filter them)
//
// The legacy flat-string shape is gone — the parser and payload builder now
// consume the structured form. See CharacterProfileState in types/index.ts.

function seedTrait(
    subject: string,
    category: DivergenceCategory,
    text: string,
    importance: number,
    eventTags: SceneEventType[],
): CharacterTrait {
    return {
        id: `seed-${subject.toLowerCase()}-${category}-${Math.random().toString(36).slice(2, 8)}`,
        subject,
        category,
        text,
        importance,
        eventTags,
        sceneEstablished: 'pc-creation',
        superseded: false,
        source: 'seed',
    };
}

export function buildCharacterProfileState(entry: {
    name: string;
    concept?: string;
    playstyle?: string;
    voice?: string;
    drives?: string;
    stats: StatBlock;
    archetype: Archetype;
    isOP: boolean;
}): CharacterProfileState {
    const traits: CharacterTrait[] = [];

    if (entry.concept) {
        traits.push(seedTrait(
            entry.name,
            'party_facts',
            `Concept: ${entry.concept}`,
            8,
            ['relationship_shift', 'revelation', 'quest_milestone'],
        ));
    }
    if (entry.voice) {
        traits.push(seedTrait(
            entry.name,
            'party_facts',
            `Voice: ${entry.voice}`,
            5,
            ['relationship_shift', 'other'],
        ));
    }
    if (entry.drives) {
        traits.push(seedTrait(
            entry.name,
            'promises_debts',
            `Drives: ${entry.drives}`,
            9,
            ['promise', 'quest_milestone', 'relationship_shift'],
        ));
    }
    // Archetype is always seeded — it's combat-relevant identity.
    traits.push(seedTrait(
        entry.name,
        'party_facts',
        `Archetype: ${entry.archetype}`,
        7,
        ['combat', 'discovery'],
    ));

    return {
        identity: {
            name: entry.name,
            archetype: entry.archetype,
            level: 1,
        },
        stats: entry.stats,
        activeTraits: traits,
    };
}

/**
 * @deprecated Use buildCharacterProfileState instead. Retained only for
 * backward-compatibility with any external callers; the structured form is
 * canonical. Returns a flat-string projection of the structured state.
 */
export function buildCharacterProfileText(entry: {
    name: string;
    concept?: string;
    playstyle?: string;
    voice?: string;
    drives?: string;
    stats: StatBlock;
    archetype: Archetype;
    isOP: boolean;
}): string {
    const state = buildCharacterProfileState(entry);
    const lines: string[] = [];
    if (state.identity.name) lines.push(`**${state.identity.name}**`);
    if (state.identity.archetype) lines.push(`Archetype: ${state.identity.archetype}`);
    if (state.stats) {
        const s = state.stats;
        lines.push(`VIT ${s.VIT} | PWR ${s.PWR} | RES ${s.RES} | FOC ${s.FOC} | SPD ${s.SPD} | WIL ${s.WIL}`);
    }
    for (const trait of state.activeTraits) {
        lines.push(trait.text);
    }
    return lines.join('\n');
}