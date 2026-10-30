/**
 * Player-requested character update ("What changed?").
 *
 * The player names what changed; the engine looks for it in the game's history
 * (no model call), one supporting-model call proposes field edits citing that
 * evidence, and the player confirms each field before anything is saved.
 * When nothing in the history covers the request, the request itself is the
 * authority (a player correction).
 */

import type { ChatMessage, LLMProvider, LoreChunk, NPCEntry } from '../../types';
import { llmParseJson } from './npcShared';
import { sanitizeSignatureKit } from './signatureKit';
import { stripCanonLockedFields, findLoreMatch } from './npcCanon';
import { parseNPCsFromLore } from '../lore/loreNPCParser';
import { validateTraits, offeredTraitNames, validatePersonalityHex, HEX_AXES, HEX_AXIS_LEGEND } from './npcValidator';
import { RUNG_LABELS } from './agencyConstants';
import type { PersonalityHex } from '../../types';
import { JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER, joinPromptSections } from '../infrastructure';

// ── Evidence ──────────────────────────────────────────────────────────────

export type EvidenceScene = { sceneId: string; content: string };
export type UpdateEvidence = {
    scenes: EvidenceScene[];
    facts: string[];
    recent: string;
    /** True when the history actually matched the request (or the request was blank). */
    found: boolean;
};

export type EvidenceInput = {
    npc: NPCEntry;
    request: string;
    /** Every archived scene (content scan). */
    scenes: EvidenceScene[];
    /** Scene ids ranked by meaning (embedder), when available. */
    semanticSceneIds?: string[];
    /** Candidate fact lines (established facts, PC profile traits). */
    facts: string[];
    recentMessages: ChatMessage[];
    sceneBudgetChars?: number;
};

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'was', 'were', 'are', 'his', 'her', 'their', 'them', 'they', 'she', 'him',
    'has', 'had', 'have', 'not', 'now', 'but', 'from', 'into', 'got', 'get', 'gets', 'its', 'our', 'your', 'you', 'my',
    'mine', 'over', 'out', 'off', 'all', 'any', 'one', 'new', 'old', 'should', 'would', 'could', 'update', 'change',
    'changed', 'correct', 'correction', 'actually', 'wrong', 'instead', 'please', 'make', 'set', 'is', 'be', 'to',
]);

/** Search terms from the player's request (lower-case, ≥3 chars, no stopwords). */
export function requestTerms(request: string): string[] {
    const words = request.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? [];
    return [...new Set(words.filter(w => w.length >= 3 && !STOPWORDS.has(w)))];
}

function nameKeys(npc: Pick<NPCEntry, 'name' | 'aliases'>): string[] {
    return [npc.name, ...(npc.aliases || '').split(',')].map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Rank scenes for the request: full-text term hits (+ a bonus when the character
 * is named), merged with the meaning-based ranking. Newer scenes win ties.
 */
export function rankScenes(input: Pick<EvidenceInput, 'npc' | 'request' | 'scenes' | 'semanticSceneIds'>): string[] {
    const terms = requestTerms(input.request);
    const names = nameKeys(input.npc);
    const score = new Map<string, number>();
    if (terms.length > 0) {
        for (const s of input.scenes) {
            const text = s.content.toLowerCase();
            const hits = terms.filter(t => text.includes(t)).length;
            if (hits === 0) continue;
            const named = names.some(n => text.includes(n)) ? 1 : 0;
            score.set(s.sceneId, hits * 2 + named);
        }
    }
    // Meaning-based hits: rank-decayed bonus so a strong semantic match can surface
    // a scene that never uses the player's exact words.
    (input.semanticSceneIds ?? []).forEach((id, i) => {
        score.set(id, (score.get(id) ?? 0) + Math.max(1, 4 - i * 0.5));
    });
    return [...score.entries()]
        .sort((a, b) => b[1] - a[1] || parseInt(b[0], 10) - parseInt(a[0], 10))
        .map(([id]) => id);
}

export function gatherUpdateEvidence(input: EvidenceInput): UpdateEvidence {
    const budget = input.sceneBudgetChars ?? 9000;
    const byId = new Map(input.scenes.map(s => [s.sceneId, s] as const));
    const scenes: EvidenceScene[] = [];
    let used = 0;
    for (const id of rankScenes(input).slice(0, 6)) {
        const s = byId.get(id);
        if (!s) continue;
        const room = budget - used;
        if (room < 400) break;
        const content = s.content.length > room ? s.content.slice(0, room) + ' […]' : s.content;
        scenes.push({ sceneId: s.sceneId, content });
        used += content.length;
    }
    scenes.sort((a, b) => parseInt(a.sceneId, 10) - parseInt(b.sceneId, 10));

    const terms = requestTerms(input.request);
    // Blank request → the recent chat is the evidence; facts only when they match a term.
    const facts = terms.length === 0 ? [] : input.facts.filter(f => {
        const t = f.toLowerCase();
        return terms.some(term => t.includes(term));
    }).slice(0, 12);

    const recent = input.recentMessages.slice(-6)
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => `[${m.role === 'user' ? 'PLAYER' : 'GM'}]: ${(m.content || '').slice(0, 600)}`)
        .join('\n\n');

    const blank = !input.request.trim();
    return { scenes, facts, recent, found: blank || scenes.length > 0 || (terms.length > 0 && facts.length > 0) };
}

