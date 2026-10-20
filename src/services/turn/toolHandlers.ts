import type { LoreChunk, NotebookNote, OpenAITool, DiceSystemConfig, DieType } from '../../types';
import { searchLoreByQuery } from '../lore';
import { uid } from '../../utils/uid';
import { mapTier } from '../engine';

// Scene notebook limits. The story model has no notebook tool; the auxiliary model
// edits the notebook after each turn through parseNotebookActions +
// applyNotebookActions (sceneNotebookMaintenance.ts).
export const MAX_NOTEBOOK_OPS = 5;
export const MAX_NOTEBOOK_NOTES = 50;

export type ToolContext = {
    loreChunks: LoreChunk[];
};

export type LoreHandlerResult = {
    toolResult: string;
};

export type NotebookAction = { op: 'add' | 'remove' | 'clear'; text?: string };

export type DiceHandlerResult = {
    toolResult: string;
};

const BASE_TOOLS = [
    {
        type: 'function' as const,
        function: {
            name: 'query_campaign_lore',
            description: 'Search the Game Master notes for specific lore, rules, characters, or locations. Do NOT call this sequentially or spam it. If no relevant lore is found, immediately proceed with the narrative response. IMPORTANT: You MUST use the standard JSON tool call format. NEVER output raw XML <|DSML|> tags in your response text.',
            parameters: {
                type: 'object' as const,
                properties: { query: { type: 'string' as const, description: 'The specific search query' } },
                required: ['query'],
            },
        },
    },
] as const;

const ROLL_DICE_TOOL = {
    type: 'function' as const,
    function: {
        name: 'roll_dice',
        description:
            "Roll dice when the player attempts an action with an uncertain outcome — combat hits, ability/skill checks, saves, contested actions. Do NOT call for descriptive moments, dialogue, or trivial actions. Mundane actions resolve as plain success without a roll.\n\n" +
            "Call roll_dice BEFORE narrating the outcome, then use the returned `tier` to shape the narrative.\n\n" +
            "Trigger: Player attempts an action with an uncertain outcome — combat hits, skill checks, saves, contested actions.\n" +
            "1. Identify core intent of the player's action.\n" +
            "2. If the outcome depends on chance, CALL `roll_dice` BEFORE narrating. Do NOT narrate the outcome first.\n" +
            "   - `dice`: use the die type appropriate to the category (e.g. Combat→d20, Social→d6, Perception→d6). Use `NdM` form (e.g. 2d6, 1d100). Optionally add `+N` or `-N` modifier.\n" +
            "   - `reason`: short label (e.g. \"Stealth check vs guard\", \"Longsword attack\")\n" +
            "   - `category`: one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane (used for d20 tier mapping only)\n" +
            "3. Use the returned `tier` (outcome band label, e.g. Catastrophe / Failure / Success / Triumph / Narrative Boon) to shape the narrative. If no tier is returned (non-d20 rolls without configured bands), interpret the raw `result` per the campaign's Action Resolution rules.\n" +
            "4. Do NOT call `roll_dice` for descriptive moments, dialogue, or trivial actions.\n\n" +
            "Advantage: if the player explicitly leverages a known weakness or superior tool, call `roll_dice` twice and use the higher result. If explicitly impaired (blinded, wounded, overwhelmed), call twice and use the lower. Otherwise, single roll.\n\n" +
            "Outcome band semantics (when tier is returned):\n" +
            "- Catastrophe: severe unexpected failure, consequences beyond simple loss.\n" +
            "- Failure: fails. Damage, setback, or resource loss.\n" +
            "- Success: succeeds exactly as intended.\n" +
            "- Triumph: succeeds with an unexpected additional benefit.\n" +
            "- Narrative Boon: flawless. Massive strategic or narrative advantage.\n" +
            "Other custom bands: interpret per the campaign's Action Resolution rules.",
        parameters: {
            type: 'object' as const,
            properties: {
                dice:     { type: 'string' as const, description: "Dice expression: '1d20', '2d6', '1d100', '1d4', optionally with '+N' or '-N' modifier. Use the die type matching the action's category." },
                reason:   { type: 'string' as const, description: "Short label, e.g. 'Stealth check vs guard' or 'Longsword attack'" },
                category: { type: 'string' as const, enum: ['Combat','Perception','Stealth','Social','Movement','Knowledge','Mundane'], description: 'Skill category for tier mapping (used for d20 only)' }
            },
            required: ['dice', 'reason']
        }
    }
} as const;

export function getToolDefinitions(opts: { allowDiceTool: boolean }) {
    return [...BASE_TOOLS as unknown as OpenAITool[], ...(opts.allowDiceTool ? [ROLL_DICE_TOOL] as unknown as OpenAITool[] : [])];
}

export const TOOL_DEFINITIONS = BASE_TOOLS;

