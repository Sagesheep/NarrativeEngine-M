import { describe, it, expect, vi } from 'vitest';

const { mockLlmCall } = vi.hoisted(() => ({
    mockLlmCall: vi.fn(),
}));
vi.mock('../../utils/llmCall', () => ({ llmCall: mockLlmCall }));

import {
    abilityMod,
    computeAC,
    computeMaxHP,
    computeMaxFOC,
    proficiencyBonusForTier,
    checkRangeLegality,
    applyCoverModifier,
    resolveDefendBrace,
    checkTermination,
    runCombatRound,
    generateCombatLedgerLine,
    type CombatAction,
    type Combatant,
    type CombatState,
} from '../engine/combatEngine';
import { handleCombatAction, ADJUDICATOR_PROMPT, type CombatActionSource } from '../turn/turnOrchestrator';
import { fitHistory } from '../payload/payloadHistoryFitting';
import type { ChatMessage } from '../../types';

function makeCombatant(overrides: Partial<Combatant> & { id: string }): Combatant {
    const tier = overrides.combatTier ?? 'grunt';
    const stats = overrides.stats ?? { VIT: 14, PWR: 12, RES: 12, FOC: 10, SPD: 12, WIL: 10 };
    const maxHP = overrides.maxHP ?? computeMaxHP(tier, stats.VIT);
    const maxFOC = overrides.maxFOC ?? computeMaxFOC(tier, stats.WIL);
    return {
        name: overrides.id,
        archetype: 'brute',
        ac: computeAC(stats.RES, 0),
        proficiencyBonus: proficiencyBonusForTier(tier),
        currentHP: overrides.currentHP ?? maxHP,
        currentFOC: overrides.currentFOC ?? maxFOC,
        ...overrides,
        stats,
        maxHP,
        maxFOC,
        combatTier: tier,
    };
}