// ── Proposal ──────────────────────────────────────────────────────────────

export type UpdatableField =
    | 'aliases' | 'appearance' | 'appearanceTags' | 'equipment' | 'abilities' | 'element' | 'inventory'
    | 'condition' | 'status' | 'faction' | 'region' | 'haunt'
    | 'personality' | 'voice' | 'disposition' | 'traits' | 'personalityHex' | 'exampleOutput'
    | 'coreWant' | 'sessionWant' | 'sceneWant' | 'behavioralTriggers'
    | 'combatTier' | 'archetype' | 'rungCeiling'
    | 'goals' | 'longWant' | 'mediumWants' | 'storyRelevance' | 'hardBoundaries' | 'softBoundaries';

export const FIELD_LABELS: Record<UpdatableField, string> = {
    aliases: 'Aliases', appearance: 'Appearance', appearanceTags: 'Portrait tags', equipment: 'Equipment',
    abilities: 'Abilities / powers', element: 'Element', inventory: 'Inventory', condition: 'Condition',
    status: 'Status', faction: 'Faction', region: 'Region', haunt: 'Usual haunt',
    personality: 'Personality', voice: 'Voice', disposition: 'Disposition', traits: 'Traits',
    personalityHex: 'Personality axes', exampleOutput: 'Example dialogue',
    coreWant: 'Core want', sessionWant: 'Arc want', sceneWant: 'Scene want', behavioralTriggers: 'Triggers',
    combatTier: 'Combat tier', archetype: 'Archetype', rungCeiling: 'Talent ceiling',
    goals: 'Goals', longWant: 'Long-term want', mediumWants: 'Medium wants', storyRelevance: 'Story relevance',
    hardBoundaries: "Won't do", softBoundaries: 'Resents',
};
const ALL_FIELDS = Object.keys(FIELD_LABELS) as UpdatableField[];
/** "What changed" never sets the engine-owned personality axes or talent ceiling (drift guardrails own those). */
const FIELDS = ALL_FIELDS.filter(f => f !== 'personalityHex' && f !== 'rungCeiling');
const STATUSES = ['Alive', 'Deceased', 'Missing', 'Unknown'];
const CONDITIONS = ['healthy', 'wounded', 'critical', 'dead'];
const COMBAT_TIERS = ['minion', 'grunt', 'elite', 'boss', 'legendary'];
const ARCHETYPES = ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'];
const TEXT_MAX = 1000;
const TRIGGER_SEP = ' → ';
/** List fields and how many items each keeps. */
const LIST_MAX: Partial<Record<UpdatableField, number>> = {
    equipment: 8, abilities: 8, inventory: 20, traits: 5, mediumWants: 5, hardBoundaries: 8, softBoundaries: 8,
    behavioralTriggers: 6,
};
const isList = (f: UpdatableField) => f in LIST_MAX;

