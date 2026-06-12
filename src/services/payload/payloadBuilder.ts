import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, PayloadTrace, DivergenceRegister, ArchiveChapter, ArchiveIndexEntry, PinnedExcerpt, CombatState } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';
import { computeBudgets, type BudgetMap } from './payloadBudgeter';
import { buildStablePreamble, buildDivergenceBlock } from './payloadStableContent';
import { assembleWorldBlocks, trimWorldBlocks, type WorldBlock, type NpcStrategy } from './payloadWorldContext';
import { fitHistory, buildPinnedMemoriesBlock, pinnedExcerptsTokenCost } from './payloadHistoryFitting';

export type { BudgetMap, WorldBlock, NpcStrategy };

export interface BuildPayloadOptions {
    settings: AppSettings;
    context: GameContext;
    history: ChatMessage[];
    userMessage: string;
    condensedUpToIndex?: number;
    relevantLore?: LoreChunk[];
    relevantRules?: LoreChunk[];
    npcLedger?: NPCEntry[];
    archiveRecall?: ArchiveScene[];
    onStageNpcIds?: string[];
    sceneNumber?: string;
    recommendedNPCNames?: string[];
    semanticFactText?: string;
    deepContextSummary?: string;
    divergenceRegister?: DivergenceRegister;
    chapters?: ArchiveChapter[];
    archiveIndex?: ArchiveIndexEntry[];
    semanticallyRecalledNpcIds?: string[];
    pinnedExcerpts?: PinnedExcerpt[];
    /** Live combat snapshot — rendered into the volatile block while a fight is active. */
    combatState?: CombatState | null;
}

export { pinnedExcerptsTokenCost };

/**
 * Live combat snapshot for the volatile payload block (A10: "live HP/FOC in the volatile block only").
 * Terse by design — one line per living combatant + a range-relation summary.
 */
export function buildCombatStateBlock(combatState: CombatState, statLabelMap?: Record<string, string>): string {
    const focLabel = statLabelMap?.FOC ?? 'FOC';
    const living = Object.values(combatState.combatants).filter(c => c.currentHP > 0);

    const lines = living.map(c => {
        const tags: string[] = [];
        if (c.position) tags.push(c.position);
        if (c.statusEffects && c.statusEffects.length > 0) tags.push(...c.statusEffects);
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        const who = c.isPC ? `${c.name} (PC)` : c.name;
        return `- ${who}: HP ${c.currentHP}/${c.maxHP} · ${focLabel} ${c.currentFOC}/${c.maxFOC}${tagStr}`;
    });

    // Range relations: list distinct Engaged pairs (Apart is the default, omit for brevity).
    const engagedPairs: string[] = [];
    const seen = new Set<string>();
    for (const [a, rels] of Object.entries(combatState.rangeRelations)) {
        for (const [b, rel] of Object.entries(rels)) {
            const key = [a, b].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            const ca = combatState.combatants[a];
            const cb = combatState.combatants[b];
            if (rel === 'Engaged' && (ca?.currentHP ?? 0) > 0 && (cb?.currentHP ?? 0) > 0) {
                engagedPairs.push(`${ca?.name ?? a}⇔${cb?.name ?? b}`);
            }
        }
    }
    const rangeSummary = engagedPairs.length > 0 ? `\nEngaged (melee range): ${engagedPairs.join(', ')}` : '';

    return `[COMBAT STATE: VOLATILE]\nRound ${combatState.round}\n${lines.join('\n')}${rangeSummary}`;
}

