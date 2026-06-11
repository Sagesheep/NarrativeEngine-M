import type { AppSettings, ArchiveChapter, DivergenceRegister, NPCEntry, PayloadTrace } from '../../types';
import { countTokens } from '../infrastructure';
import { renderRegisterForPayload } from '../campaign-state';
import type { BudgetMap } from './payloadBudgeter';

const TOOL_MODE_ACTION_RESOLUTION = `### ACTION RESOLUTION

Trigger: Player attempts an action with an uncertain outcome — combat hits, skill checks, saves, contested actions.

1. Identify core intent of the player's action.
2. If the outcome depends on chance, CALL the \`roll_dice\` tool BEFORE narrating. Do NOT narrate the outcome first.
   - \`dice\`: typically \`1d20\` for skill checks/attacks; use \`NdM\` form for damage or special rolls
   - \`reason\`: short label (e.g. "Stealth check vs guard", "Longsword attack")
   - \`category\`: one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane (for d20 only)
3. Use the returned \`tier\` (Catastrophe / Failure / Success / Triumph / Narrative Boon) to shape the narrative — same outcome semantics as pool mode.
4. Do NOT call \`roll_dice\` for descriptive moments, dialogue, or trivial actions. Mundane actions resolve as plain success without a roll.

**Advantage selection (tool mode):** if the player explicitly leverages a known weakness or superior tool, call \`roll_dice\` twice and use the higher result. If explicitly impaired (blinded, wounded, overwhelmed), call twice and use the lower. Otherwise, single roll.

**Outcomes:**
- Catastrophe: severe unexpected failure, consequences beyond simple loss.
- Failure: fails. Damage, setback, or resource loss.
- Success: succeeds exactly as intended.
- Triumph: succeeds with an unexpected additional benefit.
- Narrative Boon: flawless. Massive strategic or narrative advantage.`;

function swapActionResolutionForToolMode(rules: string): string {
    const marker = '### ACTION RESOLUTION';
    const idx = rules.indexOf(marker);
    if (idx === -1) return rules;
    const nextSectionMatch = rules.substring(idx + marker.length).match(/\n### /);
    const endIdx = nextSectionMatch ? idx + marker.length + nextSectionMatch.index! : rules.length;
    return rules.substring(0, idx) + TOOL_MODE_ACTION_RESOLUTION + rules.substring(endIdx);
}

export interface StableContentResult {
    stableContent: string;
    stableTokens: number;
    divergenceContent: string;
    divergenceTokens: number;
    retrievedRulesContent?: string;
}

export function buildStablePreamble(opts: {
    settings: AppSettings;
    context: { rulesRaw?: string; starterActive?: boolean; starter?: string; continuePromptActive?: boolean; continuePrompt?: string; diceFairnessActive?: boolean };
    relevantRules?: { header: string; content: string }[];
    budgetMap: BudgetMap;
    addTrace: (t: PayloadTrace) => void;
}): StableContentResult {
    const { settings, context, relevantRules, budgetMap, addTrace } = opts;

    const stableParts: string[] = [];
    let retrievedRulesContent: string | undefined;
    if (context.rulesRaw) {
        const rulesTokenCount = countTokens(context.rulesRaw);
        const rulesBudgetTokens = budgetMap.rules;
        const threshold = Math.floor(rulesBudgetTokens * 1.2);

        if (relevantRules && relevantRules.length > 0 && rulesTokenCount > threshold) {
            const rulesText = relevantRules.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
            retrievedRulesContent = `[RULES — RETRIEVED SECTIONS]\n${rulesText}\n[END RULES]`;
        } else {
            let rules = context.rulesRaw;
            if (context.diceFairnessActive === false) {
                rules = swapActionResolutionForToolMode(rules);
            }
            // Verbatim fallback (rules RAG returned nothing or is disabled). Hard-cap
            // it so a huge rules file can't blow the whole context budget when RAG
            // silently misses (AUDIT F6). Small files stay whole — cap ≥ rulesTokenCount.
            const cap = Math.floor(rulesBudgetTokens * 1.2);
            if (rulesTokenCount > cap) {
                const maxChars = cap * 4; // ~4 chars/token; coarse but bounded
                rules = rules.slice(0, maxChars) +
                    '\n\n[RULES TRUNCATED — exceeded rules budget; enable rules RAG for full coverage]';
                console.warn(`[Payload] verbatim rules fallback truncated: ${rulesTokenCount}t > ${cap}t cap`);
            }
            stableParts.push(rules);
        }
    }
    if (context.starterActive && context.starter) stableParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) stableParts.push(context.continuePrompt);

    const activePreset = settings.presets.find(p => p.id === settings.activePresetId);
    const storyProvider = activePreset ? settings.providers.find(p => p.id === activePreset.storyAIProviderId) : undefined;
    const modelName = storyProvider?.modelName ?? '';
    const isReasoningModel = /deepseek-r|qwq|qwen.*think|r1/i.test(modelName);
    if (isReasoningModel) {
        stableParts.push("IMPORTANT: If you use a 'thinking' or 'reasoning' block (<think>...</think>), you MUST still provide the full narrative response AFTER the closing tag. Never end a turn with only a thinking block.");
    }

    stableParts.push(
        '[NPC KNOWLEDGE BOUNDARY]\n' +
        'Archive scenes are YOUR memory as narrator. NPCs only know events from scenes they are\n' +
        'listed as witnessing. An NPC must never reference, react to, or act on events they did\n' +
        'not witness, unless another character tells them in-story.\n' +
        '[END NPC KNOWLEDGE BOUNDARY]'
    );

    const stableContent = stableParts.join('\n\n');
    const stableTokens = countTokens(stableContent);
    addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: 'Rules & Core state', included: true, position: 'system_static' });

    return { stableContent, stableTokens, divergenceContent: '', divergenceTokens: 0, retrievedRulesContent };
}

