// Arc Engine — WO-04 stance scan (arcStance.ts).
// Pure, deterministic, +0 LLM. Extends the scanPressure / runNPCPressureScan pattern
// to arcs: for each active arc, classify the player's stance THIS turn against it
// (opposed / aided / ignored / fled / unaware) by keyword + verb heuristic over the
// player's input and the GM narration.
//
// Returns ONLY arcs whose stance is determinable this turn; the caller writes the
// returned stance onto arc.stance. Arcs not returned keep their previous stance
// (the default at spawn is 'unaware').
//
// UPGRADE PATH (do NOT build now — flagged per WO-04 spec): if the deterministic
// keyword heuristic proves too crude in playtest, the sanctioned upgrade is to FOLD
// this scan into an existing utility LLM call (still +0 net) — e.g. extend the
// retrieval planner or the seal-audit call that already runs at the seam to also
// tag each active arc's stance in one batched pass. The signature stays the same;
// only the implementation flips from keyword to LLM-assisted. Keep the keyword
// version as the deterministic fallback.

import type { ArcRecord, ArcStance } from '../../types';

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary match — mirrors scanPressure.mentionsName. Bare substring matching
// caused short common words (e.g. "market" inside "supermarket") to false-positive.
function wordBoundaryMatch(text: string, patterns: string[]): boolean {
    const lower = text.toLowerCase();
    return patterns.some(p => {
        if (!p || p.length < 3) return false;
        return new RegExp(`\\b${escapeRegExp(p)}\\b`).test(lower);
    });
}

// Significant-word extraction from an arc's text fields. Splits on non-letter,
// drops stopwords + very short tokens. Used to detect whether the arc is "on the
// player's mind" this turn (the scanPressure name-mention equivalent).
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'for',
    'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'this',
    'that', 'these', 'those', 'has', 'have', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'from', 'into', 'over',
    'under', 'about', 'as', 'if', 'then', 'so', 'no', 'not', 'yes', 'their',
    'they', 'them', 'his', 'her', 'him', 'its', 'our', 'your', 'my', 'i', 'you',
    'he', 'she', 'we', 'who', 'which', 'what', 'when', 'where', 'how', 'why',
    'all', 'any', 'some', 'more', 'most', 'such', 'than', 'too', 'very', 'just',
]);

function extractKeywords(...texts: string[]): string[] {
    const out = new Set<string>();
    for (const text of texts) {
        if (!text) continue;
        const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        for (const t of tokens) {
            if (t.length < 4) continue;            // skip short tokens (cuts noise)
            if (STOPWORDS.has(t)) continue;
            out.add(t);
        }
    }
    return Array.from(out);
}

// Stance verb lists — the deterministic signal. Mirrors scanPressure.directsActionAt
// (a fixed phrase list scanned against the player input). Order matters: the first
// category that hits wins (opposed > aided > fled > ignored — active resistance is
// the loudest signal, then active help, then avoidance, then dismissal).
const STANCE_VERBS: Array<{ stance: ArcStance; verbs: string[] }> = [
    {
        stance: 'opposed',
        verbs: [
            'fight', 'oppose', 'resist', 'stop', 'prevent', 'defeat', 'attack',
            'counter', 'block', 'sabotage', 'undermine', 'strike', 'confront',
            'thwart', 'quell', 'suppress', 'crush', 'dismantle', 'disrupt', 'foil',
        ],
    },
    {
        stance: 'aided',
        verbs: [
            'help', 'aid', 'assist', 'support', 'fund', 'ally', 'join', 'back',
            'protect', 'accelerate', 'further', 'supply', 'equip', 'invest',
            'endorse', 'champion', 'bolster', 'abet', 'facilitate', 'promote',
        ],
    },
    {
        stance: 'fled',
        verbs: [
            'flee', 'run', 'retreat', 'escape', 'avoid', 'withdraw', 'pull back',
            'get away', 'get out', 'bug out', 'flee from', 'run from', 'back away',
            'slip away', 'duck out', 'lay low',
        ],
    },
    {
        stance: 'ignored',
        verbs: [
            'ignore', 'disregard', 'dismiss', 'skip', 'pass on', 'look away',
            'walk away', 'brush off', 'shrug off', 'pay no mind', 'tune out',
            'not my problem', 'leave it', 'let it be', 'write off', 'wash my hands',
        ],
    },
];

function classifyStance(playerInput: string): ArcStance | null {
    const lower = playerInput.toLowerCase();
    for (const { stance, verbs } of STANCE_VERBS) {
        for (const v of verbs) {
            if (lower.includes(v)) return stance;
        }
    }
    return null;
}

/**
 * Deterministic stance scan. For each active arc, detect whether the arc is "on the
 * player's mind" this turn (a significant keyword from the arc's title/seed/current
 * rung label appears in the player's input), and if so classify the stance from the
 * stance verbs in the player input. Returns only arcs with a determinable stance.
 *
 * Mirrors scanPressure's word-boundary + verb-near-name pattern. The GM text is used
 * only as a secondary mention signal (the GM surfaced the arc this turn but the
 * player didn't name it themselves — still counts as "on the player's mind" if the
 * player's input carries a stance verb).
 */
export function scanArcStance(
    playerInput: string,
    gmText: string,
    activeArcs: ArcRecord[],
): { arcId: string; stance: ArcStance }[] {
    const out: { arcId: string; stance: ArcStance }[] = [];
    if (!activeArcs || activeArcs.length === 0) return out;

    const stanceVerb = classifyStance(playerInput);

    for (const arc of activeArcs) {
        if (arc.status !== 'active') continue;

        const currentRungLabel = arc.ladder[arc.currentRung]?.label ?? '';
        const keywords = extractKeywords(arc.title, arc.seed, currentRungLabel);
        if (keywords.length === 0) continue;

        const playerMentioned = wordBoundaryMatch(playerInput, keywords);
        const gmMentioned = wordBoundaryMatch(gmText, keywords);

        // The arc must be "on the player's mind" — either the player named it
        // directly, OR the GM surfaced it this turn AND the player's input carries
        // a stance verb (a generic "I ignore that" reply to a GM mention). Bare
        // GM mention with no player stance verb is not enough — the player may be
        // unaware, and we leave the prior stance in place.
        if (!playerMentioned && !(gmMentioned && stanceVerb)) continue;

        // If the arc was mentioned but no stance verb is present, the stance is
        // indeterminate this turn — don't return (caller keeps the prior stance).
        if (!stanceVerb) continue;

        out.push({ arcId: arc.id, stance: stanceVerb });
    }

    return out;
}