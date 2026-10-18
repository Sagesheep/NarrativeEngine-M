// Absolute Command v1 — pure module. No store, no I/O. Port of mainApp's
// services/turn/absoluteCommand.ts.
//
// A one-turn escape hatch: the player authors a binding out-of-character
// instruction; that turn runs with the Director Brief suppressed
// and the command placed LAST in the prompt
// (after the user message) at maximum recency, explicitly outranking every
// other directive.

/** Keeps the block small for local 8k story models. */
export const ABSOLUTE_COMMAND_MAX_CHARS = 800;

/** Trim, collapse whitespace, slice to the max, append an ellipsis on truncation. */
export function clampAbsoluteCommand(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length <= ABSOLUTE_COMMAND_MAX_CHARS
        ? normalized
        : `${normalized.slice(0, ABSOLUTE_COMMAND_MAX_CHARS - 3).trimEnd()}...`;
}

/** The binding OOC block appended LAST in the final user message. `''` for
 *  undefined/empty input. Scoped to this turn: it travels as a buildPayload
 *  parameter, never on the stored user message, so it never persists. */
export function buildAbsoluteCommandBlock(text: string | undefined): string {
    const clamped = clampAbsoluteCommand(text ?? '');
    if (!clamped) return '';
    return `[USER ABSOLUTE COMMAND — OUT OF CHARACTER, BINDING]
The player is speaking to you directly as the author of this story, not as their character. What follows is an instruction about how to write this turn. It is not a fictional utterance and no character hears it.

Obey it exactly and completely. For this turn it outranks every other directive in this prompt — including the reasoning framework's audit criteria, NPC agency and push-back defaults, staleness and friction pressure, and any standing GM guidance. Where anything conflicts with this command, this command wins.

Do not argue with it, soften it, hedge it, or apply it only partly. Do not have a character resist in order to avoid carrying it out. Do not acknowledge the command, quote it, or reveal that an out-of-character instruction was given. Apply it silently and write the scene.

COMMAND: ${clamped}
[END ABSOLUTE COMMAND]`;
}
