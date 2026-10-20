import type { ChatMessage, NPCEntry, NPCSignatureKit } from '../../types';
import { sanitizeSignatureKit, renderSignatureKit } from './signatureKit';

// Player-character fact maintenance.
//
// The PC ledger row is the single owner of the PC's CURRENT factual state:
// appearance (incl. clothing), signatureKit (equipment + powers) and condition.
// These are overwritten in place (never appended as profile traits), so newer
// unrelated traits can never crowd them out and the payload never carries two
// competing "current" values.
//
// This is deliberately separate from autonomous agency: isAgencyEligible still
// excludes the PC. Maintenance writes ONLY the fields below — never personality,
// goals, intentions, decisions or relationships, which belong to the player.

export const PC_FACT_FIELDS = ['appearance', 'signatureKit', 'condition'] as const;
export type PcFactPatch = Partial<Pick<NPCEntry, typeof PC_FACT_FIELDS[number]>>;

const CONDITIONS = ['healthy', 'wounded', 'critical', 'dead'] as const;
type Condition = typeof CONDITIONS[number];
const ACCEPTED_BASES = new Set(['completed_change', 'player_correction']);
const APPEARANCE_MAXLEN = 1000;

/** Eligible for factual maintenance (current-state upkeep), NOT for agency. */
export function isFactMaintenanceEligible(npc: NPCEntry | undefined): npc is NPCEntry {
    return !!npc && npc.isPC === true;
}

/** The PC's current state as the profile scan sees it (input section). */
export function buildPcStateSection(pc: NPCEntry): string {
    const kit = pc.signatureKit;
    return [
        `Appearance: ${pc.appearance?.trim() || '(not yet described)'}`,
        `Equipment: ${kit?.equipment.length ? JSON.stringify(kit.equipment) : '[]'}`,
        `Abilities/powers: ${kit?.abilities.length ? JSON.stringify(kit.abilities) : '[]'}`,
        `Condition: ${pc.condition ?? 'healthy'}`,
    ].join('\n');
}

/**
 * The PC's current state as the story model sees it, inside [CHARACTER PROFILE].
 * Authoritative over older traits; built from the ledger row only.
 */
export function renderPcCurrentState(pc: NPCEntry | undefined): string {
    if (!isFactMaintenanceEligible(pc)) return '';
    const bits: string[] = [];
    if (pc.appearance?.trim()) bits.push(`Appearance: ${pc.appearance.trim()}`);
    const kit = renderSignatureKit(pc.signatureKit);
    if (kit) bits.push(kit);
    if (pc.condition && pc.condition !== 'healthy') bits.push(`Condition: ${pc.condition}`);
    if (bits.length === 0) return '';
    return `Current state (authoritative — overrides any older trait): ${bits.join(' | ')}`;
}

