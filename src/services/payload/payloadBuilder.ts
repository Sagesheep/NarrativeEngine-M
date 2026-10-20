import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, PayloadTrace, DivergenceRegister, ArchiveChapter, ArchiveIndexEntry, PinnedExcerpt, SceneEventType } from '../../types';
import { CORE_FLOOR_TRAITS } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure';
import { computeBudgets, type BudgetMap } from './payloadBudgeter';
import { buildStablePreamble, buildDivergenceBlock, isThinkingEnabled } from './payloadStableContent';
import { assembleWorldBlocks, trimWorldBlocks, type WorldBlock, type NpcStrategy } from './payloadWorldContext';
import { fitHistory, computeHistoryBudget, buildPinnedMemoriesBlock, pinnedExcerptsTokenCost } from './payloadHistoryFitting';
import { buildChapterRecapBlock } from './lodRenderer';
import { buildAbsoluteCommandBlock } from '../turn/absoluteCommand';
import { sceneNoteText as buildSceneNoteText, sceneNoteTokens, normalizeSceneNoteRole } from './sceneNote';
import { queryTraits, formatTraitsForContext } from '../campaign-state';
import type { NpcDetailLevel } from './contextRecommender';

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
    /** Recommender's per-NPC detail level (npcId → full/brief). Undefined = recommender
     *  unavailable → every NPC at full detail. */
    recommendedNPCDetail?: Record<string, NpcDetailLevel>;
    semanticFactText?: string;
    deepContextSummary?: string;
    divergenceRegister?: DivergenceRegister;
    chapters?: ArchiveChapter[];
    archiveIndex?: ArchiveIndexEntry[];
    semanticallyRecalledNpcIds?: string[];
    pinnedExcerpts?: PinnedExcerpt[];
    plannerEventTypes?: SceneEventType[];
    /** Director Brief (WO-A §3.5): LLM-authored Writer Brief rendered as a
     *  [DIRECTOR BRIEF] block in the volatile region of the final user message. */
    directorBrief?: string;
    /** Absolute Command: binding out-of-character instruction for THIS turn only.
     *  Placed after the user message; suppresses the Brief. */
    absoluteCommand?: string;
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
        recommendedNPCDetail,
        semanticFactText,
        deepContextSummary,
        divergenceRegister,
        chapters,
        archiveIndex,
        semanticallyRecalledNpcIds,
        pinnedExcerpts,
        plannerEventTypes,
        directorBrief,
        absoluteCommand,
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
            detailLevels: recommendedNPCDetail,
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
    const npcBlockIndex = worldBlocks.findIndex(b => b.source === 'Active NPCs');
    const activeNpcIds = npcBlockIndex >= 0 ? (worldBlocks[npcBlockIndex].npcIds ?? []) : [];

    // ── Two-phase trim (Phase 2) ────────────────────────────────────────────
    // NPCs get a guaranteed 5% floor (budgetMap.npc), decoupled from the world
    // budget so lore/archive pressure can never starve the scene's actors. The
    // NPC block is trimmed against its own slice first; any unused budget flows
    // back to the world pool for the remaining world blocks (lore, archive, etc).
    const npcBlock = npcBlockIndex >= 0 ? worldBlocks.splice(npcBlockIndex, 1)[0] : null;
    const npcBudget = budgetMap.npc;

    let npcContent = '';
    let npcTokensUsed = 0;
    if (npcBlock) {
        const trimmed = trimWorldBlocks([npcBlock], npcBudget, addTrace);
        npcContent = trimmed.worldContent;
        npcTokensUsed = trimmed.currentWorldTokens;
    }

    // Remainder of the NPC slice returns to the world pool.
    const worldBudgetWithRemainder = budgetMap.world + (npcBudget - npcTokensUsed);
    const { worldContent, currentWorldTokens } = trimWorldBlocks(worldBlocks, worldBudgetWithRemainder, addTrace);

    // NPCs pack first (they're the scene's actors), then the rest of the world.
    const combinedWorldContent = [npcContent, worldContent].filter(Boolean).join('\n\n');
    const combinedWorldTokens = npcTokensUsed + currentWorldTokens;

    let pinnedMemoriesContent = '';
    let pinnedMemoriesTokens = 0;
    if (pinnedExcerpts && pinnedExcerpts.length > 0) {
        pinnedMemoriesContent = buildPinnedMemoriesBlock(pinnedExcerpts, history);
        pinnedMemoriesTokens = countTokens(pinnedMemoriesContent);
        addTrace({ source: 'Pinned Memories', classification: 'summary', tokens: pinnedMemoriesTokens, reason: `${pinnedExcerpts.length} pinned excerpts in stable block`, included: true, position: 'system_static' });
    }

    const volatileParts: string[] = [];

    // Trace each volatile module on its OWN row (was one lumped 'Profile/Inventory/SceneNote'
    // row) so the debug panel can read exactly what each module sent. We still fold them all
    // into the single volatileContent string below — keep volatileContent / volatileTokens
    // byte-identical so downstream budget math is unchanged.
    let retrievedRulesText = '';
    if (retrievedRulesContent) { retrievedRulesText = retrievedRulesContent; volatileParts.push(retrievedRulesContent); }

    // PC profile: structured retrieval via queryTraits (scene-aware, budget-capped).
    // Replaces the legacy wholesale `[CHARACTER PROFILE]\n${flat-string}` injection.
    // Core floor (CORE_FLOOR_TRAITS=5) always injects; extended tier is filtered
    // by planner eventTypes + entity match + token budget. legacyNotes is storage-
    // only and never injected.
    let profileText = '';
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
            profileText = formatTraitsForContext(profile, selected);
            if (profileText) volatileParts.push(profileText);
        }
    }

    let inventoryText = '';
    if (context.inventoryActive && context.inventory) { inventoryText = `[PLAYER INVENTORY]\n${context.inventory}`; volatileParts.push(inventoryText); }

    // The Scene Note is placed at its depth at request time (applySceneNote, in the
    // orchestrator and swipe generator), not here; only its tokens are reserved.
    const sceneNoteText = buildSceneNoteText(context);
    const sceneNoteReserve = sceneNoteTokens(context);

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    if (retrievedRulesText) addTrace({ source: 'Retrieved Rules', classification: 'volatile_state', tokens: countTokens(retrievedRulesText), reason: 'RAG rules retrieved for this turn', included: true, position: 'system_dynamic', preview: retrievedRulesText });
    if (profileText) addTrace({ source: 'Player Profile', classification: 'volatile_state', tokens: countTokens(profileText), reason: 'Scene-selected PC traits', included: true, position: 'system_dynamic', preview: profileText });
    if (inventoryText) addTrace({ source: 'Inventory', classification: 'volatile_state', tokens: countTokens(inventoryText), reason: 'Player inventory', included: true, position: 'system_dynamic', preview: inventoryText });
    if (sceneNoteText) {
        const noteRole = normalizeSceneNoteRole(context.sceneNoteRole);
        const noteDepth = noteRole === 'thinking' ? 0 : (context.sceneNoteDepth ?? 3);
        addTrace({ source: 'GM Scene Note', classification: 'volatile_state', tokens: sceneNoteReserve, reason: `Player note as ${noteRole}, placed at depth ${noteDepth} when the request is sent`, included: true, position: `history_at_${noteDepth}`, preview: sceneNoteText });
    }

    const nonHistoryTokens = stableTokens + divergenceTokens + pinnedMemoriesTokens + combinedWorldTokens + volatileTokens + sceneNoteReserve;

    // Observability: stable/summary/volatile budget buckets are advisory (only
    // `world`, `npc` and `rules` are enforced). If the enforced + unenforced sections
    // already exceed the limit, history is fully starved and the provider will
    // truncate — surface it instead of failing silently (AUDIT F6/F9).
    const nonHistoryPlusUser = nonHistoryTokens + countTokens(userMessage);
    if (nonHistoryPlusUser > limit) {
        console.warn(`[Payload] non-history content ${nonHistoryPlusUser}t exceeds context limit ${limit}t (stable=${stableTokens} divergence=${divergenceTokens} world=${combinedWorldTokens} volatile=${volatileTokens} pinned=${pinnedMemoriesTokens}) — history dropped, provider may truncate`);
    }

    // Chapter recaps: the sealed chapters behind the condensed boundary, which the
    // verbatim window no longer carries. Up to half the history budget; the verbatim
    // window gets the rest. Deterministic, so it rides in the cached prefix.
    const recap = buildChapterRecapBlock({
        chapters,
        archiveIndex,
        messages: history,
        condensedUpToIndex,
        historyBudget: computeHistoryBudget(userMessage, nonHistoryTokens, limit),
    });
    if (recap.content) {
        const tiers = Object.values(recap.tierByChapterId);
        const count = (t: string) => tiers.filter(x => x === t).length;
        const dropped = count('dropped');
        addTrace({
            source: 'Chapter Recaps', classification: 'summary', tokens: recap.tokens,
            reason: `${count('summary')} summary, ${count('synopsis')} synopsis${dropped > 0 ? `, ${dropped} dropped` : ''}`,
            included: true, position: 'history', preview: recap.content,
        });
    }

    const { fitted, historyUsed, historyBudget } = fitHistory(
        history,
        condensedUpToIndex,
        userMessage,
        nonHistoryTokens + recap.tokens,
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
    // No breakpoint of its own (four is Claude's limit): the stamp on the last
    // history message below covers it.
    if (recap.content) messages.push({ role: 'system', content: recap.content });

    messages.push(...fitted);

    if (fitted.length > 0) {
        const last = messages.length - 1;
        const lastMsg = messages[last];
        if (lastMsg.role === 'user' || lastMsg.role === 'assistant') {
            messages[last] = { ...lastMsg, cache_control: { type: 'ephemeral' } };
        }
    }

    const volatileBlock = [combinedWorldContent, volatileContent].filter(Boolean).join('\n\n');

    // ── Director Brief + Writer CoT (WO-A §3.5 / WO-B §4.4) ──
    // Both ride in the volatile region of the final user message (below the cache
    // boundary) so they never perturb the cached prefix. An Absolute Command
    // suppresses the Brief for its turn: the player is overriding that steering.
    const absoluteBlock = buildAbsoluteCommandBlock(absoluteCommand);
    const hasAbsolute = absoluteBlock !== '';
    const directorBriefBlock = directorBrief && !hasAbsolute ? `[DIRECTOR BRIEF]\n${directorBrief}` : '';

    // Per-turn CoT invocation line (thinking-mode only). Rides in the final user
    // message (below the cache boundary) — kept out of the cached stable prefix
    // so thinking-off turns stay byte-identical to the pre-CoT payload. Under an
    // Absolute Command the framework is subordinated to the command, not dropped
    // (the framework itself lives in the cached prefix).
    const writerCotNudge = !isThinkingEnabled(settings)
        ? ''
        : hasAbsolute
            ? 'Work through the [WRITER REASONING FRAMEWORK] only where it does not conflict with [USER ABSOLUTE COMMAND]. Where they conflict, discard the framework step and follow the command.'
            : 'Work through the [WRITER REASONING FRAMEWORK] in your reasoning before writing.';

    // Ordering: volatileBlock → writerCotNudge → directorBriefBlock → userMessage
    // → absoluteBlock. The Absolute Command goes last, at maximum recency.
    // Everything upstream of this point is cache-stable.
    const finalUserContent = [
        volatileBlock, writerCotNudge, directorBriefBlock, userMessage, absoluteBlock,
    ].filter(Boolean).join('\n\n');

    if (absoluteBlock) {
        addTrace({ source: 'Absolute Command', classification: 'player_input', tokens: countTokens(absoluteBlock), reason: 'Binding out-of-character instruction for this turn; Director Brief suppressed', included: true, position: 'user', preview: absoluteBlock });
    }

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

    // Trace the Director Brief so debug mode shows the LLM-authored directives.
    // Only recorded when the Brief is actually present — a null/empty Brief
    // (timeout, parse failure, lite tier) is not a payload contributor this turn.
    if (directorBriefBlock) {
        addTrace({
            source: 'Director',
            classification: 'world_context',
            tokens: countTokens(directorBriefBlock),
            reason: 'LLM-authored Writer Brief from runDirectorBrief',
            included: true,
            position: 'user',
            preview: directorBriefBlock,
        });
    }

    messages.push({ role: 'user', content: finalUserContent });

    return { messages, trace: isDebug ? trace : undefined, activeNpcIds };
}