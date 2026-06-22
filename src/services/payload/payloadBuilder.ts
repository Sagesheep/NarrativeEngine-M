import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, PayloadTrace, DivergenceRegister, ArchiveChapter, ArchiveIndexEntry, PinnedExcerpt, SceneEventType } from '../../types';
import { CORE_FLOOR_TRAITS } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';
import { computeBudgets, type BudgetMap } from './payloadBudgeter';
import { buildStablePreamble, buildDivergenceBlock } from './payloadStableContent';
import { assembleWorldBlocks, trimWorldBlocks, type WorldBlock, type NpcStrategy } from './payloadWorldContext';
import { fitHistory, buildPinnedMemoriesBlock, pinnedExcerptsTokenCost } from './payloadHistoryFitting';
import { queryTraits, formatTraitsForContext } from '../campaign-state';

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
    plannerEventTypes?: SceneEventType[];
}

export { pinnedExcerptsTokenCost };

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
        plannerEventTypes,
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
        divergenceRegister,
        plannerEventTypes,
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
    // PC profile: structured retrieval via queryTraits (scene-aware, budget-capped).
    // Replaces the legacy wholesale `[CHARACTER PROFILE]\n${flat-string}` injection.
    // Core floor (CORE_FLOOR_TRAITS=5) always injects; extended tier is filtered
    // by planner eventTypes + entity match + token budget. legacyNotes is storage-
    // only and never injected.
    if (context.characterProfileActive && context.characterProfile) {
        const profile = context.characterProfile;
        if (profile.activeTraits && profile.activeTraits.length > 0 || profile.identity.name || profile.stats) {
            const selected = queryTraits(
                profile.activeTraits ?? [],
                userMessage,
                history,
                npcLedger,
                plannerEventTypes,
                400,
                CORE_FLOOR_TRAITS,
            );
            const profileText = formatTraitsForContext(profile, selected);
            if (profileText) volatileParts.push(profileText);
        }
    }
    if (context.inventoryActive && context.inventory) volatileParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);
    if (context.sceneNoteActive && context.sceneNote) volatileParts.push(`[SCENE NOTE: VOLATILE GUIDANCE]\n${context.sceneNote}`);

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    addTrace({ source: 'Profile/Inventory/SceneNote', classification: 'volatile_state', tokens: volatileTokens, reason: 'Player state + scene note', included: true, position: 'system_dynamic', preview: volatileContent });

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
    // Trace the THREE buckets distinctly so debug differentiates them:
    //   - world_context rows (incl. Arc Digest = injection) are traced upstream in trimWorldBlocks
    //   - volatile_state row (Profile/Inventory/SceneNote) traced above
    //   - the actual player input is THIS row.
    // We physically fold worldContent + volatileContent into the user message (cache
    // locality), but they're already counted in their own rows — so this row counts
    // ONLY `userMessage`, avoiding the prior double-count. NOTE: `userMessage` still
    // carries any engine-event tags rollEngines appended onto the typed text upstream
    // (surprise/encounter/world-rumour) — that's the spillage to watch.
    addTrace({ source: 'Player Input', classification: 'player_input', tokens: countTokens(userMessage), reason: 'This turn\'s typed input (+ any engine-event tags appended by rollEngines)', included: true, position: 'user', preview: userMessage });
    messages.push({ role: 'user', content: finalUserContent });

    return { messages, trace: isDebug ? trace : undefined, activeNpcIds };
}