import type { DiceSystemConfig, DieType, GameContext, ManualRollRequest, RollDefinition } from '../../types';
import { mapTier, mapTierLegacy } from './diceTier';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHAT, DEFAULT_WORLD_WHERE,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHY
} from '../../store/slices/settingsSlice';

export type EngineRollResult = {
    appendToInput: string;
    updatedDCs: {
        surpriseDC: number;
        encounterDC: number;
        worldEventDC: number;
    };
};

// ── 3-gate dice rolling core ────────────────────────────────────────────

/**
 * Execute a roll using the 3-gate model (modifier / count / aggregation)
 * against a specific DieType. Returns the final value, all raw dice rolled,
 * and a human-readable detail label.
 *
 * Gate 1 (modifier): none / adv / disadv
 * Gate 2 (count):     number of dice to roll
 * Gate 3 (aggregation): pick_one / total_all
 *   - pick_one + none  → roll `count` dice, take the first (or random single)
 *   - pick_one + adv   → roll `count` dice, take the highest
 *   - pick_one + disadv → roll `count` dice, take the lowest
 *   - total_all        → roll `count` dice, sum them (modifier ignored)
 */
export type GateRollResult = {
    value: number;      // final value after aggregation
    rolls: number[];    // all raw dice rolled
    detail: string;     // player-facing label
};

export function executeGateRoll(dieType: DieType, rollDef: RollDefinition): GateRollResult {
    const rollDie = () => Math.floor(Math.random() * dieType.faces) + 1;
    const count = Math.max(1, rollDef.count);

    // total_all: sum all dice, modifier is meaningless
    if (rollDef.aggregation === 'total_all') {
        const rolls = Array.from({ length: count }, rollDie);
        const value = rolls.reduce((a, b) => a + b, 0);
        return { value, rolls, detail: `${count}${dieType.name} total` };
    }

    // pick_one: modifier determines which die to keep
    const rolls = Array.from({ length: count }, rollDie);
    let value: number;
    let detail: string;
    if (rollDef.modifier === 'adv') {
        value = Math.max(...rolls);
        detail = count > 1 ? `${count}${dieType.name} advantage (highest)` : `1${dieType.name}`;
    } else if (rollDef.modifier === 'disadv') {
        value = Math.min(...rolls);
        detail = count > 1 ? `${count}${dieType.name} disadvantage (lowest)` : `1${dieType.name}`;
    } else {
        // none: take the first die (or just the single die)
        value = rolls[0];
        detail = count > 1 ? `${count}${dieType.name}` : `1${dieType.name}`;
    }
    return { value, rolls, detail };
}

/**
 * Resolve a die expression like "2d6+1" into { count, faces, modifier }.
 * Used by the tool handler for ad-hoc dice expressions.
 */
export function parseDiceExpr(expr: string): { count: number; faces: number; modifier: number } | null {
    const match = expr.trim().toLowerCase().match(/^(\d+)d(\d+)([+-]\d+)?$/);
    if (!match) return null;
    return {
        count: Math.min(parseInt(match[1], 10), 100),
        faces: parseInt(match[2], 10),
        modifier: match[3] ? parseInt(match[3], 10) : 0,
    };
}

// ── World engines (unchanged) ──────────────────────────────────────────