const showHex = (hex: PersonalityHex | undefined): string =>
    hex ? HEX_AXES.map(a => `${a} ${hex[a] > 0 ? '+' : ''}${hex[a]}`).join(', ') : '';

function parseHexText(text: string): PersonalityHex {
    const obj: Record<string, number> = {};
    for (const m of text.matchAll(/(\w+)\s*([+-]?\d+)/g)) obj[m[1]] = parseInt(m[2], 10);
    return validatePersonalityHex(obj);
}

export type UpdateProposal = {
    field: UpdatableField;
    label: string;
    before: string;
    after: string;
    /** Normalized value for the patch (string or string[]). */
    value: string | string[];
    /** Where the change came from, e.g. "scene 012", "established fact", "recent chat", "your request". */
    source: string;
    note?: string;
};

export type RequestedUpdateResult = {
    proposals: UpdateProposal[];
    evidenceFound: boolean;
    summary?: string;
    /** Shown above the proposals when they rest on weaker ground than usual. */
    warning?: string;
};

type ParseOptions = {
    matureMode?: boolean;
    /** Fields the model may change (default: all updatable fields). */
    fields?: readonly UpdatableField[];
    /** Canon-match mode: the player asked to rewrite identity, so the canon lock is lifted. */
    canonMatch?: boolean;
};

function currentValue(npc: NPCEntry, field: UpdatableField): string | string[] {
    switch (field) {
        case 'equipment': return npc.signatureKit?.equipment ?? [];
        case 'abilities': return npc.signatureKit?.abilities ?? [];
        case 'element': return npc.signatureKit?.element ?? '';
        case 'inventory': return npc.inventory ?? [];
        case 'traits': return npc.traits ?? [];
        case 'personalityHex': return showHex(npc.personalityHex);
        case 'coreWant': case 'sessionWant': case 'sceneWant': return npc.drives?.[field] ?? '';
        case 'behavioralTriggers': return (npc.behavioralTriggers ?? []).map(t => `${t.keyword}${TRIGGER_SEP}${t.shift}`);
        case 'combatTier': return npc.combatTier ?? '';
        case 'archetype': return npc.archetype ?? '';
        case 'rungCeiling': return npc.rungCeiling === undefined ? '' : RUNG_LABELS[npc.rungCeiling] ?? '';
        case 'longWant': return npc.wants?.long ?? '';
        case 'mediumWants': return npc.wants?.medium ?? [];
        case 'condition': return npc.condition ?? 'healthy';
        case 'hardBoundaries': return npc.hardBoundaries ?? [];
        case 'softBoundaries': return npc.softBoundaries ?? [];
        default: return (npc[field] as string | undefined) ?? '';
    }
}

const show = (v: string | string[]): string => Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : (v.trim() || '(empty)');

function normalizeValue(field: UpdatableField, raw: unknown, matureMode: boolean): string | string[] | undefined {
    if (field === 'traits') {
        if (!Array.isArray(raw)) return undefined;
        const traits = validateTraits(raw, matureMode);
        // Every proposed trait was off-vocabulary: reject rather than wipe the record.
        return raw.length > 0 && traits.length === 0 ? undefined : traits;
    }
    if (field === 'personalityHex') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
        return showHex(validatePersonalityHex(raw));
    }
    if (field === 'behavioralTriggers') {
        if (!Array.isArray(raw)) return undefined;
        return raw.map(t => {
            if (t && typeof t === 'object') {
                const { keyword, shift } = t as Record<string, unknown>;
                return keyword && shift ? `${String(keyword).trim()}${TRIGGER_SEP}${String(shift).replace(/\s+/g, ' ').trim()}` : '';
            }
            return String(t).includes(TRIGGER_SEP) ? String(t).trim() : '';
        }).filter(Boolean).slice(0, LIST_MAX.behavioralTriggers);
    }
    if (isList(field)) {
        if (!Array.isArray(raw)) return undefined;
        return raw.map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, LIST_MAX[field]);
    }
    if (typeof raw !== 'string') return undefined;
    const v = raw.replace(/\s+/g, ' ').trim();
    if (field === 'status') return STATUSES.find(s => s.toLowerCase() === v.toLowerCase());
    if (field === 'condition') return CONDITIONS.find(c => c === v.toLowerCase());
    if (field === 'combatTier') return COMBAT_TIERS.find(c => c === v.toLowerCase());
    if (field === 'archetype') return ARCHETYPES.find(c => c === v.toLowerCase());
    if (field === 'rungCeiling') return RUNG_LABELS.find(r => r.toLowerCase() === v.toLowerCase());
    return v ? v.slice(0, TEXT_MAX) : undefined;
}

