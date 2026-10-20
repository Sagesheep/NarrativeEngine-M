import { describe, it, expect } from 'vitest';
import type { CharacterProfileState, CharacterTrait, ChatMessage, NPCEntry } from '../../types';
import {
    isFactMaintenanceEligible, resolvePcStateUpdate, renderPcCurrentState, hasPcFactCue, withCommittedReply, PC_FACT_FIELDS,
} from './pcFactMaintenance';
import { isAgencyEligible, filterUpdatableNPCs } from './agencyLifecycle';
import { formatTraitsForContext, queryTraits } from '../campaign-state/semanticMemory';

const APPEARANCE = 'Lean teenage boy, shaggy dark blue hair falling over one eye, grey eyes, Gekkoukan school uniform, earbuds around his neck';

const pc = (over: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'pc1', name: 'Makoto', isPC: true, aliases: '', appearance: APPEARANCE, faction: '', storyRelevance: '',
    disposition: '', status: 'Alive', goals: 'Unknown', voice: '', personality: 'calm', exampleOutput: '', affinity: 50,
    signatureKit: { equipment: ['Evoker yet to be issued', 'one-handed sword'], abilities: ['Orpheus'] },
    condition: 'healthy',
    ...over,
} as NPCEntry);

const msg = (role: 'user' | 'assistant', content: string, id = Math.random().toString()): ChatMessage =>
    ({ id, role, content, timestamp: 0 } as ChatMessage);

const slot = (value: unknown, evidence: string, basis = 'completed_change') => ({ changed: true, basis, evidence, value });

describe('eligibility: fact maintenance is separate from agency', () => {
    it('the PC is eligible for fact maintenance but never for autonomous agency', () => {
        const p = pc();
        expect(isFactMaintenanceEligible(p)).toBe(true);
        expect(isAgencyEligible(p)).toBe(false);
        expect(filterUpdatableNPCs([p], { onStageIds: ['pc1'], recentlyMentionedIds: ['pc1'] })).toEqual([]);
    });
    it('ordinary NPCs are not fact-maintenance targets', () => {
        expect(isFactMaintenanceEligible(pc({ isPC: false }))).toBe(false);
        expect(isFactMaintenanceEligible(undefined)).toBe(false);
    });
});

describe('resolvePcStateUpdate', () => {
    it('first-person haircut updates appearance, keeping the unchanged details', () => {
        const chat = [msg('user', 'I go to the barber and get my hair cut short.'), msg('assistant', 'The barber trims it close. You look sharper.')];
        const next = APPEARANCE.replace('shaggy dark blue hair falling over one eye', 'short-cropped dark blue hair');
        const patch = resolvePcStateUpdate({ appearance: slot(next, 'I go to the barber and get my hair cut short.') }, pc(), chat);
        expect(patch).toEqual({ appearance: next });
        expect(patch.appearance).toContain('Gekkoukan school uniform');
    });

    it('a rewrite that drops most of the saved description is rejected', () => {
        const chat = [msg('user', 'I get my hair cut short.')];
        expect(resolvePcStateUpdate({ appearance: slot('Short hair.', 'I get my hair cut short.') }, pc(), chat)).toEqual({});
    });

    it('ordinary re-description is no change', () => {
        const chat = [msg('assistant', 'You brush the blue hair from your eyes, grey gaze steady.')];
        const raw = { appearance: { changed: false, basis: '', evidence: '', value: '' } };
        expect(resolvePcStateUpdate(raw, pc(), chat)).toEqual({});
        // Even when flagged, an identical value is not a change.
        expect(resolvePcStateUpdate({ appearance: slot(APPEARANCE, 'You brush the blue hair from your eyes') }, pc(), chat)).toEqual({});
    });

    it('rejects evidence that is not in the committed chat', () => {
        const chat = [msg('assistant', 'You walk to the dorm.')];
        expect(resolvePcStateUpdate({ appearance: slot(APPEARANCE + ', scar on cheek', 'A blade cuts your cheek') }, pc(), chat)).toEqual({});
    });

    it('rejects plans, hypotheticals and temporary effects by basis', () => {
        const chat = [msg('assistant', 'Mitsuru says your Evoker will be issued tomorrow.')];
        for (const basis of ['plan', 'hypothetical', 'temporary', '']) {
            const raw = { equipment: slot(['Evoker', 'one-handed sword'], 'your Evoker will be issued tomorrow', basis) };
            expect(resolvePcStateUpdate(raw, pc(), chat)).toEqual({});
        }
    });

    it('equipment issuance replaces the placeholder and keeps the other items and powers', () => {
        const chat = [msg('assistant', 'Mitsuru presses a silver Evoker into your hand. "This is yours now."')];
        const raw = { equipment: slot(['Evoker', 'one-handed sword'], 'Mitsuru presses a silver Evoker into your hand.') };
        expect(resolvePcStateUpdate(raw, pc(), chat)).toEqual({
            signatureKit: { equipment: ['Evoker', 'one-handed sword'], abilities: ['Orpheus'], element: undefined },
        });
    });

    it('an explicit player correction fixes an ability; must be quoted from a PLAYER line', () => {
        const correction = 'Correction: my Persona is Pluto, not Orpheus.';
        const raw = { abilities: slot(['Pluto'], correction, 'player_correction') };
        const fromPlayer = resolvePcStateUpdate(raw, pc(), [msg('user', correction)]);
        expect(fromPlayer.signatureKit?.abilities).toEqual(['Pluto']);
        expect(fromPlayer.signatureKit?.equipment).toEqual(['Evoker yet to be issued', 'one-handed sword']);
        // The same text appearing only in a GM line is not a player correction.
        expect(resolvePcStateUpdate(raw, pc(), [msg('assistant', correction)])).toEqual({});
    });

    it('condition follows committed events and only valid values', () => {
        const chat = [msg('assistant', 'The Shadow’s claw rakes your side; blood soaks your shirt.')];
        expect(resolvePcStateUpdate({ condition: slot('wounded', 'The Shadow’s claw rakes your side') }, pc(), chat)).toEqual({ condition: 'wounded' });
        expect(resolvePcStateUpdate({ condition: slot('bloodied', 'The Shadow’s claw rakes your side') }, pc(), chat)).toEqual({});
    });

    it('never writes personality, goals, intentions or relationships', () => {
        const chat = [msg('user', 'I cut my hair and decide I hate Junpei now.')];
        const raw = {
            personality: slot('bitter', 'I cut my hair'), goals: slot('defeat Junpei', 'I cut my hair'),
            relationships: slot({ Junpei: -50 }, 'I cut my hair'),
            appearance: { ...slot(APPEARANCE.replace('shaggy', 'short'), 'I cut my hair'), personality: 'bitter' },
        };
        const patch = resolvePcStateUpdate(raw, pc(), chat);
        expect(Object.keys(patch).every(k => (PC_FACT_FIELDS as readonly string[]).includes(k))).toBe(true);
        expect(patch).toEqual({ appearance: APPEARANCE.replace('shaggy', 'short') });
    });

    it('malformed input changes nothing', () => {
        for (const raw of [undefined, null, 'x', 42, { appearance: 'new look' }, { equipment: slot('Evoker', 'x') }]) {
            expect(resolvePcStateUpdate(raw, pc(), [msg('user', 'x')])).toEqual({});
        }
    });
});

