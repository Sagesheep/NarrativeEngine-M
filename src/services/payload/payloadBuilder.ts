import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, PayloadTrace, DivergenceRegister, ArchiveChapter, ArchiveIndexEntry, PinnedExcerpt } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';
import { computeBudgets, type BudgetMap } from './payloadBudgeter';
import { buildStablePreamble, buildDivergenceBlock } from './payloadStableContent';
import { assembleWorldBlocks, trimWorldBlocks, type WorldBlock, type NpcStrategy } from './payloadWorldContext';
import { fitHistory, spliceSceneNote, splicePinnedMemories, pinnedExcerptsTokenCost } from './payloadHistoryFitting';

export type { BudgetMap, WorldBlock, NpcStrategy };

export interface BuildPayloadOptions {
    settings: AppSettings;
    context: GameContext;
    history: ChatMessage[];
    userMessage: string;
    condensedUpToIndex?: number;
    relevantLore?: LoreChunk[];
    relevantRules?: LoreChunk[];
    rulesManifest?: string;
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
        rulesManifest,
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

    const { stableContent, stableTokens } = buildStablePreamble({
        settings,
        context,
        sceneNumber,
        relevantRules,
        rulesManifest,
        budgetMap,
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

    const volatileParts: string[] = [];
    if (context.characterProfileActive && context.characterProfile) volatileParts.push(`[CHARACTER PROFILE]\n${context.characterProfile}`);
    if (context.inventoryActive && context.inventory) volatileParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    addTrace({ source: 'Profile/Inventory', classification: 'volatile_state', tokens: volatileTokens, reason: 'Player state', included: true, position: 'system_dynamic' });

    const pinnedExcerptsTokens = pinnedExcerpts && pinnedExcerpts.length > 0
        ? pinnedExcerptsTokenCost(pinnedExcerpts)
        : 0;
    const { fitted, historyUsed, userTokens, historyBudget } = fitHistory(
        history,
        condensedUpToIndex,
        userMessage,
        stableTokens + divergenceTokens + currentWorldTokens + volatileTokens + pinnedExcerptsTokens,
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
    addTrace({ source: 'User Message', classification: 'volatile_state', tokens: userTokens, reason: 'Current turn', included: true, position: 'user' });

    const sceneNoteTrace = spliceSceneNote(context, fitted);
    if (sceneNoteTrace) addTrace(sceneNoteTrace);

    if (pinnedExcerpts && pinnedExcerpts.length > 0) {
        const pinnedTraces = splicePinnedMemories(fitted, pinnedExcerpts, history);
        for (const t of pinnedTraces) addTrace(t);
    }

    const messages: OpenAIMessage[] = [];
    if (stableContent) messages.push({ role: 'system', content: stableContent });
    if (divergenceContent) messages.push({ role: 'system', content: divergenceContent });
    if (worldContent || volatileContent) {
        messages.push({ role: 'system', content: [worldContent, volatileContent].filter(Boolean).join('\n\n') });
    }
    messages.push(...fitted);
    messages.push({ role: 'user', content: userMessage });

    return { messages, trace: isDebug ? trace : undefined };
}