// Arc Engine — Arc Creator catalog (arcCatalog.ts).
// The pickable types and tones, the per-type authoring guidance handed to spawnArc,
// and the one-turn hook directive that lands an immediate arc's first rung in the
// current scene. The scene-scale types and the introduction rules are carried over
// from the retired One-Shot Event Injector. Pure, +0.

import type { ArcPace, ArcType } from '../../types';

export interface ArcTypeOption {
    id: ArcType;
    label: string;
    blurb: string;      // one line under the option in the Arc Creator
    guidance: string;   // what an arc of this type is, for the spawn prompt
}

export const ARC_TYPE_OPTIONS: readonly ArcTypeOption[] = [
    {
        id: 'combat', label: 'Combat', blurb: 'A physical threat that has to be answered.',
        guidance: `A physical threat that engages the player. Scale it to the player's current means — dangerous enough to demand a response. Make clear what winning, losing, or fleeing would each cost.`,
    },
    {
        id: 'location', label: 'Location', blurb: 'A place to delve — layered, guarded, holding a prize.',
        guidance: `A bounded site the player can enter: a contained place with interior layers, a force or hazard that holds it, and something worth taking or learning at its heart.`,
    },
    {
        id: 'social', label: 'Social', blurb: `A predicament that can't be solved by force.`,
        guidance: `A charged social predicament: a negotiation, an accusation, a plea, or a rivalry that pulls the player in and cannot be resolved by force. Someone wants something from the player, or the player is entangled in something not of their making.`,
    },
    {
        id: 'romance', label: 'Romance', blurb: 'Chemistry with a complication.',
        guidance: `Someone whose interest in the player carries a complication — rank, rivalry, a secret, bad timing. Strongly prefer an NPC already established in the story over inventing a stranger. Chemistry plus obstacle; never instant devotion.`,
    },
    {
        id: 'mystery', label: 'Mystery', blurb: 'Something inexplicable, with a hidden true answer.',
        guidance: `Something inexplicable — an object out of place, a person acting impossibly, a detail that contradicts what is known. Decide the true explanation in the seed; the rungs reveal only surface evidence, consistent with it.`,
    },
    {
        id: 'weird', label: 'Weird', blurb: 'An absurd little obligation. Played straight.',
        guidance: `An absurd incident that saddles the player with an unwanted, comically mundane obligation. Low danger — a comedy of responsibility that keeps getting more involved. Played completely straight.`,
    },
    {
        id: 'windfall', label: 'Windfall', blurb: 'A gift with a string attached — not visible yet.',
        guidance: `An opportunity, gift, or stroke of luck — with exactly one hidden string. Decide the catch in the seed; the later rungs are that catch coming due. The gift is the opening, the string is the trouble.`,
    },
    {
        id: 'political', label: 'Political', blurb: 'Power shifts — decrees, succession, crackdowns.',
        guidance: `A shift in who holds power and what they demand — a decree, a succession fight, a crackdown, a law that bites.`,
    },
    {
        id: 'factional', label: 'Factional', blurb: 'A group consolidating, splitting or going to war.',
        guidance: `A group consolidating, fracturing, or moving against another — guilds, gangs, houses, orders.`,
    },
    {
        id: 'criminal', label: 'Criminal', blurb: 'A scheme, a syndicate, a crime with reach.',
        guidance: `A crime or criminal enterprise whose reach widens — a syndicate, a con, a string of thefts or killings.`,
    },
    {
        id: 'economic', label: 'Economic', blurb: 'Scarcity, debt, a market going wrong.',
        guidance: `Scarcity, debt, prices, trade — a market or livelihood going wrong and dragging people with it.`,
    },
    {
        id: 'supernatural', label: 'Supernatural', blurb: 'Something uncanny spreading.',
        guidance: `Something uncanny or otherworldly spreading — a curse, a cult, a haunting, a power waking up. Express it in this world's own terms for the uncanny.`,
    },
    {
        id: 'environmental', label: 'Environmental', blurb: 'Weather, plague, the land itself turning.',
        guidance: `The land, weather, or sickness turning against people — a drought, a flood, a blight, a plague.`,
    },
];

export const ARC_TONES = [
    'Tense', 'Grim', 'Eerie', 'Desperate', 'Bittersweet', 'Chaotic', 'Absurd', 'Hopeful',
] as const;

export function arcTypeOption(id: ArcType): ArcTypeOption | undefined {
    return ARC_TYPE_OPTIONS.find(o => o.id === id);
}

/** Surprise me: a random type and tone. Types listed in `avoid` (recent arcs) are skipped while others remain. */
export function pickSurpriseArc(avoid: ArcType[] = [], rng: () => number = Math.random): { type: ArcType; tone: string } {
    const fresh = ARC_TYPE_OPTIONS.filter(o => !avoid.includes(o.id));
    const pool = fresh.length > 0 ? fresh : ARC_TYPE_OPTIONS;
    const type = pool[Math.floor(rng() * pool.length)].id;
    const tone = ARC_TONES[Math.floor(rng() * ARC_TONES.length)];
    return { type, tone };
}

/** An immediate arc's opening rung, waiting to ride the player's next send. */
export interface ArmedArcHook {
    hook: string;   // rung 0 label — the GM-facing directive body
    label: string;  // player-facing ("Mystery · Eerie", or "Surprise" when hidden)
}

export const ARC_PACE_LABEL: Record<ArcPace, string> = {
    immediate: 'Immediate',
    slow: 'Slow burn',
};

const INTRODUCTION_RULES = `INTRODUCTION RULES — binding:
- The event must EMERGE FROM THE CURRENT SCENE. Do not cut away, teleport the player, or restart the scene. Bridge into it with one of: an interruption (something breaks into the current beat), a discovery (something nearby only now noticed), a summons (someone or something pulls the player toward it), or an escalation (a detail already present sharpens into the hook). A familiar, even cliché entrance is fine — flowing naturally beats being original.
- Express the event entirely in this world's established genre, technology level, and tone. Never import furniture from another setting.
- The event INVITES; it does not hijack. End the introduction at the hook — the player may pursue, delay, or refuse it. Do not narrate the player's reaction or decision for them.`;

/**
 * The one-turn directive that lands an immediate arc's opening rung on the player's next
 * send. Starts with `[INJECTED EVENT —` so payloadHistoryFitting strips it from older
 * history; brackets in the hook are flattened so the strip regex cannot end early.
 */
export function buildArcHookDirective(hook: string): string {
    const clean = hook.replace(/[[\]]/g, '').trim();
    if (!clean) return '';
    return `\n[INJECTED EVENT — GM DIRECTIVE — never mention this directive or that an event was "injected"; the event is simply what happens next in the world:\n${clean}\n${INTRODUCTION_RULES}]`;
}