export function rollEngines(context: GameContext): EngineRollResult {
    let newSurpriseDC = context.surpriseDC ?? 95;
    let newEncounterDC = context.encounterDC ?? 198;
    let newWorldDC = context.worldEventDC ?? 498;
    let appendToInput = '';

    // Tier 1: Surprise Engine (Color/Ambient)
    if (context.surpriseEngineActive !== false) {
        const roll = Math.floor(Math.random() * 100) + 1;
        if (roll >= newSurpriseDC) {
            const typesList = context.surpriseConfig?.types || DEFAULT_SURPRISE_TYPES;
            const tonesList = context.surpriseConfig?.tones || DEFAULT_SURPRISE_TONES;
            const type = typesList[Math.floor(Math.random() * typesList.length)];
            const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

            appendToInput += `\n[SURPRISE EVENT: ${type} (${tone})]`;
            newSurpriseDC = context.surpriseConfig?.initialDC || 95;
            console.log(`[Surprise Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newSurpriseDC}`);
        } else {
            console.log(`[Surprise Engine] Roll: ${roll} < DC: ${newSurpriseDC}. Decreasing DC.`);
            newSurpriseDC = Math.max(5, newSurpriseDC - (context.surpriseConfig?.dcReduction || 3));
        }
    }

    // Tier 2: Encounter Engine (Challenges/Hooks)
    if (context.encounterEngineActive !== false) {
        const roll = Math.floor(Math.random() * 200) + 1;
        if (roll >= newEncounterDC) {
            const typesList = context.encounterConfig?.types || DEFAULT_ENCOUNTER_TYPES;
            const tonesList = context.encounterConfig?.tones || DEFAULT_ENCOUNTER_TONES;
            const type = typesList[Math.floor(Math.random() * typesList.length)];
            const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

            appendToInput += `\n[ENCOUNTER EVENT: ${type} (${tone})]`;
            newEncounterDC = context.encounterConfig?.initialDC || 198;
            console.log(`[Encounter Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newEncounterDC}`);
        } else {
            console.log(`[Encounter Engine] Roll: ${roll} < DC: ${newEncounterDC}. Decreasing DC.`);
            newEncounterDC = Math.max(5, newEncounterDC - (context.encounterConfig?.dcReduction || 2));
        }
    }

    // Tier 3: World Engine (Seismic/Global)
    if (context.worldEngineActive !== false) {
        const worldRoll = Math.floor(Math.random() * 500) + 1;
        if (worldRoll >= newWorldDC) {
            const cfg = context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] };
            const hasCustomTags = cfg.who && cfg.who.length >= 3 &&
                cfg.where && cfg.where.length >= 3 &&
                cfg.why && cfg.why.length >= 3 &&
                cfg.what && cfg.what.length >= 3;

            const tag = hasCustomTags
                ? `[WORLD_RUMOUR: ${cfg.who![Math.floor(Math.random() * cfg.who!.length)]} ${cfg.what![Math.floor(Math.random() * cfg.what!.length)]} ${cfg.where![Math.floor(Math.random() * cfg.where!.length)]} — ${cfg.why![Math.floor(Math.random() * cfg.why!.length)]}]`
                : `[WORLD_RUMOUR: ${DEFAULT_WORLD_WHO[Math.floor(Math.random() * DEFAULT_WORLD_WHO.length)]} ${DEFAULT_WORLD_WHAT[Math.floor(Math.random() * DEFAULT_WORLD_WHAT.length)]} ${DEFAULT_WORLD_WHERE[Math.floor(Math.random() * DEFAULT_WORLD_WHERE.length)]} — ${DEFAULT_WORLD_WHY[Math.floor(Math.random() * DEFAULT_WORLD_WHY.length)]}]`;

            appendToInput += `\n${tag}`;
            newWorldDC = cfg.initialDC || 498;
            console.log(`[World Engine] Triggered! Tag: ${tag}. Resetting DC to ${newWorldDC}`);
        } else {
            console.log(`[World Engine] Roll: ${worldRoll} < DC: ${newWorldDC}. Decreasing DC.`);
            newWorldDC = Math.max(5, newWorldDC - (context.worldEventConfig?.dcReduction || 2));
        }
    }

    return {
        appendToInput,
        updatedDCs: {
            surpriseDC: newSurpriseDC,
            encounterDC: newEncounterDC,
            worldEventDC: newWorldDC
        }
    };
}

// ── Dice Fairness Engine (generalized) ─────────────────────────────────

/**
 * Pool mode: pre-roll each category using its die type + the global 3-gate
 * roll definition, inject results into the prompt. Returns empty string when
 * diceFairnessActive is false (tool mode — AI calls roll_dice on demand).
 *
 * Legacy: if no diceSystem is configured, falls back to the old d20 pool.
 */
export function rollDiceFairness(context: GameContext): string {
    if (context.diceFairnessActive === false) return '';

    // New generalized path
    if (context.diceSystem) {
        return rollDiceFairnessGeneralized(context.diceSystem);
    }

    // Legacy d20 fallback (old diceConfig thresholds)
    return rollDiceFairnessLegacy(context);
}

function rollDiceFairnessGeneralized(sys: DiceSystemConfig): string {
    // Pool mode: one singular roll per category. No 3-gate config — the 3-gate
    // model is per-roll (dice me modal / roll_dice tool), not for the permanent
    // pre-roll injection. Just roll the category's die and map to its band.
    const parts: string[] = [];
    for (const cat of sys.categories) {
        const dieType = sys.dieTypes.find(d => d.id === cat.dieTypeId);
        if (!dieType) continue;
        const value = Math.floor(Math.random() * dieType.faces) + 1;
        const tier = mapTier(value, dieType) ?? 'Unmapped';
        parts.push(`${cat.name.toUpperCase()}=(${value} → ${tier})`);
    }
    return `\n[DICE OUTCOMES: ${parts.join(' | ')}]`;
}

