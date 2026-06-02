import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, PayloadTrace, DivergenceRegister, ArchiveChapter, ArchiveIndexEntry, PinnedExcerpt } from '../../types';
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
}

export { pinnedExcerptsTokenCost };

export function buildPayload(opts: BuildPayloadOptions): { messages: OpenAIMessage[]; trace?: PayloadTrace[] } {
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
        sceneNumber,
        recommendedNPCNames,
        semanticFactText,
        deepContextSummary,
        divergenceRegister,
        chapters,
        archiveIndex,
        semanticallyRecalledNpcIds,
        pinnedExcerpts,
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
        sceneNumber,
        addTrace,
    });

    const { divergenceContent, divergenceTokens } = buildDivergenceBlock({
        divergenceRegister,
        chapters,
        onStageNpcIds,
        npcLedger,
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

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    addTrace({ source: 'Profile/Inventory/SceneNote', classification: 'volatile_state', tokens: volatileTokens, reason: 'Player state + scene note', included: true, position: 'system_dynamic' });

    const { fitted, historyUsed, historyBudget } = fitHistory(
        history,
        condensedUpToIndex,
        userMessage,
        stableTokens + divergenceTokens + pinnedMemoriesTokens + currentWorldTokens + volatileTokens,
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

    const volatileBlock = [worldContent, volatileContent].filter(Boolean).join('\n\n');
    const finalUserContent = volatileBlock
        ? `${volatileBlock}\n\n---\n\n${userMessage}`
        : userMessage;
    addTrace({ source: 'User Message (with world context)', classification: 'volatile_state', tokens: countTokens(finalUserContent), reason: 'Current turn + folded world/volatile context', included: true, position: 'user' });
    messages.push({ role: 'user', content: finalUserContent });

    return { messages, trace: isDebug ? trace : undefined };
}