export function handleLoreTool(
    toolArguments: string,
    ctx: ToolContext
): LoreHandlerResult {
    let query = '';
    try { query = JSON.parse(toolArguments).query || ''; } catch { /* ignore */ }

    let toolResult = 'No relevant lore found.';
    if (query) {
        const found = searchLoreByQuery(ctx.loreChunks, query);
        if (found.length > 0) {
            toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
        }
    }

    return { toolResult };
}

/**
 * Validate notebook edits in the `{ actions: [{ op: 'add' | 'remove' | 'clear', text? }] }`
 * schema the old update_scene_notebook tool used. Takes the parsed object or its
 * JSON string. Drops unknown ops and add/remove without text, and keeps at most
 * MAX_NOTEBOOK_OPS actions; anything malformed yields no actions.
 */
export function parseNotebookActions(raw: unknown): NotebookAction[] {
    let value = raw;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return []; }
    }
    const list = (value as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(list)) return [];

    const actions: NotebookAction[] = [];
    for (const item of list) {
        if (actions.length >= MAX_NOTEBOOK_OPS) break;
        if (!item || typeof item !== 'object') continue;
        const { op, text: rawText } = item as { op?: unknown; text?: unknown };
        const text = typeof rawText === 'string' ? rawText.trim() : '';
        if (op === 'clear') actions.push({ op });
        else if ((op === 'add' || op === 'remove') && text) actions.push({ op, text });
    }
    return actions;
}

/**
 * Apply notebook edits in order and return the new notebook (the input is not
 * mutated). add skips a note that is already there and stops at
 * MAX_NOTEBOOK_NOTES; remove deletes the first note matching the text (exact,
 * then substring, ignoring case); clear wipes the list.
 */
export function applyNotebookActions(notebook: NotebookNote[] | undefined, actions: NotebookAction[]): NotebookNote[] {
    const next = [...(notebook ?? [])];
    for (const action of actions.slice(0, MAX_NOTEBOOK_OPS)) {
        const text = action.text?.trim() ?? '';
        const lower = text.toLowerCase();
        if (action.op === 'add' && text) {
            if (next.length >= MAX_NOTEBOOK_NOTES) continue;
            if (next.some(n => n.text.trim().toLowerCase() === lower)) continue;
            next.push({ id: uid(), text, timestamp: Date.now() });
        } else if (action.op === 'remove' && text) {
            let idx = next.findIndex(n => n.text.trim().toLowerCase() === lower);
            if (idx === -1) idx = next.findIndex(n => n.text.toLowerCase().includes(lower));
            if (idx !== -1) next.splice(idx, 1);
        } else if (action.op === 'clear') {
            next.length = 0;
        }
    }
    return next;
}

function parseAndRoll(expr: string): { total: number; breakdown: string; sides: number; count: number; rawSum: number } {
    const match = expr.trim().toLowerCase().match(/^(\d+)d(\d+)([+-]\d+)?$/);
    if (!match) {
        // Fallback: d20 single roll (legacy default)
        const single = Math.floor(Math.random() * 20) + 1;
        return { total: single, breakdown: `${single}`, sides: 20, count: 1, rawSum: single };
    }
    const count = Math.min(parseInt(match[1], 10), 100);
    const sides = parseInt(match[2], 10);
    const modifier = match[3] ? parseInt(match[3], 10) : 0;
    const rolls: number[] = [];
    for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
    const rawSum = rolls.reduce((a, b) => a + b, 0);
    const total = rawSum + modifier;
    const breakdown = modifier !== 0 ? `[${rolls.join('+')}]${modifier > 0 ? '+' : ''}${modifier} = ${total}` : `[${rolls.join('+')}] = ${total}`;
    return { total, breakdown, sides, count, rawSum };
}

export function handleDiceTool(
    toolArguments: string,
    ctx: { diceSystem?: DiceSystemConfig | null }
): DiceHandlerResult {
    let args: { dice?: string; reason?: string; category?: string } = {};
    try { args = JSON.parse(toolArguments); } catch { /* ignore */ }

    const { total, breakdown, sides, rawSum } = parseAndRoll(args.dice ?? '1d20');

    // Look up the DieType by face count for tier mapping. Tier is mapped from the
    // raw die sum (before modifier) — bands cover 1..faces, so a modifier that
    // pushes the total above `faces` must not yield null. The result field still
    // reports the modified total.
    let tier: string | null = null;
    if (ctx.diceSystem) {
        const dieType: DieType | undefined = ctx.diceSystem.dieTypes.find(d => d.faces === sides);
        if (dieType) tier = mapTier(rawSum, dieType);
    }

    const payload: Record<string, unknown> = {
        dice: args.dice ?? '1d20',
        reason: args.reason ?? '',
        result: total,
        breakdown
    };
    if (tier) payload.tier = tier;

    return { toolResult: JSON.stringify(payload) };
}
