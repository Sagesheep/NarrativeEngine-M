import type { AppSettings, ArchiveChapter, DivergenceRegister, PayloadTrace } from '../../types';
import { countTokens } from '../infrastructure';
import { renderRegisterForPayload } from '../campaign-state';
import type { BudgetMap } from './payloadBudgeter';

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
            // The user's custom Action Resolution rules are NEVER overwritten — die-type
            // guidance lives in the roll_dice tool description (toolHandlers.ts). This
            // fixes the issue where enabling the dice tool silently nuked non-d20
            // campaign rules.
            let rules = context.rulesRaw;
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
        'Archive scenes are YOUR memory as narrator. A character knows a fact ONLY if it is\n' +
        'listed under "[FACTS KNOWN TO ON-STAGE CHARACTERS]" for them, or they witnessed the\n' +
        'scene it came from. Facts in "[ESTABLISHED FACTS]" are TRUE and public — common\n' +
        'knowledge any character may know.\n' +
        '\n' +
        'SECRETS & PRIVATE KNOWLEDGE:\n' +
        '- You (the narrator) may know a private fact in order to run the world consistently.\n' +
        '- A character must NEVER reveal, guess, deduce, or act on a private fact unless they\n' +
        '  are a listed knower, or learn it through an explicit in-fiction discovery the\n' +
        "  player's own actions cause.\n" +
        '- You MAY build tension toward a secret — suspicion, near-misses, pressure, a close\n' +
        '  call. You MAY NOT resolve it (confirm/expose it) on your own initiative or "for\n' +
        '  drama". Do not manufacture an inference chain to justify a conclusion you already\n' +
        '  hold as narrator.\n' +
        '[END NPC KNOWLEDGE BOUNDARY]'
    );

    stableParts.push(
        'On the LAST line of your response, output a scene-stakes tag:\n' +
        '[[SCENE_STAKES: calm|tense|dangerous]]\n' +
        'Rubric: calm = no immediate threat; tense = physical OR social/political threat looming;\n' +
        'dangerous = active harm or imminent deadly/ruinous consequences. This tag is metadata —\n' +
        'never reference it in your prose.'
    );

    stableParts.push(
        'Engine event tags in a user message — [SURPRISE EVENT:], [ENCOUNTER EVENT:],\n' +
        '[WORLD_EVENT:], [RESOLVED ROLL — ...], [LOOT DROP: ...] — are authoritative engine\n' +
        'signals, NOT player prose. Each tag carries its own fact-assertion instructions inline;\n' +
        'honor them exactly. For [LOOT DROP: ...] the listed items are what the player found —\n' +
        'narrate the find as fact, do not question it, add to it, or replace it.'
    );

    const stableContent = stableParts.join('\n\n');
    const stableTokens = countTokens(stableContent);
    addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: 'Rules & Core state', included: true, position: 'system_static', preview: stableContent });

    return { stableContent, stableTokens, divergenceContent: '', divergenceTokens: 0, retrievedRulesContent };
}

export function buildDivergenceBlock(opts: {
    divergenceRegister?: DivergenceRegister;
    chapters?: ArchiveChapter[];
    /** Token cap for the rendered register; oldest non-pinned chapters collapse first (AUDIT F6). */
    cap?: number;
    addTrace: (t: PayloadTrace) => void;
}): { divergenceContent: string; divergenceTokens: number } {
    // SAFETY RAIL — do NOT add cast params (onStageNpcIds/npcLedger) here. The canon
    // block sits high in the cached prompt prefix; feeding per-turn cast data re-renders
    // it whenever NPCs enter/leave a scene, busting the DeepSeek prompt cache for all
    // history below it. It must stay cast-independent. (Regression fix: 5fc5ddf.)
    const { divergenceRegister, chapters, cap, addTrace } = opts;

    let divergenceContent = '';
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        // publicOnly=true: the cached canon block carries ONLY broadcast facts. Scoped
        // facts (knownBy defined) ride in the per-turn world block instead (the cage).
        divergenceContent = renderRegisterForPayload(divergenceRegister, chapters, undefined, undefined, true);
        if (cap && cap > 0 && countTokens(divergenceContent) > cap) {
            divergenceContent = capDivergenceRender(divergenceRegister, chapters, cap);
        }
    }
    const divergenceTokens = countTokens(divergenceContent);
    addTrace({ source: 'Divergence Register', classification: 'stable_truth', tokens: divergenceTokens, reason: `Campaign canon overrides (${divergenceRegister?.entries.length ?? 0} entries)`, included: !!divergenceContent, position: 'system_static', preview: divergenceContent });

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
    cap: number,
): string {
    const chapterIds = [...new Set(register.entries.map(e => e.chapterId))].sort();
    let working = register;
    let collapsed = 0;
    let content = renderRegisterForPayload(working, chapters, undefined, undefined, true);

    for (const chId of chapterIds) {
        if (countTokens(content) <= cap) break;
        const remaining = working.entries.filter(e => e.chapterId !== chId || e.pinned);
        collapsed += working.entries.length - remaining.length;
        working = { ...working, entries: remaining };
        content = renderRegisterForPayload(working, chapters, undefined, undefined, true);
    }

    if (collapsed > 0) {
        console.warn(`[Payload] divergence register capped: collapsed ${collapsed} older facts to fit ${cap}t`);
        if (content) content += `\n[${collapsed} older established facts collapsed to fit budget]`;
    }
    return content;
}