const norm = (s: string) => s.toLowerCase().replace(/["“”'‘’`]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Evidence must be quoted from the committed chat (anti-hallucination). A player
 * correction must be quoted from a PLAYER line.
 */
function evidenceFound(evidence: string, messages: ChatMessage[], playerOnly: boolean): boolean {
    const ev = norm(evidence);
    if (ev.length < 4) return false;
    const probe = ev.slice(0, 40);
    return messages.some(m =>
        (playerOnly ? m.role === 'user' : (m.role === 'user' || m.role === 'assistant')) &&
        norm(m.content || '').includes(probe));
}

function acceptedSlot(raw: unknown, messages: ChatMessage[]): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    if (s.changed !== true) return null;
    if (typeof s.basis !== 'string' || !ACCEPTED_BASES.has(s.basis)) return null;
    if (typeof s.evidence !== 'string') return null;
    if (!evidenceFound(s.evidence, messages, s.basis === 'player_correction')) return null;
    return s;
}

function sameList(a: string[] | undefined, b: string[]): boolean {
    const x = a ?? [];
    return x.length === b.length && x.every((v, i) => v === b[i]);
}

/**
 * Validate the scan's `pcStateUpdate` against the PC row and the committed chat.
 * Returns a patch holding ONLY accepted, actually-changed PC_FACT_FIELDS.
 * Anything malformed, unevidenced, planned, hypothetical or temporary is dropped
 * (the saved value stays).
 */
export function resolvePcStateUpdate(raw: unknown, pc: NPCEntry, messages: ChatMessage[]): PcFactPatch {
    const patch: PcFactPatch = {};
    if (!raw || typeof raw !== 'object') return patch;
    const u = raw as Record<string, unknown>;

    const app = acceptedSlot(u.appearance, messages);
    if (app && typeof app.value === 'string') {
        const next = app.value.replace(/\s+/g, ' ').trim().slice(0, APPEARANCE_MAXLEN);
        const prev = (pc.appearance ?? '').trim();
        // Edit-in-place contract: a rewrite that throws away most of the saved
        // description is treated as a failure, not a change.
        const gutted = prev.length >= 40 && next.length < prev.length * 0.4;
        if (gutted) console.warn('[PcFacts] appearance update dropped most existing details — kept saved appearance');
        if (next && next !== prev && !gutted) patch.appearance = next;
    }

    const kitChange: Record<string, unknown> = {};
    const eq = acceptedSlot(u.equipment, messages);
    if (eq && Array.isArray(eq.value)) kitChange.equipment = eq.value;
    const ab = acceptedSlot(u.abilities, messages);
    if (ab && Array.isArray(ab.value)) kitChange.abilities = ab.value;
    if (Object.keys(kitChange).length > 0) {
        const merged = sanitizeSignatureKit(kitChange, pc.signatureKit);
        const prev = pc.signatureKit;
        const changed = !prev !== !merged ||
            (!!prev && !!merged && (!sameList(prev.equipment, merged.equipment) || !sameList(prev.abilities, merged.abilities)));
        if (changed) patch.signatureKit = merged as NPCSignatureKit;
    }

    const cond = acceptedSlot(u.condition, messages);
    if (cond && typeof cond.value === 'string') {
        const c = cond.value.trim().toLowerCase() as Condition;
        if ((CONDITIONS as readonly string[]).includes(c) && c !== (pc.condition ?? 'healthy')) patch.condition = c;
    }

    return patch;
}

// Cheap gate: words that suggest a PC appearance/equipment/power/condition change
// or an explicit correction. A hit runs the (existing) profile scan on this commit
// instead of waiting for the bookkeeping interval. False positives only cost one
// supporting-model scan.
const PC_FACT_CUE = /\b(hair|haircut|dye[ds]?|dyed|shav(e|ed|es)|scar(red|s)?|tattoo(ed|s)?|wear(s|ing)?|wore|dress(ed|es)?|outfit|cloth(es|ing)|armou?r|uniform|cloak|coat|boots|equip(ped|s)?|issued?|hands? (you|me)|given|receiv(e|ed|es)|lost|stolen|broke(n)?|shatter(ed|s)?|gain(ed|s)?|learn(ed|t|s)?|awaken(ed|s)?|unlock(ed|s)?|power(s)?|abilit(y|ies)|persona|evoker|transform(ed|s)?|wound(ed|s)?|injur(ed|y|ies)|heal(ed|s)?|correction|retcon|ooc)\b/i;

export function hasPcFactCue(text: string): boolean {
    return PC_FACT_CUE.test(text);
}

/**
 * The committed view of the chat: the latest assistant message carries the
 * COMMITTED swipe variant's text (the turn snapshot froze swipe 1's text).
 */
export function withCommittedReply(messages: ChatMessage[], committedText: string | undefined): ChatMessage[] {
    if (committedText === undefined) return messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            if (messages[i].content === committedText) return messages;
            const out = [...messages];
            out[i] = { ...messages[i], content: committedText };
            return out;
        }
        if (messages[i].role === 'user') break; // no reply after the last player line yet
    }
    return [...messages, { id: 'committed-reply', role: 'assistant', content: committedText, timestamp: Date.now() } as ChatMessage];
}
