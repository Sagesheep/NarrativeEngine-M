// Arc Engine — WO-03 spawn (arcSpawn.ts).
// This is the rewritten Trouble generator. The fork site was
// src/services/engine/troublemaker.ts::generateTroubleOptions. The Trouble engine's
// "CRITICAL LOCATION RULE" (a stranger walks up to the player at their current
// location) is DELETED and INVERTED: an arc seed is systemic + indirect — a
// standing condition in the world (economy/politics/factions/society) that worsens
// over time and only reaches the player through ambient/rumor surface tiers until
// its top rungs finally land in a scene.
//
// This is the ONLY +1 LLM call in the Arc Engine, and it fires seam-only (gated by
// arcWorldState ≠ 'live' AND active arcs < MAX_ACTIVE_ARCS AND type off cooldown —
// the gate lives in WO-05's turnPostProcess wiring). spawnArc itself does NOT gate;
// it authors ONE arc against the single anchor it is handed.
//
// Output: a fully-formed, validated ArcRecord (currentRung 0, tickDC ARC_TICK_DC.initial,
// stance 'unaware', status 'active'), or null if generation/validation failed.
//
// Validation per contract §4:
//   - ladder.length must be LADDER_MIN..LADDER_MAX → reject if outside.
//   - type must be a valid ArcType AND not in suppressedTypes → reject if violated.
//   - each surface coerced to a valid ArcSurface (default 'ambient' if garbage).
//   - early rungs skew ambient/rumor, last 1–2 direct — SOFT (the prompt instructs it;
//     we do NOT reject on a skew violation, only coerce bad surface tokens).
//   - reuse troublemaker's JSON-extract + fallback parse skeleton.

import type {
    ArcPace,
    ArcRecord,
    ArcStage,
    ArcSurface,
    ArcType,
    LLMProvider,
    NPCEntry,
    NPCPressure,
} from '../../types';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import {
    TTRPG_PERSONA_GM_ASSISTANT,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    joinPromptSections,
} from '../infrastructure';
import {
    LADDER_MIN,
    LADDER_MAX,
    IMMEDIATE_LADDER_MIN,
    IMMEDIATE_LADDER_MAX,
    ARC_TICK_DC,
    TYPE_COOLDOWN_SEAMS,
} from './arcConstants';
import { ARC_TYPE_OPTIONS, arcTypeOption } from './arcCatalog';

export type SpawnArcAnchor =
    | { kind: 'agent'; name: string; want: string }
    | { kind: 'thread'; text: string };

export interface SpawnArcInput {
    provider: LLMProvider;
    anchor: SpawnArcAnchor;
    worldContext: string;        // brief: recent scene summary / relevant lore snippet
    suppressedTypes: ArcType[];  // types on cooldown — exclude (ignored when `type` is set)
    bornScene: string;
    // Arc Creator picks. All optional: an unset pick is left to the LLM.
    pace?: ArcPace;              // default 'slow'
    type?: ArcType;              // player-chosen type; overrides the LLM's
    tone?: string;
    guide?: string;              // free-text steer from the player
    currentScene?: string;       // latest GM narration — where an immediate arc opens
}

const VALID_ARC_TYPES: ReadonlySet<ArcType> = new Set<ArcType>(ARC_TYPE_OPTIONS.map(o => o.id));

const GUIDE_MAX_CHARS = 300;

const VALID_ARC_SURFACES: ReadonlySet<ArcSurface> = new Set<ArcSurface>([
    'ambient', 'rumor', 'direct',
]);

function coerceSurface(raw: unknown): ArcSurface {
    if (typeof raw === 'string' && VALID_ARC_SURFACES.has(raw as ArcSurface)) {
        return raw as ArcSurface;
    }
    return 'ambient';
}

function coerceType(raw: unknown, suppressed: Set<ArcType>): ArcType | null {
    if (typeof raw !== 'string') return null;
    if (!VALID_ARC_TYPES.has(raw as ArcType)) return null;
    if (suppressed.has(raw as ArcType)) return null;
    return raw as ArcType;
}

interface SpawnJson {
    title?: unknown;
    type?: unknown;
    seed?: unknown;
    ladder?: unknown;
}

interface ParsedLadderItem {
    label?: unknown;
    surface?: unknown;
}