describe('current state in the payload', () => {
    const trait = (id: string, text: string, importance = 9): CharacterTrait => ({
        id, subject: 'Makoto', category: 'party_facts', text, importance, eventTags: ['other'],
        sceneEstablished: '1', superseded: false, source: 'llm',
    });

    it('renders one authoritative line from the ledger row', () => {
        expect(renderPcCurrentState(pc({ condition: 'wounded' }))).toBe(
            `Current state (authoritative — overrides any older trait): Appearance: ${APPEARANCE} | KIT: Evoker yet to be issued, one-handed sword | POWERS: Orpheus | Condition: wounded`);
        expect(renderPcCurrentState(pc({ isPC: false }))).toBe('');
    });

    it('survives a full trait list of unrelated facts and outranks a conflicting old trait', () => {
        const traits = [trait('old', 'Persona: Hades', 10), ...Array.from({ length: 12 }, (_, i) => trait(`t${i}`, `Unrelated fact ${i}`, 10))];
        const profile: CharacterProfileState = { identity: { name: 'Makoto' }, activeTraits: traits };
        const current = renderPcCurrentState(pc({ signatureKit: { equipment: ['Evoker'], abilities: ['Pluto'] } }));
        const text = formatTraitsForContext(profile, queryTraits(traits, 'hello', [], [], undefined, 50, 5), current);
        expect(text).toContain('POWERS: Pluto');
        expect(text).toContain('overrides any older trait');
        expect(text.indexOf('POWERS: Pluto')).toBeLessThan(text.indexOf('Core:'));
    });
});

describe('cue + committed view helpers', () => {
    it('cues on change/correction words, not on plain dialogue', () => {
        expect(hasPcFactCue('I cut my hair')).toBe(true);
        expect(hasPcFactCue('Mitsuru issues you an Evoker')).toBe(true);
        expect(hasPcFactCue('OOC correction: my persona is Pluto')).toBe(true);
        expect(hasPcFactCue('We talk about the weather and eat ramen.')).toBe(false);
    });

    it('swaps the frozen swipe-1 reply for the committed variant', () => {
        const msgs = [msg('user', 'I look around.', 'u'), msg('assistant', 'SWIPE ONE', 'a')];
        const out = withCommittedReply(msgs, 'SWIPE THREE');
        expect(out.map(m => m.content)).toEqual(['I look around.', 'SWIPE THREE']);
        expect(msgs[1].content).toBe('SWIPE ONE'); // not mutated
        expect(withCommittedReply([msg('user', 'hi')], 'reply').map(m => m.content)).toEqual(['hi', 'reply']);
        expect(withCommittedReply(msgs, undefined)).toBe(msgs);
    });
});
