import { describe, it, expect } from 'vitest';
import {
    deriveStatsFromBudget,
    TIER_DICE_BUDGETS,
    createItemDefFromTemplate,
    createSkillDefFromTemplate,
    resolveOrAddItemDef,
    resolveOrAddSkillDef,
    assignCombatLoadout,
} from '../npc/npcCombatGeneration';
import type { ItemDef, SkillDef, CombatTier, Archetype } from '../../types';

describe('npcCombatGeneration', () => {
    describe('deriveStatsFromBudget', () => {
        it('derives stats from archetype budget scaled by tier', () => {
            const stats = deriveStatsFromBudget('elite', 'bulwark');
            expect(stats.VIT).toBeGreaterThan(0);
            expect(stats.PWR).toBeGreaterThan(0);
            expect(stats.RES).toBeGreaterThan(0);
            expect(stats.FOC).toBeGreaterThan(0);
            expect(stats.SPD).toBeGreaterThan(0);
            expect(stats.WIL).toBeGreaterThan(0);
        });

        it('produces non-default stats (not all-10s) for any combat tier', () => {
            for (const tier of ['minion', 'grunt', 'elite', 'boss', 'legendary'] as CombatTier[]) {
                for (const arc of ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'] as Archetype[]) {
                    const stats = deriveStatsFromBudget(tier, arc);
                    const allTens = stats.VIT === 10 && stats.PWR === 10 && stats.RES === 10
                        && stats.FOC === 10 && stats.SPD === 10 && stats.WIL === 10;
                    expect(allTens, `${tier}/${arc} produced all-10s`).toBe(false);
                }
            }
        });

        it('scales stats upward with tier (elite > grunt for the same archetype)', () => {
            const minionStats = deriveStatsFromBudget('minion', 'skirmisher');
            const eliteStats = deriveStatsFromBudget('elite', 'skirmisher');
            const minionSum = Object.values(minionStats).reduce((a, b) => a + b, 0);
            const eliteSum = Object.values(eliteStats).reduce((a, b) => a + b, 0);
            expect(eliteSum).toBeGreaterThan(minionSum);
        });

        it('respects archetype flavor: bulwark has higher VIT/RES than assassin', () => {
            const bulwark = deriveStatsFromBudget('grunt', 'bulwark');
            const assassin = deriveStatsFromBudget('grunt', 'assassin');
            expect(bulwark.VIT).toBeGreaterThanOrEqual(assassin.VIT);
            expect(bulwark.RES).toBeGreaterThanOrEqual(assassin.RES);
        });
    });

    describe('TIER_DICE_BUDGETS', () => {
        it('ensures minion weapon dice <= grunt weapon dice <= elite weapon dice <= boss <= legendary', () => {
            expect(TIER_DICE_BUDGETS.minion.weaponDice).toBeLessThanOrEqual(TIER_DICE_BUDGETS.grunt.weaponDice);
            expect(TIER_DICE_BUDGETS.grunt.weaponDice).toBeLessThanOrEqual(TIER_DICE_BUDGETS.elite.weaponDice);
            expect(TIER_DICE_BUDGETS.elite.weaponDice).toBeLessThanOrEqual(TIER_DICE_BUDGETS.boss.weaponDice);
            expect(TIER_DICE_BUDGETS.boss.weaponDice).toBeLessThanOrEqual(TIER_DICE_BUDGETS.legendary.weaponDice);
        });
    });

    describe('createItemDefFromTemplate', () => {
        it('creates an ItemDef with correct properties for a minion weapon', () => {
            const item = createItemDefFromTemplate('Rusty Dagger', 'minion', 'assassin');
            expect(item.name).toBe('Rusty Dagger');
            expect(item.damageDice).toBeLessThanOrEqual(TIER_DICE_BUDGETS.minion.weaponDice);
            expect(item.rarity).toBe('common');
            expect(item.id).toBeTruthy();
        });

        it('creates an ItemDef with appropriate rarity for boss tier', () => {
            const item = createItemDefFromTemplate('Warlord\'s Greatsword', 'boss', 'brute');
            expect(item.rarity).toBe('rare');
            expect(item.damageDice).toBeLessThanOrEqual(TIER_DICE_BUDGETS.boss.weaponDice);
        });

        it('creates a ranged weapon for caster archetype', () => {
            const item = createItemDefFromTemplate('Elder Staff', 'elite', 'caster');
            expect(item.range).toBe('Ranged');
        });
    });

    describe('createSkillDefFromTemplate', () => {
        it('creates a SkillDef with correct properties for a grunt skill', () => {
            const skill = createSkillDefFromTemplate('Slash', 'grunt', 'attack', 'PWR', 'Close');
            expect(skill.name).toBe('Slash');
            expect(skill.type).toBe('attack');
            expect(skill.damageDice).toBeLessThanOrEqual(TIER_DICE_BUDGETS.grunt.skillDice);
            expect(skill.id).toBeTruthy();
        });

        it('caps dice budget appropriately for minion tier', () => {
            const skill = createSkillDefFromTemplate('Quick Strike', 'minion', 'attack', 'SPD', 'Close');
            expect(skill.damageDice!).toBeLessThanOrEqual(TIER_DICE_BUDGETS.minion.skillDice);
        });
    });

    describe('resolveOrAddItemDef', () => {
        it('reuses existing item def with matching name', () => {
            const existing: ItemDef = {
                id: 'item_1',
                name: 'Longsword',
                description: 'A standard longsword.',
                damageDice: 8,
                scalingStat: 'PWR',
                bonus: 0,
                properties: [],
                range: 'Close',
                rarity: 'common',
            };
            const result = resolveOrAddItemDef('Longsword', 'grunt', 'skirmisher', [existing]);
            expect(result.id).toBe('item_1');
            expect(result.name).toBe('Longsword');
        });

        it('creates a new ItemDef if no match found', () => {
            const result = resolveOrAddItemDef('Shortsword', 'grunt', 'skirmisher', []);
            expect(result.name).toBe('Shortsword');
            expect(result.id).toBeTruthy();
        });
    });

    describe('resolveOrAddSkillDef', () => {
        it('reuses existing skill def with matching name', () => {
            const existing: SkillDef = {
                id: 'skill_1',
                name: 'Fireball',
                description: 'A fireball.',
                focCost: 5,
                type: 'attack',
                damageDice: 8,
                scaling: 'WIL',
                properties: ['fire'],
                range: 'Ranged',
            };
            const result = resolveOrAddSkillDef('Fireball', 'elite', 'attack', 'WIL', 'Ranged', [existing]);
            expect(result.id).toBe('skill_1');
            expect(result.name).toBe('Fireball');
        });

        it('creates a new SkillDef if no match found', () => {
            const result = resolveOrAddSkillDef('Shadow Bolt', 'elite', 'attack', 'WIL', 'Ranged', []);
            expect(result.name).toBe('Shadow Bolt');
            expect(result.id).toBeTruthy();
        });
    });

    describe('assignCombatLoadout', () => {
        it('returns equipment for a combat NPC', () => {
            const loadout = assignCombatLoadout('elite', 'caster', [], []);
            expect(loadout.equippedWeapon).toBeTruthy();
            expect(loadout.knownSkills!.length).toBeGreaterThanOrEqual(1);
        });

        it('returns no combat fields for purely social NPCs (no tier/archetype)', () => {
            const loadout = assignCombatLoadout(undefined, undefined, [], []);
            expect(loadout.stats).toBeUndefined();
            expect(loadout.equippedWeapon).toBeUndefined();
            expect(loadout.knownSkills).toBeUndefined();
            expect(loadout.inventory).toBeUndefined();
        });

        it('produces stats that are not all-10s', () => {
            const loadout = assignCombatLoadout('grunt', 'brute', [], []);
            const allTens = loadout.stats!.VIT === 10 && loadout.stats!.PWR === 10
                && loadout.stats!.RES === 10 && loadout.stats!.FOC === 10
                && loadout.stats!.SPD === 10 && loadout.stats!.WIL === 10;
            expect(allTens).toBe(false);
        });

        it('resolves weapon against existing compendium by name', () => {
            // Skirmisher's first weapon template is 'Shortsword' — a matching compendium entry is reused.
            const existingItem: ItemDef = {
                id: 'item_long',
                name: 'Shortsword',
                description: 'A light blade.',
                damageDice: 6,
                scalingStat: 'SPD',
                bonus: 1,
                properties: ['melee', 'light'],
                range: 'Close',
                rarity: 'common',
            };
            const loadout = assignCombatLoadout('grunt', 'skirmisher', [existingItem], []);
            expect(loadout.equippedWeapon).toBe('item_long');
        });

        it('creates new item defs when no compendium match', () => {
            const loadout = assignCombatLoadout('grunt', 'skirmisher', [], []);
            expect(loadout.equippedWeapon).toBeTruthy();
            expect(loadout.newItemDefs!.length).toBeGreaterThanOrEqual(1);
        });

        it('creates new skill defs when no compendium match', () => {
            const loadout = assignCombatLoadout('elite', 'caster', [], []);
            expect(loadout.knownSkills!.length).toBeGreaterThanOrEqual(1);
            expect(loadout.newSkillDefs!.length).toBeGreaterThanOrEqual(1);
        });

        it('reuses existing skill by name', () => {
            // Caster's first skill template is 'Arcane Bolt' — a matching compendium entry is reused.
            const existingSkill: SkillDef = {
                id: 'skill_fb',
                name: 'Arcane Bolt',
                description: 'A bolt of arcane energy.',
                focCost: 5,
                type: 'attack',
                damageDice: 8,
                scaling: 'WIL',
                properties: ['magic'],
                range: 'Ranged',
            };
            const loadout = assignCombatLoadout('elite', 'caster', [], [existingSkill]);
            expect(loadout.knownSkills).toContain('skill_fb');
        });

        it('minion weapon dice budget <= elite weapon dice budget', () => {
            const minion = assignCombatLoadout('minion', 'skirmisher', [], []);
            const elite = assignCombatLoadout('elite', 'skirmisher', [], []);

            const minionWeapon = minion.newItemDefs!.find(i => i.id === minion.equippedWeapon);
            const eliteWeapon = elite.newItemDefs!.find(i => i.id === elite.equippedWeapon);

            expect(minionWeapon!.damageDice).toBeLessThanOrEqual(eliteWeapon!.damageDice);
        });

        it('adds optional overrides for appropriate archetypes', () => {
            const loadout = assignCombatLoadout('elite', 'bulwark', [], []);
            expect(loadout.overrides).toBeDefined();
            expect(loadout.overrides!.length).toBeGreaterThanOrEqual(1);
        });
    });
});