function asString(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

// Reuse the troublemaker JSON-extract + fallback skeleton. The spawn schema is a
// JSON OBJECT (not an array), so we extract the first {...} block; if that fails
// we fall back to a regex object scan.
function extractSpawnJson(raw: string): SpawnJson | null {
    const cleaned = raw
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?\s*([\s\S]*?)```/i, (_, body: string) => body);

    const start = cleaned.indexOf('{');
    if (start === -1) return null;
    const end = cleaned.lastIndexOf('}');
    if (end === -1 || end <= start) return null;

    try {
        return JSON.parse(cleaned.slice(start, end + 1)) as SpawnJson;
    } catch {
        return null;
    }
}

function ladderBounds(pace: ArcPace): { min: number; max: number } {
    return pace === 'immediate'
        ? { min: IMMEDIATE_LADDER_MIN, max: IMMEDIATE_LADDER_MAX }
        : { min: LADDER_MIN, max: LADDER_MAX };
}

function validateLadder(rawLadder: unknown, pace: ArcPace): ArcStage[] | null {
    if (!Array.isArray(rawLadder)) return null;
    const { min, max } = ladderBounds(pace);
    if (rawLadder.length < min || rawLadder.length > max) return null;

    const stages: ArcStage[] = [];
    for (const item of rawLadder as ParsedLadderItem[]) {
        if (!item || typeof item !== 'object') return null;
        const label = asString(item.label);
        if (label.length === 0) return null;
        stages.push({
            label,
            surface: coerceSurface(item.surface),
        });
    }
    return stages;
}

// Soft skew nudge (NOT a reject): if the LLM gave us a ladder where the last 1–2
// rungs are not 'direct', we don't reject — the prompt already asks for it and the
// contract §4 says this is soft. We leave the authored ladder intact. (A future
// refinement may promote the top rung to 'direct' if it's stuck at 'rumor'.)

function buildSpawnPrompt(input: SpawnArcInput): string {
    const anchorBlock = input.anchor.kind === 'agent'
        ? `[GROUNDING ANCHOR — one NPC the player already knows]
Name: ${input.anchor.name}
What they want: ${input.anchor.want}
The seed must grow out of THIS character's situation — their want, their faction, their relationships — not out of the whole world at once.`
        : `[GROUNDING ANCHOR — one open story thread]
${input.anchor.text}
The seed must grow out of THIS unresolved thread — what it implies, what it pressures, what it will worsen — not out of the whole world at once.`;

    const suppressedLine = input.suppressedTypes.length > 0
        ? input.suppressedTypes.join(', ')
        : '(none)';

    const picksBlock = buildPicksBlock(input);
    const typeRule = input.type
        ? `- TYPE IS FIXED. Use "type": "${input.type}" — the player picked it.`
        : `- AVOID SUPPRESSED TYPES. The type you pick MUST NOT be one of: ${suppressedLine}. Pick a different flavor.`;

    if (input.pace === 'immediate') {
        return buildImmediatePrompt(input, anchorBlock, picksBlock, typeRule);
    }

    return joinPromptSections(
        TTRPG_PERSONA_GM_ASSISTANT,

        `TASK: Author ONE story ARC — a standing condition in the world that worsens over time and will eventually demand the player's attention. Not an encounter. Not a one-scene event. A systemic pressure (economic, political, factional, social, supernatural, criminal, or environmental) that climbs a ladder from a quiet first rumble to a crisis. The arc is GROUNDED in the single anchor below — its seed grows out of that one NPC's want OR that one open thread, not out of the whole world at once.

Output schema — ONE JSON object, no prose, no markdown fences:
{
  "title": "short debug title (not shown to the player as-is)",
  "type":  "economic" | "political" | "factional" | "social" | "supernatural" | "criminal" | "environmental",
  "seed":  "the ONE grounding sentence the ladder grew from (tied to the anchor)",
  "ladder": [
    { "label": "rung 0 — quiet, distant",          "surface": "ambient" },
    { "label": "rung 1",                            "surface": "ambient" | "rumor" },
    ... 5 to 12 rungs total ...
    { "label": "the final crisis rung",            "surface": "direct" }
  ]
}`,

        `RULES — binding:
- SYSTEMIC + INDIRECT, NOT A STRANGER WALKING UP. The seed is a STANDING CONDITION in the world — a harvest failure, a regent's decree, a faction consolidating, a cult spreading, a syndicate cornering a market, a plague rumored in a distant port. It does NOT open with someone approaching the player at their current location. The opening hook is something the player hears about, notices in a price, or learns through rumor — never something that arrives at them.
- WORSENS OVER TIME. Each rung is the same condition one step further along. Rung 0 is distant and quiet; the final rung is the crisis landing in the player's lap. The ladder is the arc — it must feel like ONE thread tightening, not a sequence of unrelated events.
- GROUNDED IN THE ANCHOR ONLY. The seed grows from the single anchor (one NPC's want OR one open thread) below. Do NOT pull in the whole world. The anchor is the root; the ladder is what its consequences become.
- EARLY RUNGS ARE QUIET. The first 1–2 rungs should be 'ambient' (a price shift, a background detail, a distant report). Middle rungs 'rumor' (a merchant mentions it, a traveler brings word). Only the last 1–2 rungs are 'direct' (it arrives in the player's scene — a riot, a lockdown, a death they witness). The crisis is EARNED by the quiet rungs beneath it.
- TROUBLE, NOT A GIFT. The arc is a threat, pressure, complication, ticking-clock, or escalation. Never a free opportunity or a reward.
${typeRule}
- 5–12 RUNGS, NO MORE, NO LESS.
- NO PROSE AROUND THE JSON. No markdown fences. No explanation. Just the object.`,

        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        picksBlock,
        anchorBlock,
        `[WORLD CONTEXT — brief, for grounding only]\n${input.worldContext || '(none)'}`,
    );
}

/** The player's Arc Creator picks, or '' when none were made (joinPromptSections drops empties). */
function buildPicksBlock(input: SpawnArcInput): string {
    const lines: string[] = [];
    const option = input.type ? arcTypeOption(input.type) : undefined;
    if (option) lines.push(`Type: ${option.label} — ${option.guidance}`);
    if (input.tone) lines.push(`Tone: ${input.tone} — every rung carries this tone.`);
    const guide = input.guide?.trim().slice(0, GUIDE_MAX_CHARS);
    if (guide) lines.push(`Player direction: "${guide}" — honor it. Where it conflicts with the anchor, the player direction wins.`);
    if (lines.length === 0) return '';
    return `[ARC CREATOR PICKS — binding]\n${lines.join('\n')}`;
}

function buildImmediatePrompt(input: SpawnArcInput, anchorBlock: string, picksBlock: string, typeRule: string): string {
    const typeIds = ARC_TYPE_OPTIONS.map(o => `"${o.id}"`).join(' | ');
    return joinPromptSections(
        TTRPG_PERSONA_GM_ASSISTANT,

        `TASK: Author ONE story ARC that OPENS IN THE PLAYER'S CURRENT SCENE and keeps developing afterwards. Rung 0 is the hook — something that happens right now, where the player is. The rungs after it are what the same thread becomes over the following scenes, whether the player chases it or turns away.

Output schema — ONE JSON object, no prose, no markdown fences:
{
  "title": "short debug title (not shown to the player as-is)",
  "type":  ${typeIds},
  "seed":  "the ONE sentence the arc grows from, including any hidden truth or catch",
  "ladder": [
    { "label": "rung 0 — the hook, happening in the current scene", "surface": "direct" },
    { "label": "rung 1", "surface": "rumor" | "direct" },
    ... 3 to 8 rungs total ...
    { "label": "the thread's climax", "surface": "direct" }
  ]
}`,

        `RULES — binding:
- RUNG 0 IS THE HOOK, HERE AND NOW. It grows out of the [CURRENT SCENE] below — an interruption, a discovery, a summons, or a detail already present sharpening. It never requires the player to travel first. Write it as a GM note of one or two sentences: what happens and who is involved, not finished prose.
- THE HOOK INVITES. Rung 0 ends at the hook; the player may pursue, delay, or refuse it.
- LATER RUNGS ARE THE SAME THREAD TIGHTENING. Each rung is what the hook becomes one step further on — it spreads ('rumor': word of it reaches the player) or comes back to them ('direct'). Never a list of unrelated events.
- GROUNDED. Use names, places, and factions already in the story. Prefer established NPCs over inventing strangers.
- SURPRISING, NOT RANDOM. Avoid the most predictable version of this event. The seed should hold something the player does not yet know.
${typeRule}
- 3–8 RUNGS. Rung 0 surface MUST be "direct".
- NO PROSE AROUND THE JSON. No markdown fences. No explanation. Just the object.`,

        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        picksBlock,
        `[CURRENT SCENE — WHERE THE PLAYER IS RIGHT NOW]\n${input.currentScene?.trim() || '(unknown — infer from the anchor and world context)'}`,
        anchorBlock,
        `[WORLD CONTEXT — brief, for grounding only]\n${input.worldContext || '(none)'}`,
    );
}

/**
 * Author ONE arc: a systemic, indirect, laddered condition grounded against the
 * single anchor. +1 LLM (the only deliberate cost in the Arc Engine; seam-only via
 * the WO-05 gate). Returns a fully-formed, validated ArcRecord, or null on
 * generation/validation failure (caller skips spawning this seam).
 */
export async function spawnArc(input: SpawnArcInput): Promise<ArcRecord | null> {
    const prompt = buildSpawnPrompt(input);

    let raw: string;
    try {
        raw = await llmCall(input.provider, prompt, { maxTokens: 2000, thinkingEffort: 'low' });
    } catch (err) {
        console.warn('[ArcSpawn] LLM call failed:', err);
        return null;
    }

    const parsed = extractSpawnJson(raw);
    if (!parsed) {
        console.warn('[ArcSpawn] no JSON object found in response');
        return null;
    }

    const pace: ArcPace = input.pace ?? 'slow';
    // A player-picked type is authoritative; otherwise trust the LLM's within the cooldown.
    const type = input.type ?? coerceType(parsed.type, new Set(input.suppressedTypes));
    if (!type) {
        console.warn('[ArcSpawn] rejected: type missing, invalid, or suppressed');
        return null;
    }

    const title = asString(parsed.title);
    const seed = asString(parsed.seed);
    if (title.length === 0 || seed.length === 0) {
        console.warn('[ArcSpawn] rejected: empty title or seed');
        return null;
    }

    const ladder = validateLadder(parsed.ladder, pace);
    if (!ladder) {
        const { min, max } = ladderBounds(pace);
        console.warn(`[ArcSpawn] rejected: ladder length outside ${min}..${max} or malformed`);
        return null;
    }
    // An immediate arc opens in the scene, whatever surface the LLM wrote on rung 0.
    if (pace === 'immediate') ladder[0] = { ...ladder[0], surface: 'direct' };
    const tone = input.tone?.trim();

    return {
        id: uid(),
        type,
        title,
        seed,
        ladder,
        currentRung: 0,
        tickDC: ARC_TICK_DC.initial,
        stance: 'unaware',
        status: 'active',
        bornScene: input.bornScene,
        lastTickScene: input.bornScene,
        ...(input.pace ? { pace } : {}),
        ...(tone ? { tone } : {}),
    };
}

/**
 * Pick the spawn inputs for a MANUAL arc injection (the Arc Creator sheet).
 *
 * Unlike the removed seam gate, this does NOT gate on arcWorldState or an active-arc
 * cap — the player pressing the button IS the signal that they want a new arc
 * ("nothing more reliable than the user"). It only:
 *   - feeds the type cooldown as suppressedTypes (steers toward variety; never blocks),
 *   - picks ONE anchor: freshest open thread → most-pressured NPC's want → a fallback
 *     snippet (so a press always has something to ground on once any story exists).
 *
 * Returns the spawn input minus `provider`, or null only if there is genuinely nothing
 * to anchor against (brand-new campaign, no threads / NPCs / fallback text). Pure, +0.
 */
export function pickArcSpawnInput(params: {
    arcs: ArcRecord[];
    openThreads: { text: string }[];
    pressure: Record<string, NPCPressure>;
    npcLedger: NPCEntry[];
    worldContext: string;
    bornScene: string;
    nowScene: number;
    fallbackAnchorText?: string;
}): Omit<SpawnArcInput, 'provider'> | null {
    const { arcs, openThreads, pressure, npcLedger, worldContext, bornScene, nowScene, fallbackAnchorText } = params;

    // Type cooldown → suppressedTypes only (variety steer). Never blocks the press.
    const suppressedTypes = new Set<ArcType>();
    for (const a of arcs) {
        const born = parseInt(a.bornScene, 10);
        if (Number.isFinite(born) && nowScene - born < TYPE_COOLDOWN_SEAMS) {
            suppressedTypes.add(a.type);
        }
    }

    // Anchor: freshest open thread → most-pressured NPC → fallback snippet.
    let anchor: SpawnArcAnchor | null = null;
    if (openThreads.length > 0) {
        anchor = { kind: 'thread', text: openThreads[openThreads.length - 1].text };
    } else {
        let best: NPCEntry | null = null;
        let bestScore = 0;
        for (const npc of npcLedger) {
            const p = pressure[npc.id];
            if (!p) continue;
            const score = (p.ignored ?? 0) + (p.engaged ?? 0);
            if (score > bestScore) { bestScore = score; best = npc; }
        }
        if (best) {
            const want = best.wants?.long?.[0] ?? best.wants?.medium?.[0] ?? best.storyRelevance ?? 'unknown';
            anchor = { kind: 'agent', name: best.name, want };
        } else if (fallbackAnchorText && fallbackAnchorText.trim()) {
            anchor = { kind: 'thread', text: fallbackAnchorText.trim().slice(0, 400) };
        }
    }
    if (!anchor) return null;

    return { anchor, worldContext, suppressedTypes: Array.from(suppressedTypes), bornScene };
}