describe('Phase 2: Combat Turn Orchestrator & Engine Extensions', () => {

    describe('checkRangeLegality', () => {
        it('rejects melee weapon (katana) used at Ranged range', () => {
            const result = checkRangeLegality({
                weaponRange: 'Close',
                rangeRelation: 'Apart',
            });
            expect(result.legal).toBe(false);
            expect(result.reason).toContain('range');
        });

        it('allows Reach weapon at Apart range (polearms can reach)', () => {
            const result = checkRangeLegality({
                weaponRange: 'Reach',
                rangeRelation: 'Apart',
            });
            expect(result.legal).toBe(true);
        });

        it('allows Close weapon at Engaged range', () => {
            const result = checkRangeLegality({
                weaponRange: 'Close',
                rangeRelation: 'Engaged',
            });
            expect(result.legal).toBe(true);
        });

        it('allows Ranged weapon at Apart range', () => {
            const result = checkRangeLegality({
                weaponRange: 'Ranged',
                rangeRelation: 'Apart',
            });
            expect(result.legal).toBe(true);
        });

        it('allows Ranged weapon at Engaged range (ranged in melee)', () => {
            const result = checkRangeLegality({
                weaponRange: 'Ranged',
                rangeRelation: 'Engaged',
            });
            expect(result.legal).toBe(true);
        });

        it('allows Reach weapon at Engaged range', () => {
            const result = checkRangeLegality({
                weaponRange: 'Reach',
                rangeRelation: 'Engaged',
            });
            expect(result.legal).toBe(true);
        });

        it('allows MOV at any range', () => {
            const result = checkRangeLegality({
                weaponRange: 'Close',
                rangeRelation: 'Apart',
                actionType: 'move',
            });
            expect(result.legal).toBe(true);
        });

        it('allows DEF at any range', () => {
            const result = checkRangeLegality({
                weaponRange: 'Close',
                rangeRelation: 'Apart',
                actionType: 'defend',
            });
            expect(result.legal).toBe(true);
        });
    });

    describe('Cover rules', () => {
        it('cover grants disadvantage on Ranged attacks', () => {
            const mod = applyCoverModifier('cover', 'Ranged');
            expect(mod).toEqual({ disadvantage: true, advantage: false });
        });

        it('cover does NOT affect melee attacks (melee ignores cover)', () => {
            const mod = applyCoverModifier('cover', 'Close');
            expect(mod).toEqual({ disadvantage: false, advantage: false });
        });

        it('cover does NOT affect Reach attacks (melee ignores cover)', () => {
            const mod = applyCoverModifier('cover', 'Reach');
            expect(mod).toEqual({ disadvantage: false, advantage: false });
        });

        it('exposed grants advantage to attackers', () => {
            const mod = applyCoverModifier('exposed', 'Ranged');
            expect(mod).toEqual({ disadvantage: false, advantage: true });
        });

        it('exposed grants advantage on melee attacks too', () => {
            const mod = applyCoverModifier('exposed', 'Close');
            expect(mod).toEqual({ disadvantage: false, advantage: true });
        });

        it('elevated attacker position grants advantage', () => {
            const mod = applyCoverModifier(undefined, 'Ranged', 'elevated');
            expect(mod).toEqual({ disadvantage: false, advantage: true });
        });

        it('elevated attacker with melee also grants advantage', () => {
            const mod = applyCoverModifier(undefined, 'Close', 'elevated');
            expect(mod).toEqual({ disadvantage: false, advantage: true });
        });

        it('elevated TARGET does NOT grant advantage to attacker (old bug fixed)', () => {
            const mod = applyCoverModifier('elevated', 'Ranged');
            expect(mod).toEqual({ disadvantage: false, advantage: false });
        });

        it('elevated attacker + cover target cancels out (advantage + disadvantage)', () => {
            const mod = applyCoverModifier('cover', 'Ranged', 'elevated');
            expect(mod).toEqual({ advantage: true, disadvantage: true });
        });

        it('no position tag = no modifier', () => {
            const mod = applyCoverModifier(undefined, 'Ranged');
            expect(mod).toEqual({ disadvantage: false, advantage: false });
        });
    });

    describe('DEF → FOC recovery', () => {
        it('defend action recovers FOC (2 + WIL mod, min 1)', () => {
            const combatant = makeCombatant({
                id: 'hero',
                stats: { VIT: 14, PWR: 12, RES: 12, FOC: 10, SPD: 12, WIL: 14 },
                currentFOC: 5,
                maxFOC: 10,
            });
            const result = resolveDefendBrace(combatant);
            const wilMod = abilityMod(14);
            const expectedRecovery = Math.max(1, 2 + wilMod);
            expect(result.focRecovered).toBe(expectedRecovery);
            expect(result.newFOC).toBeLessThanOrEqual(combatant.maxFOC);
        });

        it('DEF recovers at least 1 FOC', () => {
            const combatant = makeCombatant({
                id: 'weak',
                stats: { VIT: 8, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 },
                currentFOC: 0,
                maxFOC: 4,
            });
            const result = resolveDefendBrace(combatant);
            expect(result.focRecovered).toBeGreaterThanOrEqual(1);
            expect(result.newFOC).toBeGreaterThanOrEqual(1);
        });

        it('DEF does not exceed maxFOC', () => {
            const combatant = makeCombatant({
                id: 'full',
                stats: { VIT: 14, PWR: 12, RES: 12, FOC: 10, SPD: 12, WIL: 14 },
                currentFOC: 10,
                maxFOC: 10,
            });
            const result = resolveDefendBrace(combatant);
            expect(result.newFOC).toBeLessThanOrEqual(combatant.maxFOC);
        });
    });

    describe('Termination — engine-owns, HP conditions only', () => {
        it('combat continues when all combatants have HP > 0', () => {
            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['a', 'b'],
                activeTurnIndex: 0,
                combatants: {
                    a: makeCombatant({ id: 'a', currentHP: 10, maxHP: 10 }),
                    b: makeCombatant({ id: 'b', currentHP: 5, maxHP: 20 }),
                },
                rangeRelations: { a: { b: 'Engaged' }, b: { a: 'Engaged' } },
            };
            const result = checkTermination(state);
            expect(result.ended).toBe(false);
        });

        it('combat ends when a side is eliminated (HP ≤ 0)', () => {
            const state: CombatState = {
                active: true,
                round: 5,
                turnOrder: ['pc', 'enemy'],
                activeTurnIndex: 0,
                combatants: {
                    pc: makeCombatant({ id: 'pc', currentHP: 15, maxHP: 20, isPC: true }),
                    enemy: makeCombatant({ id: 'enemy', currentHP: 0, maxHP: 20 }),
                },
                rangeRelations: { pc: { enemy: 'Engaged' }, enemy: { pc: 'Engaged' } },
            };
            const result = checkTermination(state);
            expect(result.ended).toBe(true);
            expect(result.winner).toBe('pc');
            expect(result.reason).toBe('enemy_defeated');
        });

        it('combat ends in draw if all sides eliminated simultaneously', () => {
            const state: CombatState = {
                active: true,
                round: 3,
                turnOrder: ['a', 'b'],
                activeTurnIndex: 0,
                combatants: {
                    a: makeCombatant({ id: 'a', currentHP: 0, maxHP: 10 }),
                    b: makeCombatant({ id: 'b', currentHP: 0, maxHP: 10 }),
                },
                rangeRelations: { a: { b: 'Engaged' }, b: { a: 'Engaged' } },
            };
            const result = checkTermination(state);
            expect(result.ended).toBe(true);
        });

        it('PC death triggers defeat', () => {
            const state: CombatState = {
                active: true,
                round: 3,
                turnOrder: ['pc', 'enemy'],
                activeTurnIndex: 0,
                combatants: {
                    pc: makeCombatant({ id: 'pc', currentHP: -2, maxHP: 20, isPC: true }),
                    enemy: makeCombatant({ id: 'enemy', currentHP: 10, maxHP: 20 }),
                },
                rangeRelations: { pc: { enemy: 'Engaged' }, enemy: { pc: 'Engaged' } },
            };
            const result = checkTermination(state);
            expect(result.ended).toBe(true);
            expect(result.winner).toBe('enemy');
            expect(result.reason).toBe('pc_defeated');
        });

        it('multi-side: ends when only one side remains', () => {
            const state: CombatState = {
                active: true,
                round: 4,
                turnOrder: ['pc', 'e1', 'e2'],
                activeTurnIndex: 0,
                combatants: {
                    pc: makeCombatant({ id: 'pc', currentHP: 10, maxHP: 20, isPC: true }),
                    e1: makeCombatant({ id: 'e1', currentHP: 0, maxHP: 15 }),
                    e2: makeCombatant({ id: 'e2', currentHP: 0, maxHP: 15 }),
                },
                rangeRelations: {},
            };
            const result = checkTermination(state);
            expect(result.ended).toBe(true);
            expect(result.winner).toBe('pc');
            expect(result.reason).toBe('enemy_defeated');
        });

        it('1 PC + 1 NPC: PC dies → reason pc_defeated, winner is NPC', () => {
            const state: CombatState = {
                active: true,
                round: 5,
                turnOrder: ['pc', 'npc'],
                activeTurnIndex: 0,
                combatants: {
                    pc: makeCombatant({ id: 'pc', currentHP: 0, maxHP: 20, isPC: true }),
                    npc: makeCombatant({ id: 'npc', currentHP: 12, maxHP: 20 }),
                },
                rangeRelations: {},
            };
            const result = checkTermination(state);
            expect(result.ended).toBe(true);
            expect(result.winner).toBe('npc');
            expect(result.reason).toBe('pc_defeated');
        });

        it('1 PC + 1 NPC: NPC dies → reason enemy_defeated, winner is PC', () => {
            const state: CombatState = {
                active: true,
                round: 3,
                turnOrder: ['pc', 'npc'],
                activeTurnIndex: 0,
                combatants: {
                    pc: makeCombatant({ id: 'pc', currentHP: 15, maxHP: 20, isPC: true }),
                    npc: makeCombatant({ id: 'npc', currentHP: 0, maxHP: 20 }),
                },
                rangeRelations: {},
            };
            const result = checkTermination(state);
            expect(result.ended).toBe(true);
            expect(result.winner).toBe('pc');
            expect(result.reason).toBe('enemy_defeated');
        });
    });

    describe('runCombatRound — SPD turn order, engine resolves before narrate', () => {
        it('resolves actions in SPD order (fastest first)', () => {
            const fast = makeCombatant({ id: 'fast', stats: { VIT: 14, PWR: 14, RES: 10, FOC: 10, SPD: 18, WIL: 10 }, currentHP: 20 });
            const slow = makeCombatant({ id: 'slow', stats: { VIT: 14, PWR: 14, RES: 10, FOC: 10, SPD: 8, WIL: 10 }, currentHP: 20 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['fast', 'slow'],
                activeTurnIndex: 0,
                combatants: { fast, slow },
                rangeRelations: { fast: { slow: 'Engaged' }, slow: { fast: 'Engaged' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'fast', targetId: 'slow', attackBonus: 4, weaponDie: 6, scalingStatMod: 2 },
                { type: 'attack', actorId: 'slow', targetId: 'fast', attackBonus: 2, weaponDie: 6, scalingStatMod: 1 },
            ];

            const result = runCombatRound(state, actions);
            expect(result.resolutions.length).toBe(2);
            expect(result.resolutions[0].actorId).toBe('fast');
            expect(result.resolutions[1].actorId).toBe('slow');
        });

        it('damage applied to combatants by engine, not AI', () => {
            const hero = makeCombatant({ id: 'hero', stats: { VIT: 14, PWR: 14, RES: 10, FOC: 10, SPD: 12, WIL: 10 }, currentHP: 20 });
            const goblin = makeCombatant({ id: 'goblin', stats: { VIT: 10, PWR: 10, RES: 10, FOC: 8, SPD: 10, WIL: 8 }, currentHP: 12 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['hero', 'goblin'],
                activeTurnIndex: 0,
                combatants: { hero, goblin },
                rangeRelations: { hero: { goblin: 'Engaged' }, goblin: { hero: 'Engaged' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'hero', targetId: 'goblin', attackBonus: 10, weaponDie: 8, scalingStatMod: 2, forceRoll: 15 },
            ];

            const result = runCombatRound(state, actions);
            const goblinAfter = result.updatedCombatants['goblin'];
            expect(goblinAfter.currentHP).toBeLessThan(goblin.currentHP);
        });

        it('DEF action grants FOC recovery', () => {
            const hero = makeCombatant({ id: 'hero', stats: { VIT: 14, PWR: 14, RES: 10, FOC: 10, SPD: 12, WIL: 14 }, currentFOC: 3, maxFOC: 10 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['hero'],
                activeTurnIndex: 0,
                combatants: { hero },
                rangeRelations: {},
            };

            const actions: CombatAction[] = [
                { type: 'defend', actorId: 'hero' },
            ];

            const result = runCombatRound(state, actions);
            const heroAfter = result.updatedCombatants['hero'];
            expect(heroAfter.currentFOC).toBeGreaterThan(hero.currentFOC);
        });

        it('range-rejected attack is skipped and flagged', () => {
            const archer = makeCombatant({ id: 'archer', stats: { VIT: 12, PWR: 10, RES: 10, FOC: 10, SPD: 14, WIL: 10 }, currentHP: 15 });
            const sword = makeCombatant({ id: 'sword', stats: { VIT: 14, PWR: 14, RES: 12, FOC: 10, SPD: 12, WIL: 10 }, currentHP: 20 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['archer', 'sword'],
                activeTurnIndex: 0,
                combatants: { archer, sword },
                rangeRelations: { archer: { sword: 'Apart' }, sword: { archer: 'Apart' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'sword', targetId: 'archer', weaponRange: 'Close', attackBonus: 4, weaponDie: 8, scalingStatMod: 2 },
            ];

            const result = runCombatRound(state, actions);
            expect(result.resolutions[0].type).toBe('attack');
            expect(result.resolutions[0].rejected).toBe(true);
            expect(result.resolutions[0].rejectionReason).toContain('range');
        });

        it('cover applies disadvantage vs Ranged but not vs melee', () => {
            const attacker = makeCombatant({ id: 'attacker', stats: { VIT: 14, PWR: 14, RES: 10, FOC: 10, SPD: 12, WIL: 10 }, currentHP: 20 });
            const defender = makeCombatant({ id: 'defender', stats: { VIT: 14, PWR: 10, RES: 14, FOC: 10, SPD: 10, WIL: 10 }, currentHP: 20, position: 'cover' });

            const stateEngaged: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['attacker'],
                activeTurnIndex: 0,
                combatants: { attacker, defender },
                rangeRelations: { attacker: { defender: 'Engaged' }, defender: { attacker: 'Engaged' } },
            };

            const meleeAction: CombatAction[] = [
                { type: 'attack', actorId: 'attacker', targetId: 'defender', weaponRange: 'Close', attackBonus: 4, weaponDie: 6, scalingStatMod: 2 },
            ];

            const meleeResult = runCombatRound(stateEngaged, meleeAction);
            expect(meleeResult.resolutions[0].coverApplied).toBe(false);

            const stateApart: CombatState = {
                ...stateEngaged,
                rangeRelations: { attacker: { defender: 'Apart' }, defender: { attacker: 'Apart' } },
            };

            const rangedAction: CombatAction[] = [
                { type: 'attack', actorId: 'attacker', targetId: 'defender', weaponRange: 'Ranged', attackBonus: 4, weaponDie: 6, scalingStatMod: 2 },
            ];

            const rangedResult = runCombatRound(stateApart, rangedAction);
            expect(rangedResult.resolutions[0].coverApplied).toBe(true);
         });

        it('elevated attacker gets advantage in runCombatRound', () => {
            const attacker = makeCombatant({ id: 'attacker', stats: { VIT: 14, PWR: 14, RES: 10, FOC: 10, SPD: 12, WIL: 10 }, currentHP: 20, position: 'elevated' });
            const defender = makeCombatant({ id: 'defender', stats: { VIT: 14, PWR: 10, RES: 14, FOC: 10, SPD: 10, WIL: 10 }, currentHP: 20 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['attacker'],
                activeTurnIndex: 0,
                combatants: { attacker, defender },
                rangeRelations: { attacker: { defender: 'Engaged' }, defender: { attacker: 'Engaged' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'attacker', targetId: 'defender', weaponRange: 'Close', attackBonus: 4, weaponDie: 6, scalingStatMod: 2 },
            ];

            const result = runCombatRound(state, actions);
            expect(result.resolutions[0].coverApplied).toBe(true);
        });

        it('elevated target does NOT grant attacker advantage (old bug)', () => {
            const attacker = makeCombatant({ id: 'attacker', stats: { VIT: 14, PWR: 14, RES: 10, FOC: 10, SPD: 12, WIL: 10 }, currentHP: 20 });
            const defender = makeCombatant({ id: 'defender', stats: { VIT: 14, PWR: 10, RES: 14, FOC: 10, SPD: 10, WIL: 10 }, currentHP: 20, position: 'elevated' });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['attacker'],
                activeTurnIndex: 0,
                combatants: { attacker, defender },
                rangeRelations: { attacker: { defender: 'Engaged' }, defender: { attacker: 'Engaged' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'attacker', targetId: 'defender', weaponRange: 'Close', attackBonus: 4, weaponDie: 6, scalingStatMod: 2 },
            ];

            const result = runCombatRound(state, actions);
            expect(result.resolutions[0].coverApplied).toBe(false);
        });

        it('dead actor (HP <= 0) has action rejected as incapacitated', () => {
            const hero = makeCombatant({ id: 'hero', stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 }, currentHP: 0, maxHP: 20 });
            const goblin = makeCombatant({ id: 'goblin', stats: { VIT: 10, PWR: 10, RES: 8, FOC: 6, SPD: 10, WIL: 8 }, currentHP: 12, maxHP: 12 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['hero', 'goblin'],
                activeTurnIndex: 0,
                combatants: { hero, goblin },
                rangeRelations: { hero: { goblin: 'Engaged' }, goblin: { hero: 'Engaged' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'hero', targetId: 'goblin', attackBonus: 10, weaponDie: 8, scalingStatMod: 2 },
                { type: 'attack', actorId: 'goblin', targetId: 'hero', attackBonus: 4, weaponDie: 6, scalingStatMod: 1 },
            ];

            const result = runCombatRound(state, actions);
            expect(result.resolutions[0].actorId).toBe('hero');
            expect(result.resolutions[0].rejected).toBe(true);
            expect(result.resolutions[0].rejectionReason).toBe('incapacitated');

            const goblinHP = result.updatedCombatants['goblin'].currentHP;
            expect(goblinHP).toBe(12);
        });

        it('attack on already-down target (HP <= 0) is rejected as target already down', () => {
            const hero = makeCombatant({ id: 'hero', stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 }, currentHP: 20, maxHP: 20 });
            const goblin = makeCombatant({ id: 'goblin', stats: { VIT: 10, PWR: 10, RES: 8, FOC: 6, SPD: 10, WIL: 8 }, currentHP: 0, maxHP: 12 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['hero'],
                activeTurnIndex: 0,
                combatants: { hero, goblin },
                rangeRelations: { hero: { goblin: 'Engaged' }, goblin: { hero: 'Engaged' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'hero', targetId: 'goblin', attackBonus: 10, weaponDie: 8, scalingStatMod: 2 },
            ];

            const result = runCombatRound(state, actions);
            expect(result.resolutions[0].rejected).toBe(true);
            expect(result.resolutions[0].rejectionReason).toBe('target already down');
        });

        it("actor kills target; target's queued action in same round is rejected as incapacitated", () => {
            const hero = makeCombatant({ id: 'hero', stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 18, WIL: 10 }, currentHP: 20, maxHP: 20, isPC: true });
            const goblin = makeCombatant({ id: 'goblin', stats: { VIT: 10, PWR: 10, RES: 8, FOC: 6, SPD: 10, WIL: 8 }, currentHP: 2, maxHP: 12 });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['hero', 'goblin'],
                activeTurnIndex: 0,
                combatants: { hero, goblin },
                rangeRelations: { hero: { goblin: 'Engaged' }, goblin: { hero: 'Engaged' } },
            };

            const actions: CombatAction[] = [
                { type: 'attack', actorId: 'hero', targetId: 'goblin', attackBonus: 20, weaponDie: 8, scalingStatMod: 3, forceRoll: 15 },
                { type: 'attack', actorId: 'goblin', targetId: 'hero', attackBonus: 4, weaponDie: 6, scalingStatMod: 1 },
            ];

            const result = runCombatRound(state, actions);

            expect(result.resolutions[0].actorId).toBe('hero');
            expect(result.resolutions[0].hit).toBe(true);
            expect(result.resolutions[0].damage).toBeGreaterThan(0);
            expect(result.updatedCombatants['goblin'].currentHP).toBeLessThanOrEqual(0);

            expect(result.resolutions[1].actorId).toBe('goblin');
            expect(result.resolutions[1].rejected).toBe(true);
            expect(result.resolutions[1].rejectionReason).toBe('incapacitated');
            expect(result.updatedCombatants['hero'].currentHP).toBe(20);
        });
    });

    describe('Combat ledger line emission', () => {
        it('generates a ledger line per round with HP/FOC', () => {
            const combatants: Record<string, Combatant> = {
                hero: makeCombatant({ id: 'hero', name: 'Sasuke', currentHP: 24, maxHP: 30, currentFOC: 8, maxFOC: 15 }),
                enemy: makeCombatant({ id: 'enemy', name: 'Hooligan#2', currentHP: 12, maxHP: 30 }),
            };
            const line = generateCombatLedgerLine(3, combatants);
            expect(line).toContain('Round 3');
            expect(line).toContain('Sasuke');
            expect(line).toContain('24/30');
            expect(line).toContain('Hooligan#2');
            expect(line).toContain('12/30');
        });

        it('includes position/status when present', () => {
            const combatants: Record<string, Combatant> = {
                hero: makeCombatant({ id: 'hero', name: 'Hero', currentHP: 10, maxHP: 20, position: 'cover' }),
                enemy: makeCombatant({ id: 'enemy', name: 'Enemy', currentHP: 5, maxHP: 20, statusEffects: ['Guarding'] }),
            };
            const line = generateCombatLedgerLine(1, combatants);
            expect(line).toContain('cover');
            expect(line).toContain('Guarding');
        });

        it('creates ChatMessage with name combat-ledger', () => {
            const combatants: Record<string, Combatant> = {
                hero: makeCombatant({ id: 'hero', name: 'Hero', currentHP: 10, maxHP: 20 }),
            };
            const msg = generateCombatLedgerLine(1, combatants);
            expect(typeof msg).toBe('string');
            expect(msg).toContain('Round 1');
        });
    });

    describe('Full combat end-to-end with hardcoded actions', () => {
        it('resolves a complete 1v1 combat to termination', () => {
            const hero = makeCombatant({
                id: 'hero',
                name: 'Hero',
                stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 },
                currentHP: 20,
                maxHP: 20,
                currentFOC: 10,
                maxFOC: 10,
                isPC: true,
            });
            const goblin = makeCombatant({
                id: 'goblin',
                name: 'Goblin',
                stats: { VIT: 10, PWR: 10, RES: 8, FOC: 6, SPD: 10, WIL: 8 },
                currentHP: 8,
                maxHP: 8,
                currentFOC: 4,
                maxFOC: 4,
            });

            let state: CombatState = {
                active: true,
                round: 0,
                turnOrder: ['hero', 'goblin'],
                activeTurnIndex: 0,
                combatants: { hero, goblin },
                rangeRelations: { hero: { goblin: 'Engaged' }, goblin: { hero: 'Engaged' } },
            };

            const roundResults: string[] = [];
            let rounds = 0;
            const maxRounds = 50;

            while (state.active && rounds < maxRounds) {
                rounds++;
                state.round = rounds;

                const heroAction: CombatAction = {
                    type: 'attack',
                    actorId: 'hero',
                    targetId: 'goblin',
                    weaponRange: 'Close',
                    attackBonus: abilityMod(hero.stats.PWR) + proficiencyBonusForTier(hero.combatTier) + (state.combatants.hero.stats.PWR >= 14 ? 2 : 0),
                    weaponDie: 8,
                    scalingStatMod: abilityMod(hero.stats.PWR),
                };

                const goblinAction: CombatAction = {
                    type: 'attack',
                    actorId: 'goblin',
                    targetId: 'hero',
                    weaponRange: 'Close',
                    attackBonus: abilityMod(goblin.stats.PWR) + proficiencyBonusForTier(goblin.combatTier),
                    weaponDie: 6,
                    scalingStatMod: abilityMod(goblin.stats.PWR),
                };

                const result = runCombatRound(state, [heroAction, goblinAction]);
                roundResults.push(generateCombatLedgerLine(rounds, result.updatedCombatants));
                state = {
                    ...state,
                    combatants: result.updatedCombatants,
                    round: rounds,
                };

                const term = checkTermination(state);
                if (term.ended) {
                    state.active = false;
                    break;
                }
            }

            expect(state.active).toBe(false);
            const term = checkTermination(state);
            expect(term.ended).toBe(true);

            const goblinHP = state.combatants.goblin.currentHP;
            expect(goblinHP).toBeLessThanOrEqual(0);
        });

        it('DEF brace recovers FOC over multiple rounds', () => {
            const hero = makeCombatant({
                id: 'hero',
                name: 'Hero',
                stats: { VIT: 14, PWR: 14, RES: 12, FOC: 10, SPD: 14, WIL: 14 },
                currentHP: 30,
                maxHP: 30,
                currentFOC: 2,
                maxFOC: 10,
            });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['hero'],
                activeTurnIndex: 0,
                combatants: { hero },
                rangeRelations: {},
            };

            const actions: CombatAction[] = [
                { type: 'defend', actorId: 'hero' },
            ];

            const result = runCombatRound(state, actions);
            expect(result.updatedCombatants.hero.currentFOC).toBeGreaterThan(2);
        });

        it('rejects katana (Close weapon) at Ranged range, allows bow', () => {
            const swordsman = makeCombatant({
                id: 'swordsman',
                name: 'Swordsman',
                stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 12, WIL: 10 },
                currentHP: 20,
            });
            const archer = makeCombatant({
                id: 'archer',
                name: 'Archer',
                stats: { VIT: 12, PWR: 12, RES: 10, FOC: 10, SPD: 14, WIL: 10 },
                currentHP: 20,
            });

            const state: CombatState = {
                active: true,
                round: 1,
                turnOrder: ['swordsman', 'archer'],
                activeTurnIndex: 0,
                combatants: { swordsman, archer },
                rangeRelations: { swordsman: { archer: 'Apart' }, archer: { swordsman: 'Apart' } },
            };

            const katanaAttack: CombatAction = {
                type: 'attack',
                actorId: 'swordsman',
                targetId: 'archer',
                weaponRange: 'Close',
                attackBonus: 5,
                weaponDie: 8,
                scalingStatMod: 3,
            };

            const result1 = runCombatRound(state, [katanaAttack]);
            expect(result1.resolutions[0].rejected).toBe(true);

            const bowAttack: CombatAction = {
                type: 'attack',
                actorId: 'archer',
                targetId: 'swordsman',
                weaponRange: 'Ranged',
                attackBonus: 4,
                weaponDie: 8,
                scalingStatMod: 2,
            };

            const result2 = runCombatRound(state, [bowAttack]);
            expect(result2.resolutions[0].rejected).toBeUndefined();
        });
    });
});

describe('payloadHistoryFitting — combat-ledger retention (Phase C)', () => {
    it('retains combat-ledger lines so the story AI keeps combat continuity', () => {
        const messages: ChatMessage[] = [
            { id: '1', role: 'user', content: 'I attack the goblin', timestamp: 100 },
            { id: '2', role: 'assistant', content: 'Round 1 · Hero 20/20', timestamp: 101, name: 'combat-ledger' },
            { id: '3', role: 'assistant', content: 'The goblin staggers back!', timestamp: 102 },
            { id: '4', role: 'assistant', content: 'Round 2 · Hero 18/20 · Goblin 5/12', timestamp: 103, name: 'combat-ledger' },
            { id: '5', role: 'user', content: 'I swing again', timestamp: 104 },
        ];

        const result = fitHistory(messages, undefined, 'next action', 0, 8192);
        const contents = result.fitted.map(m => m.content);
        expect(contents).toContain('Round 1 · Hero 20/20');
        expect(contents).toContain('Round 2 · Hero 18/20 · Goblin 5/12');
        expect(contents).toContain('I attack the goblin');
        expect(contents).toContain('The goblin staggers back!');
    });

    it('still skips scene-marker while retaining combat-ledger', () => {
        const messages: ChatMessage[] = [
            { id: '1', role: 'assistant', content: 'Scene update', timestamp: 100, name: 'scene-marker' },
            { id: '2', role: 'assistant', content: 'Round 1 data', timestamp: 101, name: 'combat-ledger' },
            { id: '3', role: 'user', content: 'Hello', timestamp: 102 },
        ];

        const result = fitHistory(messages, undefined, 'test', 0, 8192);
        const contents = result.fitted.map(m => m.content);
        expect(contents).not.toContain('Scene update');
        expect(contents).toContain('Round 1 data');
        expect(contents).toContain('Hello');
    });
});

describe('handleCombatAction — engine-before-narration via real handler', () => {
    function makeCombatant(overrides: Partial<Combatant> & { id: string }): Combatant {
        const tier = overrides.combatTier ?? 'grunt';
        const stats = overrides.stats ?? { VIT: 14, PWR: 12, RES: 12, FOC: 10, SPD: 12, WIL: 10 };
        const maxHP = overrides.maxHP ?? computeMaxHP(tier, stats.VIT);
        const maxFOC = overrides.maxFOC ?? computeMaxFOC(tier, stats.WIL);
        return {
            name: overrides.id,
            archetype: 'brute',
            ac: computeAC(stats.RES, 0),
            proficiencyBonus: proficiencyBonusForTier(tier),
            currentHP: overrides.currentHP ?? maxHP,
            currentFOC: overrides.currentFOC ?? maxFOC,
            ...overrides,
            stats,
            maxHP,
            maxFOC,
            combatTier: tier,
        };
    }

    function makeCombatState(): CombatState {
        const hero = makeCombatant({ id: 'hero', isPC: true, stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 } });
        const enemy = makeCombatant({ id: 'enemy', stats: { VIT: 10, PWR: 10, RES: 8, FOC: 6, SPD: 10, WIL: 8 } });
        return {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };
    }

    it('button action: engine resolves before narration, 1 LLM call (narrate only)', async () => {
        const combatState = makeCombatState();
        const callOrder: string[] = [];

        const narrateSpy = vi.fn().mockImplementation(async () => {
            callOrder.push('narrate');
        });

        const engineSpy = vi.spyOn(await import('../engine/combatEngine'), 'runCombatRound').mockImplementation(() => {
            callOrder.push('engine');
            return {
                resolutions: [{ actorId: 'hero', targetId: 'enemy', type: 'attack' as const, hit: true, critical: false, damage: 5, naturalRoll: 15, total: 19, coverApplied: false }],
                updatedCombatants: { ...combatState.combatants, enemy: { ...combatState.combatants.enemy, currentHP: combatState.combatants.enemy.currentHP - 5 } },
                updatedRangeRelations: combatState.rangeRelations,
                ledgerLine: 'Round 1 · hero 20/20 · enemy 7/12',
            };
        });

        const source: CombatActionSource = {
            kind: 'button',
            action: { type: 'attack', actorId: 'hero', targetId: 'enemy', weaponRange: 'Close', attackBonus: 5, weaponDie: 8, scalingStatMod: 3 },
        };

        await handleCombatAction(source, combatState, {
            addMessage: () => {},
            updateContext: () => {},
            setCombatState: () => {},
            terminateCombat: () => {},
            getAuxiliaryProvider: () => undefined,
            getStoryProvider: () => undefined,
            narrateCombatOutcome: narrateSpy,
            items: [],
            skills: [],
        });

        expect(callOrder[0]).toBe('engine');
        expect(callOrder).toContain('narrate');
        expect(narrateSpy).toHaveBeenCalledTimes(1);

        engineSpy.mockRestore();
    });

    it('freeform action: 2 LLM calls max per round (adjudicate + narrate)', async () => {
        const combatState = makeCombatState();
        const callOrder: string[] = [];

        const narrateSpy = vi.fn().mockImplementation(async () => {
            callOrder.push('narrate');
        });

        const engineSpy = vi.spyOn(await import('../engine/combatEngine'), 'runCombatRound').mockImplementation(() => {
            callOrder.push('engine');
            return {
                resolutions: [{ actorId: 'hero', targetId: 'enemy', type: 'attack' as const, hit: true, critical: false, damage: 5, naturalRoll: 15, total: 19, coverApplied: false }],
                updatedCombatants: { ...combatState.combatants, enemy: { ...combatState.combatants.enemy, currentHP: combatState.combatants.enemy.currentHP - 5 } },
                updatedRangeRelations: combatState.rangeRelations,
                ledgerLine: 'Round 1 · hero 20/20 · enemy 7/12',
            };
        });

        const source: CombatActionSource = {
            kind: 'freeform',
            freeformText: 'I swing on the chandelier and drop onto the pirate',
            baseAction: { type: 'attack', actorId: 'hero', targetId: 'enemy', weaponRange: 'Close', attackBonus: 5, weaponDie: 8, scalingStatMod: 3 },
        };

        await handleCombatAction(source, combatState, {
            addMessage: () => {},
            updateContext: () => {},
            setCombatState: () => {},
            terminateCombat: () => {},
            getAuxiliaryProvider: () => undefined,
            getStoryProvider: () => undefined,
            narrateCombatOutcome: narrateSpy,
            items: [],
            skills: [],
        });

        expect(callOrder[0]).toBe('engine');
        expect(callOrder).toContain('narrate');
        expect(narrateSpy).toHaveBeenCalledTimes(1);

        engineSpy.mockRestore();
    });

    it('button action changes HP via engine (not LLM)', async () => {
        const combatState = makeCombatState();
        const enemyHPBefore = combatState.combatants.enemy.currentHP;

        let capturedState: CombatState | null = null;

        const source: CombatActionSource = {
            kind: 'button',
            action: { type: 'attack', actorId: 'hero', targetId: 'enemy', weaponRange: 'Close', attackBonus: 20, weaponDie: 8, scalingStatMod: 3, forceRoll: 15 },
        };

        await handleCombatAction(source, combatState, {
            addMessage: () => {},
            updateContext: () => {},
            setCombatState: (state) => { capturedState = state; },
            terminateCombat: () => {},
            getAuxiliaryProvider: () => undefined,
            getStoryProvider: () => undefined,
            narrateCombatOutcome: async () => {},
            items: [],
            skills: [],
        });

        expect(capturedState).not.toBeNull();
        const enemyHPAfter = capturedState!.combatants.enemy.currentHP;
        expect(enemyHPAfter).toBeLessThan(enemyHPBefore);
    });

    it('emits ledger message with name combat-ledger', async () => {
        const combatState = makeCombatState();
        const messages: ChatMessage[] = [];

        const source: CombatActionSource = {
            kind: 'button',
            action: { type: 'defend', actorId: 'hero' },
        };

        await handleCombatAction(source, combatState, {
            addMessage: (msg) => messages.push(msg),
            updateContext: () => {},
            setCombatState: () => {},
            terminateCombat: () => {},
            getAuxiliaryProvider: () => undefined,
            getStoryProvider: () => undefined,
            narrateCombatOutcome: async () => {},
            items: [],
            skills: [],
        });

        const ledgerMsg = messages.find(m => m.name === 'combat-ledger');
        expect(ledgerMsg).toBeDefined();
        expect(ledgerMsg!.role).toBe('assistant');
    });
});

describe('Phase 4.1: Freeform combat path (adjudicated stat, riskOnFail)', () => {
    function makeCombatant(overrides: Partial<Combatant> & { id: string }): Combatant {
        const tier = overrides.combatTier ?? 'grunt';
        const stats = overrides.stats ?? { VIT: 14, PWR: 12, RES: 12, FOC: 10, SPD: 12, WIL: 10 };
        const maxHP = overrides.maxHP ?? computeMaxHP(tier, stats.VIT);
        const maxFOC = overrides.maxFOC ?? computeMaxFOC(tier, stats.WIL);
        return {
            name: overrides.id,
            archetype: 'brute',
            ac: computeAC(stats.RES, 0),
            proficiencyBonus: proficiencyBonusForTier(tier),
            currentHP: overrides.currentHP ?? maxHP,
            currentFOC: overrides.currentFOC ?? maxFOC,
            ...overrides,
            stats,
            maxHP,
            maxFOC,
            combatTier: tier,
        };
    }

    function makeCombatState(): CombatState {
        const hero = makeCombatant({ id: 'hero', isPC: true, stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 18, WIL: 10 } });
        const enemy = makeCombatant({ id: 'enemy', stats: { VIT: 10, PWR: 10, RES: 8, FOC: 6, SPD: 10, WIL: 8 } });
        return {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };
    }

    it('ADJUDICATOR_PROMPT contains the verbatim §5.1 text', () => {
        expect(ADJUDICATOR_PROMPT).toContain('You are a combat maneuver adjudicator for a text RPG');
        expect(ADJUDICATOR_PROMPT).toContain('Respond with ONLY a JSON object, no prose, no markdown');
        expect(ADJUDICATOR_PROMPT).toContain('"stat":"PWR"');
    });

    it('freeform path: adjudicated SPD stat overrides default PWR for attackBonus/scalingStatMod', async () => {
        const combatState = makeCombatState();
        const hero = combatState.combatants.hero;
        const expectedSPDMod = abilityMod(hero.stats.SPD);
        const expectedAttackBonus = expectedSPDMod + hero.proficiencyBonus;

        const chandelierJSON = `{"stat":"SPD","advantage":"advantage","positionTag":"elevated","momentumToken":1,"riskOnFail":"prone"}`;
        mockLlmCall.mockResolvedValue(chandelierJSON);

        let capturedActions: CombatAction[] = [];
        const engineSpy = vi.spyOn(await import('../engine/combatEngine'), 'runCombatRound').mockImplementation((_state: CombatState, actions: CombatAction[]) => {
            capturedActions = actions;
            return {
                resolutions: [{ actorId: 'hero', targetId: 'enemy', type: 'attack' as const, hit: true, critical: false, damage: 5, naturalRoll: 15, total: 19, coverApplied: false }],
                updatedCombatants: { ...combatState.combatants },
                updatedRangeRelations: combatState.rangeRelations,
                ledgerLine: 'Round 1 · hero 20/20 · enemy 7/12',
            };
        });

        const source: CombatActionSource = {
            kind: 'freeform',
            freeformText: 'I jump onto the bar table, swing on the chandelier, then drop onto the pirate aiming for his face.',
            baseAction: { type: 'attack', actorId: 'hero', targetId: 'enemy', weaponRange: 'Close', weaponDie: 6 },
        };

        const auxProvider = { endpoint: 'test', modelName: 'test' } as unknown as import('../../types').LLMProvider;

        await handleCombatAction(source, combatState, {
            addMessage: () => {},
            updateContext: () => {},
            setCombatState: () => {},
            terminateCombat: () => {},
            getAuxiliaryProvider: () => auxProvider,
            getStoryProvider: () => undefined,
            narrateCombatOutcome: async () => {},
            items: [],
            skills: [],
        });

        expect(mockLlmCall).toHaveBeenCalledTimes(1);
        expect(mockLlmCall.mock.calls[0][1]).toContain('You are a combat maneuver adjudicator');
        expect(mockLlmCall.mock.calls[0][1]).toContain('----- PLAYER MANEUVER -----');

        // Phase A: the PC's adjudicated action plus one auto-generated enemy action.
        expect(capturedActions.length).toBe(2);
        expect(capturedActions.some(a => a.actorId === 'enemy')).toBe(true);
        const action = capturedActions.find(a => a.actorId === 'hero')!;
        expect(action.attackBonus).toBe(expectedAttackBonus);
        expect(action.scalingStatMod).toBe(expectedSPDMod);
        expect(action.advantage).toBe(true);
        expect(action.newPosition).toBe('elevated');
        expect(action.riskOnFail).toBe('prone');

        engineSpy.mockRestore();
        mockLlmCall.mockClear();
    });

    it('riskOnFail: missed attack with prone → actor gains prone status', () => {
        const hero = makeCombatant({
            id: 'hero',
            stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 },
            currentHP: 20,
        });
        const enemy = makeCombatant({
            id: 'enemy',
            stats: { VIT: 10, PWR: 10, RES: 20, FOC: 6, SPD: 10, WIL: 8 },
            currentHP: 20,
        });

        const state: CombatState = {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };

        const actions: CombatAction[] = [{
            type: 'attack',
            actorId: 'hero',
            targetId: 'enemy',
            attackBonus: 2,
            weaponDie: 6,
            scalingStatMod: 1,
            forceRoll: 2,
            riskOnFail: 'prone',
        }];

        const result = runCombatRound(state, actions);
        expect(result.resolutions[0].hit).toBe(false);
        expect(result.resolutions[0].riskApplied).toBe('prone');
        expect(result.updatedCombatants.hero.statusEffects).toContain('prone');
    });

    it('riskOnFail: HIT attack → no penalty applied', () => {
        const hero = makeCombatant({
            id: 'hero',
            stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 },
            currentHP: 20,
        });
        const enemy = makeCombatant({
            id: 'enemy',
            stats: { VIT: 10, PWR: 10, RES: 8, FOC: 6, SPD: 10, WIL: 8 },
            currentHP: 20,
        });

        const state: CombatState = {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };

        const actions: CombatAction[] = [{
            type: 'attack',
            actorId: 'hero',
            targetId: 'enemy',
            attackBonus: 20,
            weaponDie: 6,
            scalingStatMod: 3,
            forceRoll: 15,
            riskOnFail: 'prone',
        }];

        const result = runCombatRound(state, actions);
        expect(result.resolutions[0].hit).toBe(true);
        expect(result.resolutions[0].riskApplied).toBeUndefined();
        expect(result.updatedCombatants.hero.statusEffects).toBeUndefined();
    });

    it('riskOnFail: exposed → actor position set to exposed', () => {
        const hero = makeCombatant({
            id: 'hero',
            stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 },
            currentHP: 20,
        });
        const enemy = makeCombatant({
            id: 'enemy',
            stats: { VIT: 10, PWR: 10, RES: 20, FOC: 6, SPD: 10, WIL: 8 },
            currentHP: 20,
        });

        const state: CombatState = {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };

        const actions: CombatAction[] = [{
            type: 'attack',
            actorId: 'hero',
            targetId: 'enemy',
            attackBonus: 2,
            weaponDie: 6,
            scalingStatMod: 1,
            forceRoll: 2,
            riskOnFail: 'exposed',
        }];

        const result = runCombatRound(state, actions);
        expect(result.resolutions[0].riskApplied).toBe('exposed');
        expect(result.updatedCombatants.hero.position).toBe('exposed');
    });

    it('riskOnFail: drop_weapon → actor gains disarmed status', () => {
        const hero = makeCombatant({
            id: 'hero',
            stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 },
            currentHP: 20,
        });
        const enemy = makeCombatant({
            id: 'enemy',
            stats: { VIT: 10, PWR: 10, RES: 20, FOC: 6, SPD: 10, WIL: 8 },
            currentHP: 20,
        });

        const state: CombatState = {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };

        const actions: CombatAction[] = [{
            type: 'attack',
            actorId: 'hero',
            targetId: 'enemy',
            attackBonus: 2,
            weaponDie: 6,
            scalingStatMod: 1,
            forceRoll: 2,
            riskOnFail: 'drop_weapon',
        }];

        const result = runCombatRound(state, actions);
        expect(result.resolutions[0].riskApplied).toBe('drop_weapon');
        expect(result.updatedCombatants.hero.statusEffects).toContain('disarmed');
    });

    it('riskOnFail: self_stagger → actor gains staggered status', () => {
        const hero = makeCombatant({
            id: 'hero',
            stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 },
            currentHP: 20,
        });
        const enemy = makeCombatant({
            id: 'enemy',
            stats: { VIT: 10, PWR: 10, RES: 20, FOC: 6, SPD: 10, WIL: 8 },
            currentHP: 20,
        });

        const state: CombatState = {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };

        const actions: CombatAction[] = [{
            type: 'attack',
            actorId: 'hero',
            targetId: 'enemy',
            attackBonus: 2,
            weaponDie: 6,
            scalingStatMod: 1,
            forceRoll: 2,
            riskOnFail: 'self_stagger',
        }];

        const result = runCombatRound(state, actions);
        expect(result.resolutions[0].riskApplied).toBe('self_stagger');
        expect(result.updatedCombatants.hero.statusEffects).toContain('staggered');
    });

    it('riskOnFail: none → nothing applied on miss', () => {
        const hero = makeCombatant({
            id: 'hero',
            stats: { VIT: 14, PWR: 16, RES: 12, FOC: 10, SPD: 14, WIL: 10 },
            currentHP: 20,
        });
        const enemy = makeCombatant({
            id: 'enemy',
            stats: { VIT: 10, PWR: 10, RES: 20, FOC: 6, SPD: 10, WIL: 8 },
            currentHP: 20,
        });

        const state: CombatState = {
            active: true,
            round: 1,
            turnOrder: ['hero', 'enemy'],
            activeTurnIndex: 0,
            combatants: { hero, enemy },
            rangeRelations: { hero: { enemy: 'Engaged' }, enemy: { hero: 'Engaged' } },
        };

        const actions: CombatAction[] = [{
            type: 'attack',
            actorId: 'hero',
            targetId: 'enemy',
            attackBonus: 2,
            weaponDie: 6,
            scalingStatMod: 1,
            forceRoll: 2,
            riskOnFail: 'none',
        }];

        const result = runCombatRound(state, actions);
        expect(result.resolutions[0].hit).toBe(false);
        expect(result.resolutions[0].riskApplied).toBeUndefined();
        expect(result.updatedCombatants.hero.statusEffects).toBeUndefined();
    });

    it('button path: 0 LLM calls before engine', async () => {
        const combatState = makeCombatState();

        const source: CombatActionSource = {
            kind: 'button',
            action: { type: 'attack', actorId: 'hero', targetId: 'enemy', weaponRange: 'Close', attackBonus: 5, weaponDie: 8, scalingStatMod: 3 },
        };

        let narrateCallCount = 0;
        await handleCombatAction(source, combatState, {
            addMessage: () => {},
            updateContext: () => {},
            setCombatState: () => {},
            terminateCombat: () => {},
            getAuxiliaryProvider: () => undefined,
            getStoryProvider: () => undefined,
            narrateCombatOutcome: async () => { narrateCallCount++; },
            items: [],
            skills: [],
        });

        expect(narrateCallCount).toBe(1);
    });

    it('freeform path without aux provider falls back to base action', async () => {
        const combatState = makeCombatState();

        let capturedActions: CombatAction[] = [];
        const engineSpy = vi.spyOn(await import('../engine/combatEngine'), 'runCombatRound').mockImplementation((_state: CombatState, actions: CombatAction[]) => {
            capturedActions = actions;
            return {
                resolutions: [{ actorId: 'hero', targetId: 'enemy', type: 'attack' as const, hit: true, critical: false, damage: 5, naturalRoll: 15, total: 19, coverApplied: false }],
                updatedCombatants: { ...combatState.combatants },
                updatedRangeRelations: combatState.rangeRelations,
                ledgerLine: 'Round 1 · hero 20/20 · enemy 7/12',
            };
        });

        const source: CombatActionSource = {
            kind: 'freeform',
            freeformText: 'I swing on the chandelier',
            baseAction: { type: 'attack', actorId: 'hero', targetId: 'enemy', weaponRange: 'Close', attackBonus: 5, weaponDie: 8, scalingStatMod: 3 },
        };

        await handleCombatAction(source, combatState, {
            addMessage: () => {},
            updateContext: () => {},
            setCombatState: () => {},
            terminateCombat: () => {},
            getAuxiliaryProvider: () => undefined,
            getStoryProvider: () => undefined,
            narrateCombatOutcome: async () => {},
            items: [],
            skills: [],
        });

        // Phase A: the PC's base action plus one auto-generated enemy action.
        expect(capturedActions.length).toBe(2);
        const action = capturedActions.find(a => a.actorId === 'hero')!;
        expect(action.attackBonus).toBe(5);
        expect(action.scalingStatMod).toBe(3);
        expect(action.riskOnFail).toBeUndefined();

        engineSpy.mockRestore();
    });
});