export function buildDivergenceBlock(opts: {
    divergenceRegister?: DivergenceRegister;
    chapters?: ArchiveChapter[];
    onStageNpcIds?: string[];
    npcLedger?: NPCEntry[];
    /** Token cap for the rendered register; oldest non-pinned chapters collapse first (AUDIT F6). */
    cap?: number;
    addTrace: (t: PayloadTrace) => void;
}): { divergenceContent: string; divergenceTokens: number } {
    const { divergenceRegister, chapters, onStageNpcIds, npcLedger, cap, addTrace } = opts;

    let divergenceContent = '';
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        divergenceContent = renderRegisterForPayload(divergenceRegister, chapters, onStageNpcIds, npcLedger);
        if (cap && cap > 0 && countTokens(divergenceContent) > cap) {
            divergenceContent = capDivergenceRender(divergenceRegister, chapters, onStageNpcIds, npcLedger, cap);
        }
    }
    const divergenceTokens = countTokens(divergenceContent);
    addTrace({ source: 'Divergence Register', classification: 'stable_truth', tokens: divergenceTokens, reason: `Campaign canon overrides (${divergenceRegister?.entries.length ?? 0} entries)`, included: !!divergenceContent, position: 'system_static' });

    return { divergenceContent, divergenceTokens };
}

/**
 * The divergence register grows monotonically (entries merge at every seal) and
 * is otherwise unbudgeted. When it exceeds `cap`, drop oldest non-pinned chapters
 * first — pinned facts and the newest chapters' canon (the most relevant) survive.
 */
function capDivergenceRender(
    register: DivergenceRegister,
    chapters: ArchiveChapter[] | undefined,
    onStageNpcIds: string[] | undefined,
    npcLedger: NPCEntry[] | undefined,
    cap: number,
): string {
    const chapterIds = [...new Set(register.entries.map(e => e.chapterId))].sort();
    let working = register;
    let collapsed = 0;
    let content = renderRegisterForPayload(working, chapters, onStageNpcIds, npcLedger);

    for (const chId of chapterIds) {
        if (countTokens(content) <= cap) break;
        const remaining = working.entries.filter(e => e.chapterId !== chId || e.pinned);
        collapsed += working.entries.length - remaining.length;
        working = { ...working, entries: remaining };
        content = renderRegisterForPayload(working, chapters, onStageNpcIds, npcLedger);
    }

    if (collapsed > 0) {
        console.warn(`[Payload] divergence register capped: collapsed ${collapsed} older facts to fit ${cap}t`);
        if (content) content += `\n[${collapsed} older established facts collapsed to fit budget]`;
    }
    return content;
}