function sourceLabel(raw: unknown, evidence: UpdateEvidence, canonMatch = false): string {
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (canonMatch) {
        if (s.startsWith('campaign') || s.startsWith('divergen')) return 'campaign';
        return s.startsWith('lore') ? 'lore entry' : s.startsWith('request') ? 'your request' : 'source material';
    }
    const scene = s.match(/scene\s*#?\s*(\d+)/);
    if (scene) {
        const hit = evidence.scenes.find(x => parseInt(x.sceneId, 10) === parseInt(scene[1], 10));
        if (hit) return `scene ${hit.sceneId}`;
    }
    if (s.startsWith('fact') && evidence.facts.length > 0) return 'established fact';
    if (s.startsWith('recent') && evidence.recent) return 'recent chat';
    return 'your request';
}

/** Validate the model's proposals against the record. Unknown fields, bad values and no-ops are dropped. */
export function parseProposals(raw: unknown, npc: NPCEntry, evidence: UpdateEvidence, opts: ParseOptions = {}): UpdateProposal[] {
    const { matureMode = false, fields = FIELDS, canonMatch = false } = opts;
    if (!raw || typeof raw !== 'object') return [];
    const list = (raw as Record<string, unknown>).changes;
    if (!Array.isArray(list)) return [];
    const out: UpdateProposal[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const c = item as Record<string, unknown>;
        const field = c.field as UpdatableField;
        if (!fields.includes(field) || out.some(p => p.field === field)) continue;
        const value = normalizeValue(field, c.value, matureMode);
        if (value === undefined) continue;
        const before = currentValue(npc, field);
        if (JSON.stringify(before) === JSON.stringify(value)) continue;
        // Canon fills play state only where the record is empty; the story owns it after that.
        if (canonMatch && CANON_FILL_ONLY.includes(field) && (Array.isArray(before) ? before.length > 0 : before.trim() !== '')) continue;
        out.push({
            field, label: FIELD_LABELS[field], before: show(before), after: show(value), value,
            source: sourceLabel(c.source, evidence, canonMatch),
            note: typeof c.note === 'string' && c.note.trim() ? c.note.trim().slice(0, 200) : undefined,
        });
    }
    if (canonMatch) return out;
    // Canon characters keep their source identity (same lock as the automatic updater).
    const allowed = stripCanonLockedFields(npc, Object.fromEntries(out.map(p => [p.field, true])) as Partial<NPCEntry>);
    return out.filter(p => p.field in allowed);
}

function recordText(npc: NPCEntry, fields: readonly UpdatableField[] = FIELDS): string {
    return fields.map(f => `${FIELD_LABELS[f]} (${f}): ${show(currentValue(npc, f))}`).join('\n');
}

export function buildRequestedUpdatePrompt(npc: NPCEntry, request: string, evidence: UpdateEvidence, matureMode = false): string {
    const who = npc.isPC ? "the PLAYER'S OWN CHARACTER" : 'a non-player character';
    const req = request.trim();
    const evidenceText = [
        evidence.scenes.length ? evidence.scenes.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n') : '',
        evidence.facts.length ? `--- ESTABLISHED FACTS ---\n${evidence.facts.map(f => `- ${f}`).join('\n')}` : '',
        evidence.recent ? `--- RECENT CHAT ---\n${evidence.recent}` : '',
    ].filter(Boolean).join('\n\n');

    return joinPromptSections(
        `You maintain the saved record of ${npc.name}, ${who} in an RPG. The player asked for this record to be updated. Propose field edits.`,
        `RULES:
1. ${req ? 'Change ONLY the fields the PLAYER REQUEST is about.' : 'The player left the request blank: change only fields the RECENT CHAT shows actually changed (completed, lasting changes — not plans, hypotheticals or temporary effects).'}
2. Use the EVIDENCE to get details right (names, items, wording). Cite it in "source": "scene 012", "fact" or "recent".
3. ${evidence.found ? 'If the evidence is silent on the request, or contradicts it, follow the PLAYER REQUEST anyway — the player is correcting the record. Use "source": "request" and say what conflicted in "note".' : 'NO MATCHING EVIDENCE WAS FOUND. The PLAYER REQUEST is the authority: apply it exactly as stated, with "source": "request".'}
4. Edit in place: keep every unchanged detail of a field exactly as written. Text fields are the FULL new text; list fields (${FIELDS.filter(isList).join(', ')}) are the FULL new list of short items.
5. Allowed fields: ${FIELDS.join(', ')}. status ∈ Alive|Deceased|Missing|Unknown. condition ∈ healthy|wounded|critical|dead. combatTier ∈ ${COMBAT_TIERS.join('|')}. archetype ∈ ${ARCHETYPES.join('|')}. behavioralTriggers: [{"keyword": "...", "shift": "..."}]. traits: up to 5, ONLY from: ${offeredTraitNames(matureMode).join(', ')}. Never change anything else.
6. If nothing needs changing, return {"changes": []}.

OUTPUT: {"summary": "one short sentence", "changes": [{"field": "abilities", "value": ["Pluto"], "source": "request", "note": "record said Orpheus"}]}`,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
        `[CURRENT RECORD — ${npc.name}${npc.aliases ? ` (aka ${npc.aliases})` : ''}]\n${recordText(npc)}`,
        `[PLAYER REQUEST]\n${req || '(blank — check the recent chat)'}`,
        `[EVIDENCE]\n${evidenceText || '(none found)'}`,
    );
}

export async function proposeRequestedUpdate(
    provider: LLMProvider,
    npc: NPCEntry,
    request: string,
    evidence: UpdateEvidence,
    matureMode = false,
): Promise<RequestedUpdateResult> {
    const parsed = await llmParseJson<Record<string, unknown>>(provider, buildRequestedUpdatePrompt(npc, request, evidence, matureMode), 'NPC Requested Update');
    if (!parsed) throw new Error('The AI returned no usable answer.');
    return {
        proposals: parseProposals(parsed, npc, evidence, { matureMode }),
        evidenceFound: evidence.found,
        summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : undefined,
    };
}

// ── Complete from canon ───────────────────────────────────────────────────

/** Play state canon may only fill when empty: the story owns it once it is set. */
const CANON_FILL_ONLY: readonly UpdatableField[] = [
    'status', 'faction', 'region', 'haunt', 'goals', 'longWant', 'mediumWants', 'sessionWant', 'sceneWant',
];
/** The whole authored record. Inventory and condition are never canon's business. */
export const CANON_MATCH_FIELDS: readonly UpdatableField[] = ALL_FIELDS.filter(f => f !== 'inventory' && f !== 'condition');
const LORE_ENTRY_MAX = 8000;
const LORE_SETTING_MAX = 1500;

export type CanonLore = {
    /** Every lore chunk about the character (entry, profile, arc notes), when the world lore has any. */
    entry: string;
    /** Always-on world lore, so the model can tell which setting this is. */
    setting: string;
    /** Where this campaign has broken from canon. Outranks the lore and the source. */
    divergence?: string[];
};

const DIVERGENCE_MAX = 25;

/**
 * The campaign's divergence register, for canon completion. Entries naming the character
 * lead, then the most recent of the rest (a divergence elsewhere — "Shinjiro survived" —
 * still changes who this character is).
 */
export function pickDivergence(npc: Pick<NPCEntry, 'name' | 'aliases'>, entries: string[]): string[] {
    const keys = nameKeys(npc);
    const named = entries.filter(e => keys.some(k => e.toLowerCase().includes(k)));
    const rest = entries.filter(e => !named.includes(e)).reverse();
    return [...named, ...rest].slice(0, DIVERGENCE_MAX);
}

export function gatherCanonLore(npc: Pick<NPCEntry, 'name' | 'aliases'>, chunks: LoreChunk[]): CanonLore {
    const keys = nameKeys(npc).filter(k => k.length > 2);
    const about = (c: LoreChunk) =>
        keys.some(k => c.header.toLowerCase().includes(k) || c.triggerKeywords.some(t => t.toLowerCase() === k));
    // The character entry leads; profile / arc chunks that name them follow.
    const own = chunks.filter(c => c.category === 'character' && findLoreMatch(npc, parseNPCsFromLore([c])));
    const related = chunks.filter(c => !own.includes(c) && about(c));
    const entry = [...own, ...related].map(c => `${c.header}\n${c.content}`).join('\n\n').slice(0, LORE_ENTRY_MAX);
    const setting = chunks
        .filter(c => c.alwaysInclude && c.category !== 'character' && !related.includes(c))
        .map(c => `${c.header}\n${c.content}`)
        .join('\n\n')
        .slice(0, LORE_SETTING_MAX);
    return { entry, setting };
}

export function buildCanonUpdatePrompt(npc: NPCEntry, request: string, lore: CanonLore, matureMode = false): string {
    const req = request.trim();
    return joinPromptSections(
        `You maintain the saved record of ${npc.name}, a character from this setting's source material. The player wants the record COMPLETED and corrected from canon, so the engine can play them fully. Propose field edits.`,
        `RULES:
1. Authority, highest first: CAMPAIGN DIVERGENCE (what actually happened in this campaign), then the LORE (this campaign's canon), then your own knowledge of the source material. Where the divergence contradicts canon, the record follows the campaign: never write a canon event, relationship, death or Persona the divergence says went differently. Cite "source": "campaign", "lore" or "canon".
2. If you do not confidently recognise this character in the source material and there is no LORE, return {"changes": []} and say so in "summary". Never invent canon.
3. ${req ? 'The PLAYER FOCUS narrows what to complete (which fields, or which point in the story). Follow it; use "source": "request" when the change comes from it alone.' : 'Fill every empty field and fix every wrong, thin or generic one. A record the engine can play needs all of them.'}
4. Keep whatever already matches canon exactly as written. Text fields are the FULL new text; list fields (${CANON_MATCH_FIELDS.filter(isList).join(', ')}) are the FULL new list of short items.
5. ${CANON_FILL_ONLY.join(', ')} are play state: propose them ONLY if the record shows them empty, from where the character stands at the story's opening.
6. Field formats:
   - traits: up to 5, ONLY from: ${offeredTraitNames(matureMode).join(', ')}.
   - personalityHex: {"drive":n,"diligence":n,"boldness":n,"warmth":n,"empathy":n,"composure":n}, each an integer -3..+3, true to the source.
   - behavioralTriggers: [{"keyword": "word that sets them off", "shift": "how their behaviour changes"}], up to 6, drawn from their canon history.
   - coreWant = their deepest truth; sessionWant = their current arc goal; sceneWant = what they want right now.
   - exampleOutput: 2-3 lines of their dialogue in their canon voice.
   - status ∈ Alive|Deceased|Missing|Unknown. combatTier ∈ ${COMBAT_TIERS.join('|')}. archetype ∈ ${ARCHETYPES.join('|')}. rungCeiling (their talent cap) ∈ ${RUNG_LABELS.join('|')}.
7. Allowed fields: ${CANON_MATCH_FIELDS.join(', ')}. Never change anything else.

${HEX_AXIS_LEGEND}

OUTPUT: {"summary": "one short sentence", "changes": [{"field": "abilities", "value": ["Polydeuces"], "source": "lore", "note": "his initial Persona"}, {"field": "personalityHex", "value": {"drive":3,"diligence":2,"boldness":2,"warmth":0,"empathy":1,"composure":0}, "source": "canon"}]}`,
        JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER,
        `[CURRENT RECORD — ${npc.name}${npc.aliases ? ` (aka ${npc.aliases})` : ''}]\n${recordText(npc, CANON_MATCH_FIELDS)}`,
        `[PLAYER FOCUS]\n${req || '(none — complete the whole record)'}`,
        `[CAMPAIGN DIVERGENCE — overrides canon]\n${lore.divergence?.length ? lore.divergence.map(d => `- ${d}`).join('\n') : '(none recorded — canon holds)'}`,
        `[LORE]\n${lore.entry || '(none — use your knowledge of the source material)'}`,
        lore.setting ? `[SETTING]\n${lore.setting}` : '',
    );
}

export async function proposeCanonUpdate(
    provider: LLMProvider,
    npc: NPCEntry,
    request: string,
    lore: CanonLore,
    matureMode = false,
): Promise<RequestedUpdateResult> {
    const parsed = await llmParseJson<Record<string, unknown>>(provider, buildCanonUpdatePrompt(npc, request, lore, matureMode), 'NPC Canon Update');
    if (!parsed) throw new Error('The AI returned no usable answer.');
    const none: UpdateEvidence = { scenes: [], facts: [], recent: '', found: true };
    return {
        proposals: parseProposals(parsed, npc, none, { matureMode, fields: CANON_MATCH_FIELDS, canonMatch: true }),
        evidenceFound: true,
        summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : undefined,
        warning: lore.entry ? undefined : 'No lore entry for this character — these come from the model\'s own memory of the source. Check them before applying.',
    };
}

/** Patch for the proposals the player accepted (kit, wants and drives merge into their objects). */
export function buildAcceptedPatch(npc: NPCEntry, accepted: UpdateProposal[]): Partial<NPCEntry> {
    const patch: Record<string, unknown> = {};
    const kit: Record<string, unknown> = {};
    const wants: Record<string, unknown> = {};
    const drives: Record<string, unknown> = {};
    for (const p of accepted) {
        const text = Array.isArray(p.value) ? p.value.join(', ') : p.value;
        const list = Array.isArray(p.value) ? p.value : [p.value];
        switch (p.field) {
            case 'equipment': case 'abilities': case 'element': kit[p.field] = p.value; break;
            case 'longWant': wants.long = p.value; break;
            case 'mediumWants': wants.medium = p.value; break;
            case 'coreWant': case 'sessionWant': case 'sceneWant': drives[p.field] = text; break;
            case 'behavioralTriggers':
                patch.behavioralTriggers = list.map(t => {
                    const [keyword, ...rest] = t.split(TRIGGER_SEP);
                    return { keyword: keyword.trim(), shift: rest.join(TRIGGER_SEP).trim() };
                }).filter(t => t.keyword && t.shift);
                break;
            case 'personalityHex': {
                const hex = parseHexText(text);
                patch.personalityHex = hex;
                // A canon character's anchor moves with a canon correction, or drift would pull it back.
                if (npc.canon === true) patch.canonHex = { ...hex };
                break;
            }
            case 'rungCeiling': {
                const ceiling = RUNG_LABELS.indexOf(text as typeof RUNG_LABELS[number]);
                if (ceiling >= 0) {
                    patch.rungCeiling = ceiling;
                    if ((npc.skillRung ?? 0) > ceiling) patch.skillRung = ceiling;
                }
                break;
            }
            default: patch[p.field] = p.value;
        }
    }
    if (Object.keys(kit).length > 0) patch.signatureKit = sanitizeSignatureKit(kit, npc.signatureKit);
    if (Object.keys(wants).length > 0) patch.wants = { short: npc.wants?.short ?? [], medium: npc.wants?.medium ?? [], long: npc.wants?.long ?? '', ...wants };
    if (Object.keys(drives).length > 0) patch.drives = { coreWant: npc.drives?.coreWant ?? '', sessionWant: npc.drives?.sessionWant ?? '', sceneWant: npc.drives?.sceneWant ?? '', ...drives };
    return patch as Partial<NPCEntry>;
}
