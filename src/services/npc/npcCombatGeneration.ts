import type { StatBlock, CombatTier, Archetype, ItemDef, SkillDef, NPCOverride } from '../../types';
import { ARCHETYPE_BUDGETS } from '../engine/combatEngine';
import { uid } from '../../utils/uid';

// ─── Tier-Scaled Dice Budgets (A3 anti-inflation) ─────────────────────────
// Minions get d4 weapons, grunts d6, elites d8, bosses d10, legendaries d12.
// Skill dice follow similar caps. Bonus is tier-appropriate.
export const TIER_DICE_BUDGETS: Record<CombatTier, { weaponDice: number; skillDice: number; bonus: number; rarity: ItemDef['rarity'] }> = {
    minion:    { weaponDice: 4,  skillDice: 4,  bonus: 0, rarity: 'common' },
    grunt:     { weaponDice: 6,  skillDice: 6,  bonus: 1, rarity: 'common' },
    elite:     { weaponDice: 8,  skillDice: 8,  bonus: 2, rarity: 'uncommon' },
    boss:      { weaponDice: 10, skillDice: 10, bonus: 3, rarity: 'rare' },
    legendary: { weaponDice: 12, skillDice: 12, bonus: 4, rarity: 'epic' },
};

// ─── Stat Derivation ────────────────────────────────────────────────────────

const TIER_STAT_SCALE: Record<CombatTier, number> = {
    minion: 0.75,
    grunt: 1.0,
    elite: 1.2,
    boss: 1.4,
    legendary: 1.7,
};

const MIN_STAT = 6;
const MAX_STAT = 20;

function clampStat(val: number): number {
    return Math.max(MIN_STAT, Math.min(MAX_STAT, Math.round(val)));
}

export function deriveStatsFromBudget(tier: CombatTier, archetype: Archetype): StatBlock {
    const budget = ARCHETYPE_BUDGETS[archetype];
    const scale = TIER_STAT_SCALE[tier];
    return {
        VIT: clampStat(budget.VIT * scale),
        PWR: clampStat(budget.PWR * scale),
        RES: clampStat(budget.RES * scale),
        FOC: clampStat(budget.FOC * scale),
        SPD: clampStat(budget.SPD * scale),
        WIL: clampStat(budget.WIL * scale),
    };
}

// ─── Weapon Templates by Archetype ──────────────────────────────────────────

const ARCHETYPE_WEAPON_TEMPLATES: Record<Archetype, { name: string; range: ItemDef['range']; scalingStat: ItemDef['scalingStat']; properties: string[] }[]> = {
    bulwark: [
        { name: 'Shield Blade', range: 'Close', scalingStat: 'PWR', properties: ['melee', 'defensive'] },
        { name: 'War Mace', range: 'Close', scalingStat: 'PWR', properties: ['melee', 'bludgeoning'] },
    ],
    assassin: [
        { name: 'Assassin Dagger', range: 'Close', scalingStat: 'SPD', properties: ['melee', 'finesse'] },
        { name: 'Throwing Knives', range: 'Ranged', scalingStat: 'SPD', properties: ['thrown', 'finesse'] },
    ],
    caster: [
        { name: 'Arcane Staff', range: 'Ranged', scalingStat: 'WIL', properties: ['magic', 'twoHanded'] },
        { name: 'Runed Scepter', range: 'Ranged', scalingStat: 'WIL', properties: ['magic', 'focus'] },
    ],
    skirmisher: [
        { name: 'Shortsword', range: 'Close', scalingStat: 'SPD', properties: ['melee', 'light'] },
        { name: 'Light Bow', range: 'Ranged', scalingStat: 'SPD', properties: ['ranged', 'light'] },
    ],
    brute: [
        { name: 'Great Axe', range: 'Close', scalingStat: 'PWR', properties: ['melee', 'heavy'] },
        { name: 'War Hammer', range: 'Close', scalingStat: 'PWR', properties: ['melee', 'bludgeoning', 'heavy'] },
    ],
};

// ─── Skill Templates by Archetype ───────────────────────────────────────────

type SkillTemplate = {
    name: string;
    type: SkillDef['type'];
    scaling: SkillDef['scaling'];
    range: SkillDef['range'];
    properties: string[];
};

