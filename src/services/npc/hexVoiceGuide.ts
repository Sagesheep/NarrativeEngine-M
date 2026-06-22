import type { HexAxis, PersonalityHex } from '../../types';

// NPC Generation Refit (Phase 1) — WO-5 render voice guide.
//
// The render prompt gets explicit axis-keyed voice direction DERIVED from the rolled hex, so
// `exampleOutput`/`voice` become a function of the numbers instead of a generic "gritty
// survivor" default. For each axis at |value| >= 2, emit a line like:
//   composure -3 → speech cracks/spikes under stress
//   warmth -2 → no pleasantries, blunt
// The phrases are setting-agnostic (true in a dungeon or a megacity); the render model reskins
// them into world flavour. Axes inside the |1| band give no line (they're not extreme enough to
// dictate voice).

// Per-axis, per-sign phrases at |2| and |3|. [sign][magnitude] → phrase.
const PHRASES: Record<HexAxis, { pos: string[]; neg: string[] }> = {
    drive: {
        pos: ['relentless drive colors every sentence; talks about next steps, rarely idle', 'single-minded, pushes the conversation toward their aim'],
        neg: ['listless, drifts between topics; little forward pull in speech', 'no ambition surfaces; deflects talk of the future'],
    },
    diligence: {
        pos: ['precise word choice; corrects small details, names things exactly', 'exacting and structured; speaks in ordered clauses'],
        neg: ['sloppy phrasing; half-finished thoughts, drops details', 'negligent about accuracy; says whatever is close enough'],
    },
    boldness: {
        pos: ['bold, says the thing others won\'t; interrupts', 'reckless, no filter between thought and mouth'],
        neg: ['timid, hedges every claim with qualifiers', 'shrinks from assertion; waits for permission to speak'],
    },
    warmth: {
        pos: ['effusive, hands warmth into every greeting', 'openly affectionate; personalizes quickly'],
        neg: ['no pleasantries, blunt', 'frigid reception; cuts to transactional business'],
    },
    empathy: {
        pos: ['reads the room; mirrors the other\'s feeling back in words', 'compassionate phrasing; asks after others unprompted'],
        neg: ['callous framing; describes people as problems to solve', 'hard, ignores emotional subtext entirely'],
    },
    composure: {
        pos: ['unflappable cadence; even tempo under pressure', 'serene, unhurried even when pressed'],
        neg: ['tense, clipped; restarts sentences when pressed', 'speech cracks/spikes under stress'],
    },
};

/**
 * Build the axis-keyed voice directive for the render prompt. Returns one line per axis at
 * |value| >= 2, formatted `axis value → phrase`. Empty string when no axis is extreme (the
 * render model then has no numeric voice constraint, which is fine).
 */
export function buildVoiceDirective(hex: PersonalityHex): string {
    const lines: string[] = [];
    const axes: HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
    for (const axis of axes) {
        const v = Math.round(hex[axis]);
        if (Math.abs(v) < 2) continue;
        const map = PHRASES[axis];
        const phrase = v > 0 ? map.pos[v - 2] ?? map.pos[1] : map.neg[-v - 2] ?? map.neg[1];
        lines.push(`${axis} ${v} → ${phrase}`);
    }
    return lines.length > 0 ? lines.join('\n') : '';
}