/**
 * Player-requested character update ("What changed?").
 *
 * The player names what changed; the engine looks for it in the game's history
 * (no model call), one supporting-model call proposes field edits citing that
 * evidence, and the player confirms each field before anything is saved.
 * When nothing in the history covers the request, the request itself is the
 * authority (a player correction).
 */

import type { ChatMessage, LLMProvider, NPCEntry } from '../../types';
import { llmParseJson } from './npcShared';
import { sanitizeSignatureKit } from './signatureKit';
import { stripCanonLockedFields } from './npcCanon';
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

function nameKeys(npc: NPCEntry): string[] {
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
    | 'appearance' | 'equipment' | 'abilities' | 'condition' | 'status' | 'faction'
    | 'personality' | 'voice' | 'disposition' | 'goals' | 'storyRelevance' | 'hardBoundaries' | 'softBoundaries';

export const FIELD_LABELS: Record<UpdatableField, string> = {
    appearance: 'Appearance', equipment: 'Equipment', abilities: 'Abilities / powers', condition: 'Condition',
    status: 'Status', faction: 'Faction', personality: 'Personality', voice: 'Voice', disposition: 'Disposition',
    goals: 'Goals', storyRelevance: 'Story relevance', hardBoundaries: "Won't do", softBoundaries: 'Resents',
};
const FIELDS = Object.keys(FIELD_LABELS) as UpdatableField[];
const STATUSES = ['Alive', 'Deceased', 'Missing', 'Unknown'];
const CONDITIONS = ['healthy', 'wounded', 'critical', 'dead'];
const TEXT_MAX = 1000;

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
};

function currentValue(npc: NPCEntry, field: UpdatableField): string | string[] {
    switch (field) {
        case 'equipment': return npc.signatureKit?.equipment ?? [];
        case 'abilities': return npc.signatureKit?.abilities ?? [];
        case 'condition': return npc.condition ?? 'healthy';
        case 'hardBoundaries': return npc.hardBoundaries ?? [];
        case 'softBoundaries': return npc.softBoundaries ?? [];
        default: return (npc[field] as string | undefined) ?? '';
    }
}

const show = (v: string | string[]): string => Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : (v.trim() || '(empty)');

function normalizeValue(field: UpdatableField, raw: unknown): string | string[] | undefined {
    if (field === 'equipment' || field === 'abilities' || field === 'hardBoundaries' || field === 'softBoundaries') {
        if (!Array.isArray(raw)) return undefined;
        return raw.map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 8);
    }
    if (typeof raw !== 'string') return undefined;
    const v = raw.replace(/\s+/g, ' ').trim();
    if (field === 'status') return STATUSES.find(s => s.toLowerCase() === v.toLowerCase());
    if (field === 'condition') return CONDITIONS.find(c => c === v.toLowerCase());
    return v ? v.slice(0, TEXT_MAX) : undefined;
}

function sourceLabel(raw: unknown, evidence: UpdateEvidence): string {
    const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
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
export function parseProposals(raw: unknown, npc: NPCEntry, evidence: UpdateEvidence): UpdateProposal[] {
    if (!raw || typeof raw !== 'object') return [];
    const list = (raw as Record<string, unknown>).changes;
    if (!Array.isArray(list)) return [];
    const out: UpdateProposal[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const c = item as Record<string, unknown>;
        const field = c.field as UpdatableField;
        if (!FIELDS.includes(field) || out.some(p => p.field === field)) continue;
        const value = normalizeValue(field, c.value);
        if (value === undefined) continue;
        const before = currentValue(npc, field);
        if (JSON.stringify(before) === JSON.stringify(value)) continue;
        out.push({
            field, label: FIELD_LABELS[field], before: show(before), after: show(value), value,
            source: sourceLabel(c.source, evidence),
            note: typeof c.note === 'string' && c.note.trim() ? c.note.trim().slice(0, 200) : undefined,
        });
    }
    // Canon characters keep their source identity (same lock as the automatic updater).
    const allowed = stripCanonLockedFields(npc, Object.fromEntries(out.map(p => [p.field, true])) as Partial<NPCEntry>);
    return out.filter(p => p.field in allowed);
}

function recordText(npc: NPCEntry): string {
    return FIELDS.map(f => `${FIELD_LABELS[f]} (${f}): ${show(currentValue(npc, f))}`).join('\n');
}

export function buildRequestedUpdatePrompt(npc: NPCEntry, request: string, evidence: UpdateEvidence): string {
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
4. Edit in place: keep every unchanged detail of a field exactly as written. Text fields are the FULL new text; list fields (equipment, abilities, hardBoundaries, softBoundaries) are the FULL new list of short items.
5. Allowed fields: ${FIELDS.join(', ')}. status ∈ Alive|Deceased|Missing|Unknown. condition ∈ healthy|wounded|critical|dead. Never change anything else.
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
): Promise<RequestedUpdateResult> {
    const parsed = await llmParseJson<Record<string, unknown>>(provider, buildRequestedUpdatePrompt(npc, request, evidence), 'NPC Requested Update');
    if (!parsed) throw new Error('The AI returned no usable answer.');
    return {
        proposals: parseProposals(parsed, npc, evidence),
        evidenceFound: evidence.found,
        summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 300) : undefined,
    };
}

/** Patch for the proposals the player accepted (equipment/abilities merge into the kit). */
export function buildAcceptedPatch(npc: NPCEntry, accepted: UpdateProposal[]): Partial<NPCEntry> {
    const patch: Record<string, unknown> = {};
    const kit: Record<string, unknown> = {};
    for (const p of accepted) {
        if (p.field === 'equipment' || p.field === 'abilities') kit[p.field] = p.value;
        else patch[p.field] = p.value;
    }
    if (Object.keys(kit).length > 0) patch.signatureKit = sanitizeSignatureKit(kit, npc.signatureKit);
    return patch as Partial<NPCEntry>;
}