const ARCHETYPE_SKILL_TEMPLATES: Record<Archetype, SkillTemplate[]> = {
    bulwark: [
        { name: 'Shield Block', type: 'utility', scaling: 'PWR', range: 'Close', properties: ['defensive', 'guard'] },
        { name: 'Taunting Strike', type: 'attack', scaling: 'PWR', range: 'Close', properties: ['melee'] },
    ],
    assassin: [
        { name: 'Backstab', type: 'attack', scaling: 'SPD', range: 'Close', properties: ['finesse', 'stealth'] },
        { name: 'Smoke Step', type: 'utility', scaling: 'SPD', range: 'Close', properties: ['mobility'] },
    ],
    caster: [
        { name: 'Arcane Bolt', type: 'attack', scaling: 'WIL', range: 'Ranged', properties: ['magic'] },
        { name: 'Frost Shield', type: 'utility', scaling: 'WIL', range: 'Close', properties: ['defensive', 'magic'] },
        { name: 'Drain Life', type: 'heal', scaling: 'WIL', range: 'Ranged', properties: ['necromancy'] },
    ],
    skirmisher: [
        { name: 'Quick Strike', type: 'attack', scaling: 'SPD', range: 'Close', properties: ['light'] },
        { name: 'Evasive Maneuver', type: 'utility', scaling: 'SPD', range: 'Close', properties: ['mobility'] },
    ],
    brute: [
        { name: 'Power Strike', type: 'attack', scaling: 'PWR', range: 'Close', properties: ['heavy'] },
        { name: 'Rage', type: 'utility', scaling: 'PWR', range: 'Close', properties: ['berserker'] },
    ],
};

// ─── Skill count by tier (0-3) ─────────────────────────────────────────────

const TIER_SKILL_COUNT: Record<CombatTier, number> = {
    minion: 0,
    grunt: 1,
    elite: 2,
    boss: 2,
    legendary: 3,
};

// ─── Inventory items by tier (flavor, not combat-relevant) ──────────────────

const TIER_INVENTORY_TEMPLATES: Record<CombatTier, { name: string; properties: string[] }[]> = {
    minion: [],
    grunt: [{ name: 'Rations', properties: ['consumable'] }],
    elite: [{ name: 'Rations', properties: ['consumable'] }, { name: 'Healing Salve', properties: ['consumable', 'healing'] }],
    boss: [{ name: 'Rations', properties: ['consumable'] }, { name: 'Healing Salve', properties: ['consumable', 'healing'] }, { name: 'Scroll of Warding', properties: ['consumable', 'magic'] }],
    legendary: [{ name: 'Rations', properties: ['consumable'] }, { name: 'Superior Healing Salve', properties: ['consumable', 'healing'] }, { name: 'Scroll of Warding', properties: ['consumable', 'magic'] }],
};

// ─── Override templates by archetype (conservative, 0-1) ────────────────────

const ARCHETYPE_OVERRIDE_SEEDS: Partial<Record<Archetype, { trigger: string; action: string }>> = {
    bulwark: { trigger: 'onAllyBelow(30)', action: 'guard' },
    brute: { trigger: 'onSelfBelow(30)', action: 'attack' },
};

// ─── Def Creation ────────────────────────────────────────────────────────────

export function createItemDefFromTemplate(
    name: string,
    tier: CombatTier,
    archetype: Archetype,
): ItemDef {
    const budget = TIER_DICE_BUDGETS[tier];
    const tmpl = ARCHETYPE_WEAPON_TEMPLATES[archetype]?.find(t => t.name.toLowerCase() === name.toLowerCase());
    return {
        id: uid(),
        name,
        description: `A ${budget.rarity}-tier weapon suitable for a ${archetype}.`,
        damageDice: budget.weaponDice,
        scalingStat: tmpl?.scalingStat ?? 'PWR',
        bonus: budget.bonus,
        properties: tmpl?.properties ?? [],
        range: tmpl?.range ?? ARCHETYPE_DEFAULT_RANGE[archetype],
        rarity: budget.rarity,
    };
}

const ARCHETYPE_DEFAULT_RANGE: Record<Archetype, ItemDef['range']> = {
    bulwark: 'Close',
    assassin: 'Close',
    caster: 'Ranged',
    skirmisher: 'Close',
    brute: 'Close',
};