function rollDiceFairnessLegacy(context: GameContext): string {
    const generatePool = () => {
        const rolls = [
            Math.floor(Math.random() * 20) + 1,
            Math.floor(Math.random() * 20) + 1,
            Math.floor(Math.random() * 20) + 1
        ].sort((a, b) => a - b);
        return `Disadvantage: ${mapTierLegacy(rolls[0], context.diceConfig ?? null) ?? 'Unknown'}, Normal: ${mapTierLegacy(rolls[1], context.diceConfig ?? null) ?? 'Unknown'}, Advantage: ${mapTierLegacy(rolls[2], context.diceConfig ?? null) ?? 'Unknown'}`;
    };
    return `\n[DICE OUTCOMES: COMBAT=(${generatePool()}) | PERCEPTION=(${generatePool()}) | STEALTH=(${generatePool()}) | SOCIAL=(${generatePool()}) | MOVEMENT=(${generatePool()}) | KNOWLEDGE=(${generatePool()}) | MUNDANE=(Narrative Boon)]`;
}

// ── Manual "dice me" roll (generalized) ────────────────────────────────

export type ManualRollResult = {
    tier: string | null;   // band label via mapTier, or null if unmapped
    faceValue: number;     // final value after aggregation
    detail: string;        // player-facing label
    rolls: number[];       // raw dice rolled
};

/**
 * Resolve a player-called "dice me" roll (WO-H) using the 3-gate model.
 * Rolls REAL dice at send time so the result is hidden until the player
 * commits, then the orchestrator asserts the result as fact.
 *
 * Accepts either:
 *   - ManualRollRequest (new 3-gate shape), or
 *   - string '1d20' | 'adv' | 'disadv' (legacy — migrated to a d20 gate roll)
 */
export function resolveManualRoll(
    req: ManualRollRequest | string,
    sys?: DiceSystemConfig | null
): ManualRollResult {
    // Legacy string migration
    if (typeof req === 'string') {
        return resolveManualRollLegacy(req, sys);
    }

    // New 3-gate path
    const dieType = sys?.dieTypes.find(d => d.id === req.dieTypeId);
    if (!dieType) {
        // Fallback: use first die type, or d20 default
        const fallback = sys?.dieTypes[0];
        if (!fallback) return { tier: null, faceValue: 0, detail: 'No die type', rolls: [] };
        const r = executeGateRoll(fallback, req.rollDef);
        return { tier: mapTier(r.value, fallback), faceValue: r.value, detail: r.detail, rolls: r.rolls };
    }

    const r = executeGateRoll(dieType, req.rollDef);
    return { tier: mapTier(r.value, dieType), faceValue: r.value, detail: r.detail, rolls: r.rolls };
}

function resolveManualRollLegacy(
    mode: string,
    sys?: DiceSystemConfig | null
): ManualRollResult {
    // Map old '1d20'|'adv'|'disadv' to a d20 gate roll
    const d20 = sys?.dieTypes.find(d => d.name === 'd20') ?? {
        id: 'legacy_d20',
        name: 'd20',
        faces: 20,
        bands: [
            { id: 'l1', label: 'Catastrophe', min: 1, max: 2 },
            { id: 'l2', label: 'Failure', min: 3, max: 6 },
            { id: 'l3', label: 'Success', min: 7, max: 15 },
            { id: 'l4', label: 'Triumph', min: 16, max: 19 },
            { id: 'l5', label: 'Narrative Boon', min: 20, max: 20 },
        ],
    };

    const rollDef: RollDefinition =
        mode === 'adv' ? { modifier: 'adv', count: 2, aggregation: 'pick_one' }
        : mode === 'disadv' ? { modifier: 'disadv', count: 2, aggregation: 'pick_one' }
        : { modifier: 'none', count: 1, aggregation: 'pick_one' };

    const r = executeGateRoll(d20, rollDef);
    const detail = mode === 'adv' ? 'Advantage' : mode === 'disadv' ? 'Disadvantage' : 'Roll';
    return { tier: mapTier(r.value, d20), faceValue: r.value, detail, rolls: r.rolls };
}