export function buildPayload(opts: BuildPayloadOptions): { messages: OpenAIMessage[]; trace?: PayloadTrace[]; activeNpcIds: string[] } {
    const {
        settings,
        context,
        history,
        userMessage,
        condensedUpToIndex,
        relevantLore,
        relevantRules,
        npcLedger,
        archiveRecall,
        onStageNpcIds,
        recommendedNPCNames,
        semanticFactText,
        deepContextSummary,
        divergenceRegister,
        chapters,
        archiveIndex,
        semanticallyRecalledNpcIds,
        pinnedExcerpts,
        combatState,
    } = opts;

    const trace: PayloadTrace[] = [];
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;

    const budgetMap = computeBudgets(limit, !!deepContextSummary, settings.rulesBudgetPct ?? 0.10);

    const addTrace = (t: PayloadTrace) => {
        if (isDebug) trace.push(t);
    };

    const { stableContent, stableTokens, retrievedRulesContent } = buildStablePreamble({
        settings,
        context,
        relevantRules,
        budgetMap,
        addTrace,
    });

    const { divergenceContent, divergenceTokens } = buildDivergenceBlock({
        divergenceRegister,
        chapters,
        cap: Math.floor(limit * 0.20),
        addTrace,
    });

    const npcStrategy: NpcStrategy | undefined = (recommendedNPCNames || semanticallyRecalledNpcIds)
        ? {
            mode: (recommendedNPCNames && recommendedNPCNames.length > 0) ? 'recommended' : 'fallback',
            recommendedNames: recommendedNPCNames,
            semanticallyRecalledNpcIds,
          }
        : undefined;

    const worldBlocks = assembleWorldBlocks({
        context,
        history,
        userMessage,
        condensedUpToIndex,
        relevantLore,
        archiveRecall,
        archiveIndex,
        npcLedger,
        npcStrategy,
        onStageNpcIds,
        semanticFactText,
        deepContextSummary,
        chapters,
        addTrace,
    });

    // Active-NPC ids selected for this turn's payload (Plan 05 swap signal).
    // Read pre-trim: if the block is later budget-trimmed we still report these as
    // "in payload", which only biases the swap toward 'flag' (never a blind swap).
    const activeNpcIds = worldBlocks.find(b => b.source === 'Active NPCs')?.npcIds ?? [];

    const { worldContent, currentWorldTokens } = trimWorldBlocks(worldBlocks, budgetMap.world, addTrace);

    let pinnedMemoriesContent = '';
    let pinnedMemoriesTokens = 0;
    if (pinnedExcerpts && pinnedExcerpts.length > 0) {
        pinnedMemoriesContent = buildPinnedMemoriesBlock(pinnedExcerpts, history);
        pinnedMemoriesTokens = countTokens(pinnedMemoriesContent);
        addTrace({ source: 'Pinned Memories', classification: 'summary', tokens: pinnedMemoriesTokens, reason: `${pinnedExcerpts.length} pinned excerpts in stable block`, included: true, position: 'system_static' });
    }

    const volatileParts: string[] = [];
    if (retrievedRulesContent) volatileParts.push(retrievedRulesContent);
    if (context.characterProfileActive && context.characterProfile) volatileParts.push(`[CHARACTER PROFILE]\n${context.characterProfile}`);
    if (context.inventoryActive && context.inventory) volatileParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);
    if (context.sceneNoteActive && context.sceneNote) volatileParts.push(`[SCENE NOTE: VOLATILE GUIDANCE]\n${context.sceneNote}`);
    if (context.combatModeActive && combatState?.active) volatileParts.push(buildCombatStateBlock(combatState, context.statLabelMap));

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    addTrace({ source: 'Profile/Inventory/SceneNote', classification: 'volatile_state', tokens: volatileTokens, reason: 'Player state + scene note', included: true, position: 'system_dynamic' });

    const nonHistoryTokens = stableTokens + divergenceTokens + pinnedMemoriesTokens + currentWorldTokens + volatileTokens;

    // Observability: stable/summary/volatile budget buckets are advisory (only
    // `world` and `rules` are enforced). If the enforced + unenforced sections
    // already exceed the limit, history is fully starved and the provider will
    // truncate — surface it instead of failing silently (AUDIT F6/F9).
    const nonHistoryPlusUser = nonHistoryTokens + countTokens(userMessage);
    if (nonHistoryPlusUser > limit) {
        console.warn(`[Payload] non-history content ${nonHistoryPlusUser}t exceeds context limit ${limit}t (stable=${stableTokens} divergence=${divergenceTokens} world=${currentWorldTokens} volatile=${volatileTokens} pinned=${pinnedMemoriesTokens}) — history dropped, provider may truncate`);
    }

    const { fitted, historyUsed, historyBudget } = fitHistory(
        history,
        condensedUpToIndex,
        userMessage,
        nonHistoryTokens,
        limit,
    );

    addTrace({
        source: 'Fitted History', classification: 'summary', tokens: historyUsed,
        reason: `Included ${fitted.length} msgs within ${historyBudget} budget`,
        included: true, position: 'history',
        childMessages: fitted.map(m => {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content) ?? '';
            return { role: m.role, tokens: countTokens(text), preview: text.slice(0, 80).replace(/\n/g, ' ') };
        }),
    });

    const messages: OpenAIMessage[] = [];
    if (stableContent) messages.push({ role: 'system', content: stableContent, cache_control: { type: 'ephemeral' } });
    if (divergenceContent) messages.push({ role: 'system', content: divergenceContent, cache_control: { type: 'ephemeral' } });
    if (pinnedMemoriesContent) messages.push({ role: 'system', content: pinnedMemoriesContent, cache_control: { type: 'ephemeral' } });

    messages.push(...fitted);

    if (fitted.length > 0) {
        const last = messages.length - 1;
        const lastMsg = messages[last];
        if (lastMsg.role === 'user' || lastMsg.role === 'assistant') {
            messages[last] = { ...lastMsg, cache_control: { type: 'ephemeral' } };
        }
    }

    const volatileBlock = [worldContent, volatileContent].filter(Boolean).join('\n\n');
    const finalUserContent = volatileBlock
        ? `${volatileBlock}\n\n---\n\n${userMessage}`
        : userMessage;
    addTrace({ source: 'User Message (with world context)', classification: 'volatile_state', tokens: countTokens(finalUserContent), reason: 'Current turn + folded world/volatile context', included: true, position: 'user' });
    messages.push({ role: 'user', content: finalUserContent });

    return { messages, trace: isDebug ? trace : undefined, activeNpcIds };
}