export function createSkillDefFromTemplate(
    name: string,
    tier: CombatTier,
    type: SkillDef['type'],
    scaling: SkillDef['scaling'],
    range: SkillDef['range'],
): SkillDef {
    const budget = TIER_DICE_BUDGETS[tier];
    const skill: SkillDef = {
        id: uid(),
        name,
        description: `A ${type} skill.`,
        focCost: type === 'utility' ? 0 : (type === 'heal' ? Math.min(budget.skillDice - 2, 3) : Math.ceil(budget.skillDice / 2) + 1),
        type,
        scaling,
        properties: [],
        range,
    };
    if (type === 'attack') {
        skill.damageDice = Math.min(budget.skillDice, 8);
        skill.properties = ['magic'];
    } else if (type === 'heal') {
        skill.healDice = Math.min(budget.skillDice, 8);
        skill.properties = ['healing'];
    }
    return skill;
}

// ─── Resolve or Create ────────────────────────────────────────────────────────

export function resolveOrAddItemDef(
    name: string,
    tier: CombatTier,
    archetype: Archetype,
    existing: ItemDef[],
): { id: string; name: string; newDefs: ItemDef[] } {
    const existingItem = existing.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existingItem) {
        return { id: existingItem.id, name: existingItem.name, newDefs: [] };
    }
    const def = createItemDefFromTemplate(name, tier, archetype);
    return { id: def.id, name: def.name, newDefs: [def] };
}

export function resolveOrAddSkillDef(
    name: string,
    tier: CombatTier,
    type: SkillDef['type'],
    scaling: SkillDef['scaling'],
    range: SkillDef['range'],
    existing: SkillDef[],
): { id: string; name: string; newDefs: SkillDef[] } {
    const existingSkill = existing.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (existingSkill) {
        return { id: existingSkill.id, name: existingSkill.name, newDefs: [] };
    }
    const def = createSkillDefFromTemplate(name, tier, type, scaling, range);
    return { id: def.id, name: def.name, newDefs: [def] };
}

// ─── Assign Combat Loadout ──────────────────────────────────────────────────

export type CombatLoadout = {
    stats?: StatBlock;
    equippedWeapon?: string;
    knownSkills?: string[];
    inventory?: string[];
    overrides?: NPCOverride[];
    newItemDefs: ItemDef[];
    newSkillDefs: SkillDef[];
};

export function assignCombatLoadout(
    combatTier: CombatTier | undefined,
    archetype: Archetype | undefined,
    existingItems: ItemDef[],
    existingSkills: SkillDef[],
): CombatLoadout {
    const newItemDefs: ItemDef[] = [];
    const newSkillDefs: SkillDef[] = [];

    if (!combatTier || !archetype) {
        return {
            stats: undefined,
            equippedWeapon: undefined,
            knownSkills: undefined,
            inventory: undefined,
            overrides: undefined,
            newItemDefs: [],
            newSkillDefs: [],
        };
    }

    const stats = deriveStatsFromBudget(combatTier, archetype);

    const weaponTemplates = ARCHETYPE_WEAPON_TEMPLATES[archetype];
    const chosenWeapon = weaponTemplates[0];
    const weaponResult = resolveOrAddItemDef(chosenWeapon.name, combatTier, archetype, existingItems);
    newItemDefs.push(...weaponResult.newDefs);
    const equippedWeapon = weaponResult.id;

    const skillCount = TIER_SKILL_COUNT[combatTier];
    const skillTemplates = ARCHETYPE_SKILL_TEMPLATES[archetype];
    const knownSkills: string[] = [];
    const skillsToTake = skillTemplates.slice(0, skillCount);
    for (const tmpl of skillsToTake) {
        const skillResult = resolveOrAddSkillDef(tmpl.name, combatTier, tmpl.type, tmpl.scaling, tmpl.range, existingSkills);
        newItemDefs.push(...([] as ItemDef[]));
        newSkillDefs.push(...skillResult.newDefs);
        knownSkills.push(skillResult.id);
    }

    const inventory: string[] = [];
    const invTemplates = TIER_INVENTORY_TEMPLATES[combatTier];
    for (const invItem of invTemplates) {
        const invResult = resolveOrAddItemDef(invItem.name, combatTier, archetype, [...existingItems, ...newItemDefs]);
        newItemDefs.push(...invResult.newDefs);
        inventory.push(invResult.id);
    }

    let overrides: NPCOverride[] | undefined;
    const overrideSeed = ARCHETYPE_OVERRIDE_SEEDS[archetype];
    if (overrideSeed) {
        overrides = [{ trigger: overrideSeed.trigger, action: overrideSeed.action }];
    }

    return {
        stats,
        equippedWeapon,
        knownSkills,
        inventory: inventory.length > 0 ? inventory : undefined,
        overrides,
        newItemDefs,
        newSkillDefs,
    };
}