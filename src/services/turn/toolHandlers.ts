import type { LoreChunk, NotebookNote, OpenAITool, DiceSystemConfig, DieType } from '../../types';
import { searchLoreByQuery } from '../lore';
import { uid } from '../../utils/uid';
import { mapTier } from '../engine';

const MAX_NOTEBOOK_OPS = 5;
const MAX_NOTEBOOK_NOTES = 50;

export type ToolContext = {
    loreChunks: LoreChunk[];
    notebook: NotebookNote[];
};

export type LoreHandlerResult = {
    toolResult: string;
};

export type NotebookHandlerResult = {
    toolResult: string;
    updatedNotebook: NotebookNote[];
};

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
    {
        type: 'function' as const,
        function: {
            name: 'update_scene_notebook',
            description: 'Update the scene notebook for tracking temporary state — active spells, timers, NPC positions, environmental conditions. Actions: add (create note), remove (delete by text match), clear (wipe all). Max 50 notes, max 5 actions per call. Use sparingly — only for volatile scene state that changes within a scene.',
            parameters: {
                type: 'object' as const,
                properties: {
                    actions: {
                        type: 'array' as const,
                        items: {
                            type: 'object' as const,
                            properties: {
                                op: { type: 'string' as const, enum: ['add', 'remove', 'clear'] },
                                text: { type: 'string' as const, description: 'Note text (ignored for clear op)' },
                            },
                            required: ['op'],
                        },
                        description: 'Array of notebook actions to perform (max 5)',
                        maxItems: 5,
                    },
                },
                required: ['actions'],
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

export function handleNotebookTool(
    toolArguments: string,
    ctx: ToolContext
): NotebookHandlerResult {
    let notebookActions: { op: string; text?: string }[] = [];
    try { notebookActions = JSON.parse(toolArguments).actions || []; } catch { /* ignore */ }

    const currentNotebook = [...(ctx.notebook ?? [])];
    let opsCount = 0;

    for (const action of notebookActions) {
        if (opsCount >= MAX_NOTEBOOK_OPS) break;
        if (action.op === 'add' && action.text && currentNotebook.length < MAX_NOTEBOOK_NOTES) {
            currentNotebook.push({ id: uid(), text: action.text.trim(), timestamp: Date.now() });
        } else if (action.op === 'remove' && action.text) {
            const searchLower = action.text.toLowerCase().trim();
            const idx = currentNotebook.findIndex(n => n.text.toLowerCase().includes(searchLower));
            if (idx !== -1) currentNotebook.splice(idx, 1);
        } else if (action.op === 'clear') {
            currentNotebook.length = 0;
        }
        opsCount++;
    }

    const toolResult = `Notebook updated. ${currentNotebook.length} notes active.`;
    console.log(`[Notebook] Updated: ${currentNotebook.length} notes active (${opsCount} ops)`);

    return { toolResult, updatedNotebook: currentNotebook };
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
