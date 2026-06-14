import { type TurnCallbacks, type TurnState } from './turnTypes';
export type { TurnCallbacks, TurnState } from './turnTypes';
import { tierAllows } from './aiTier';
import { uid } from '../../utils/uid';
import { sendMessage, buildPayload } from '../chatEngine';
import { retrieveRelevantLore } from '../lore';
import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from '../payload';
import { rollEngines, rollDiceFairness, rollCharacterIntroEngine } from '../engine';
import {
    runCombatRound,
    checkTermination,
    sortTurnOrderBySPD,
    selectEnemyAction,
    abilityMod,
    type CombatAction,
    type Combatant,
    type ActionResolution,
    type RiskOnFail,
} from '../engine';
import type { AppSettings, ChatMessage, CombatState, GameContext, ItemDef, LoreChunk, NPCEntry, SkillDef } from '../../types';
import { toast } from '../../components/Toast';
import { sanitizePayloadForApi } from '../llm/payloadSanitizer';
import { gatherContext } from './turnContext';
import { handlePostTurn } from './turnPostProcess';
import { getToolDefinitions, handleLoreTool, handleNotebookTool, handleDiceTool, handleAdjudicateTool, handleInitiateCombatTool, handleProposeInventoryTool } from './toolHandlers';

import type { OpenAIMessage } from '../llm/llmService';
import { buildAssistantToolCallMessage, buildToolResultMessage } from '../../types/llmMessages';

export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, condenser, npcLedger, loreChunks, activeCampaignId, provider } = state;

    if (!provider) return;

    callbacks.setPipelinePhase?.('rolling-dice');
    let finalInput = input;
    const engineResult = rollEngines(context);
    finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);
    finalInput += rollDiceFairness(context);

    const userMsgId = uid();
    callbacks.addMessage({
        id: userMsgId,
        role: 'user',
        content: finalInput,
        displayContent: displayInput,
        timestamp: Date.now()
    });
    callbacks.setStreaming(true);

    // Async character introduction engine (Phase 4) — Max tier only
    if (tierAllows(settings.aiTier, 'introEngine')) {
        const seenNpcNames = npcLedger
            .filter(npc => (npc.pressure?.engaged ?? 0) > 0)
            .map(npc => npc.name);
        const recentMessages = state.messages.slice(-10);
        const utilityProvider = state.getUtilityEndpoint?.();
        try {
            const { tag: introTag, newDC: newIntroDC } = await rollCharacterIntroEngine(
                context, seenNpcNames, recentMessages, utilityProvider
            );
            if (introTag) {
                finalInput += `\n${introTag}`;
                callbacks.updateLastMessage({ content: finalInput });
            }
            callbacks.updateContext({ npcIntroDC: newIntroDC });
        } catch (err) {
            console.warn('[TurnOrchestrator] Character intro engine failed:', err);
        }
    }

    callbacks.setLoadingStatus?.('[1/5] Extracting Lore & Stats...');

    callbacks.setPipelinePhase?.('gathering-context');
    const gathered = await gatherContext(state, callbacks, finalInput, userMsgId);

    callbacks.setPipelinePhase?.('building-prompt');
    const { payloadResult } = gathered;

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace && payloadResult.trace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }

    // Only persist the full payload when debugging — otherwise it bloats every
    // saved message (hundreds of KB each) and the campaign export.
    if (settings.debugMode) {
        callbacks.updateLastMessage({ debugPayload: payload });
    }

    const triggerAutoTrim = () => {
        if (!activeCampaignId) return;
        const currentMsgs = state.getMessages();
        const newIndex = computeTrimIndex(currentMsgs, condenser.condensedUpToIndex);
        if (newIndex !== condenser.condensedUpToIndex) {
            callbacks.setCondensed(newIndex);
        }
    };

    const executeTurn = async (currentPayload: OpenAIMessage[], toolCallCount = 0, apiRetryCount = 0) => {
        if (abortController.signal.aborted) {
            callbacks.setStreaming(false);
            callbacks.onCheckingNotes(false);
            callbacks.setPipelinePhase?.('idle');
            callbacks.setStreamingStats?.(null);
            return;
        }

        const assistantMsgId = uid();
        callbacks.addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
        callbacks.setStreaming(true);
        callbacks.setPipelinePhase?.('generating');
        callbacks.setStreamingStats?.(null);

        const allowTools = toolCallCount < 2 && apiRetryCount < 2;
        const requestPayload = sanitizePayloadForApi(currentPayload, allowTools, provider?.modelName);

        const allowDiceTool = context.diceFairnessActive === false;
        const tools = allowTools ? getToolDefinitions({ allowDiceTool, combatModeActive: context.combatModeActive }) : undefined;

        const activePreset = settings.presets.find(p => p.id === settings.activePresetId);
        const sampling = activePreset?.sampling;

        callbacks.setLoadingStatus?.(null);
        await sendMessage(
            provider,
            requestPayload,
            (fullText) => callbacks.updateLastAssistant(fullText),
            async (finalText, toolCall, reasoningContent) => {
                if (toolCall && toolCall.name === 'query_campaign_lore') {
                    callbacks.onCheckingNotes(true);
                    callbacks.setPipelinePhase?.('checking-notes');
                    callbacks.setStreaming(false);
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push(buildAssistantToolCallMessage(
                        finalText || "",
                        [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
                        reasoningContent || undefined,
                    ));

                    const { toolResult } = handleLoreTool(toolCall.arguments, { loreChunks, notebook: context.notebook });

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    });

                    currentPayload.push(buildToolResultMessage(toolCall.id, toolResult, toolCall.name));

                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.onCheckingNotes(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        callbacks.onCheckingNotes(false);
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'update_scene_notebook') {
                    callbacks.setStreaming(false);
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push(buildAssistantToolCallMessage(
                        finalText || "",
                        [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
                        reasoningContent || undefined,
                    ));

                    const { toolResult, updatedNotebook } = handleNotebookTool(toolCall.arguments, { loreChunks, notebook: context.notebook });
                    callbacks.updateContext({ notebook: updatedNotebook });

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    });

                    currentPayload.push(buildToolResultMessage(toolCall.id, toolResult, toolCall.name));

                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.onCheckingNotes(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'roll_dice') {
                    callbacks.setStreaming(false);
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push(buildAssistantToolCallMessage(
                        finalText || "",
                        [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
                        reasoningContent || undefined,
                    ));

                    const { toolResult } = handleDiceTool(toolCall.arguments, { diceConfig: context.diceConfig });

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    });

                    currentPayload.push(buildToolResultMessage(toolCall.id, toolResult, toolCall.name));

                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'adjudicate_action') {
                    callbacks.setStreaming(false);
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push(buildAssistantToolCallMessage(
                        finalText || "",
                        [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
                        reasoningContent || undefined,
                    ));

                    const { toolResult } = handleAdjudicateTool(toolCall.arguments);

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    });

                    currentPayload.push(buildToolResultMessage(toolCall.id, toolResult, toolCall.name));

                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'initiate_combat') {
                    callbacks.setStreaming(false);
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push(buildAssistantToolCallMessage(
                        finalText || "",
                        [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
                        reasoningContent || undefined,
                    ));

                    const { toolResult, foes } = handleInitiateCombatTool(toolCall.arguments);

                    if (callbacks.initiateCombat) {
                        const namedNpcIds: string[] = [];
                        const mookSpecs: { combatTier: import('../../types').CombatTier; archetype: import('../../types').Archetype; count: number }[] = [];
                        for (const foe of foes) {
                            const npcMatch = npcLedger.find(n => {
                                const allNames = [n.name, ...(n.aliases || '').split(',').map(a => a.trim()).filter(Boolean)];
                                return allNames.some(nm => nm.toLowerCase() === foe.name.toLowerCase());
                            });
                            if (npcMatch) {
                                namedNpcIds.push(npcMatch.id);
                            } else {
                                mookSpecs.push({ combatTier: foe.combatTier, archetype: foe.archetype, count: foe.count });
                            }
                        }
                        const pcIds = npcLedger.filter(n => n.isPC).map(n => n.id);
                        for (const pcId of pcIds) {
                            if (!namedNpcIds.includes(pcId)) namedNpcIds.push(pcId);
                        }
                        const auxProvider = state.getFreshAuxiliaryProvider?.();
                        const recentContext = state.messages.slice(-5).map(m => {
                            const role = m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
                            return `[${role}]: ${(m.content || '').slice(0, 400)}`;
                        }).join('\n\n');
                        await callbacks.initiateCombat(namedNpcIds, pcIds, mookSpecs, auxProvider, recentContext);
                    }

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    });

                    currentPayload.push(buildToolResultMessage(toolCall.id, toolResult, toolCall.name));

                    callbacks.updateContext({ combatModeActive: true });

                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'propose_inventory_change') {
                    callbacks.setStreaming(false);
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push(buildAssistantToolCallMessage(
                        finalText || "",
                        [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
                        reasoningContent || undefined,
                    ));

                    const { toolResult, proposal } = handleProposeInventoryTool(toolCall.arguments);

                    if (callbacks.stageInventoryProposal) {
                        callbacks.stageInventoryProposal(proposal);
                    }

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    });

                    currentPayload.push(buildToolResultMessage(toolCall.id, toolResult, toolCall.name));

                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                callbacks.onCheckingNotes(false);
                callbacks.setPipelinePhase?.('post-processing');

                // NOTE: the Plan 05 *automatic* deterministic name-swap was REMOVED here.
                // It mutated GM prose on a "this NPC isn't in the current payload → it must
                // be a coincidental new character" guess, but the model references characters
                // from the full chat history, not just the payload NPC block. That false
                // premise hot-swapped legitimately-referenced legacy NPCs (e.g. Elara Nimue)
                // and the rewritten prose then spawned phantom NPCs via detection.
                // Name de-duplication is now USER-DRIVEN (highlight → rename) instead.
                // The proactive reserved-names prompt guard (non-mutating) stays.
                callbacks.updateLastAssistant(finalText);
                if (reasoningContent) {
                    callbacks.updateLastMessage({ reasoning_content: reasoningContent });
                }

                const allMsgs = state.getMessages();
                const lastAssistant = allMsgs[allMsgs.length - 1];

                try {
                    if (lastAssistant?.role === 'assistant' && lastAssistant.content && activeCampaignId) {
                        await handlePostTurn(
                            state,
                            callbacks,
                            displayInput,
                            activeCampaignId,
                            npcLedger,
                            lastAssistant.content
                        );
                    }

                    if (settings.autoCondenseEnabled && shouldCondense(allMsgs, settings.contextLimit, condenser.condensedUpToIndex, getCondenseBudgetRatio(settings.condenseAggressiveness))) {
                        triggerAutoTrim();
                    }
                } catch (postTurnErr) {
                    console.error('[TurnOrchestrator] handlePostTurn failed:', postTurnErr);
                    toast.error('Post-turn processing failed — your turn was saved but archive/scene updates may be missing.');
                } finally {
                    callbacks.setPipelinePhase?.('idle');
                    callbacks.setStreamingStats?.(null);
                    callbacks.setStreaming(false);
                }
            },
            (err) => {
                if (err === '__ABORT__' || err === 'AbortError' || err === 'The user aborted a request.') {
                    return;
                }
                if (apiRetryCount === 0) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    toast.warning('LLM request failed — retrying...');
                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.onCheckingNotes(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        executeTurn(currentPayload, toolCallCount, 1);
                    }, 2000);
                } else if (apiRetryCount === 1) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                    toast.warning('Retry failed — trying without tools...');
                    setTimeout(() => {
                        if (abortController.signal.aborted) {
                            callbacks.setStreaming(false);
                            callbacks.onCheckingNotes(false);
                            callbacks.setPipelinePhase?.('idle');
                            callbacks.setStreamingStats?.(null);
                            return;
                        }
                        executeTurn(currentPayload, 999, 2);
                    }, 2000);
                } else {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}`);
                    toast.error('LLM request failed after retries');
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                    callbacks.setPipelinePhase?.('idle');
                    callbacks.setStreamingStats?.(null);
                }
            },
            tools,
            abortController,
            sampling
        );
    };

    await executeTurn(payload);
}

export type CombatTurnInput = {
    combatState: CombatState;
    actions: CombatAction[];
    items?: Record<string, ItemDef>;
    skills?: Record<string, SkillDef>;
};

export type CombatTurnResult = {
    combatState: CombatState;
    resolutions: import('../engine/combatEngine').ActionResolution[];
    ledgerLine: string;
    terminated: boolean;
    winner?: string;
};

export function runCombatTurn(input: CombatTurnInput): CombatTurnResult {
    const { combatState, actions } = input;

    // Auto-generate one action per living enemy (non-PC) that has no submitted action.
    // PCs only ever act from their own HUD/adjudicated submission. Enemies are pure
    // functions (spec A7) — zero LLM, so this adds no calls to the round budget.
    const actorIdsWithActions = new Set(actions.map(a => a.actorId));
    const enemyActions: CombatAction[] = [];
    for (const combatant of Object.values(combatState.combatants)) {
        if (combatant.isPC) continue;
        if (combatant.currentHP <= 0) continue;
        if (actorIdsWithActions.has(combatant.id)) continue;
        enemyActions.push(
            selectEnemyAction(combatant, combatState, combatant.overrides ?? []),
        );
    }
    const allActions = [...actions, ...enemyActions];

    const sortedTurnOrder = sortTurnOrderBySPD(combatState.combatants);
    const sortedActions = [...allActions].sort((a, b) => {
        const aIdx = sortedTurnOrder.indexOf(a.actorId);
        const bIdx = sortedTurnOrder.indexOf(b.actorId);
        if (aIdx === -1 && bIdx === -1) return 0;
        if (aIdx === -1) return 1;
        if (bIdx === -1) return -1;
        return aIdx - bIdx;
    });

    const result = runCombatRound(combatState, sortedActions, input.items, input.skills);

    const updatedCombatants: Record<string, Combatant> = { ...result.updatedCombatants };
    const deadCombatantIds = Object.entries(updatedCombatants)
        .filter(([, c]) => c.currentHP <= 0)
        .map(([id]) => id);

    const nextRound = combatState.round + 1;
    const updatedState: CombatState = {
        active: true,
        round: nextRound,
        turnOrder: sortedTurnOrder.filter(id => !deadCombatantIds.includes(id)),
        activeTurnIndex: 0,
        combatants: updatedCombatants,
        rangeRelations: result.updatedRangeRelations,
    };

    const termination = checkTermination(updatedState);
    if (termination.ended) {
        updatedState.active = false;
    }

    return {
        combatState: updatedState,
        resolutions: result.resolutions,
        ledgerLine: result.ledgerLine,
        terminated: termination.ended,
        winner: termination.winner,
    };
}

export function formatCombatLogForChat(
    _round: number,
    resolutions: ActionResolution[],
    combatState: CombatState,
): string {
    const nameOf = (id?: string) => (id && combatState.combatants[id]?.name) || id || '?';

    const lines: string[] = [];
    for (const r of resolutions) {
        const actor = nameOf(r.actorId);
        const target = nameOf(r.targetId);
        if (r.rejected) {
            lines.push(`- ${actor}: action rejected (${r.rejectionReason})`);
            continue;
        }
        if (r.type === 'attack') {
            const targetAC = r.targetId ? combatState.combatants[r.targetId]?.ac : undefined;
            const acStr = targetAC !== undefined ? ` vs AC ${targetAC}` : '';
            if (r.hit) {
                lines.push(`- ${actor} → ${target}: HIT ${r.damage ?? 0} dmg (d20 ${r.naturalRoll}+mod=${r.total}${acStr})`);
            } else {
                lines.push(`- ${actor} → ${target}: MISS (d20 ${r.naturalRoll}+mod=${r.total}${acStr})`);
            }
            continue;
        }
        if (r.type === 'heal') {
            const tgt = r.targetId && r.targetId !== r.actorId ? `${actor} → ${target}` : actor;
            lines.push(`- ${tgt}: healed ${r.healed ?? 0} HP${r.focSpent ? ` (spent ${r.focSpent} FOC)` : ''}`);
            continue;
        }
        if (r.type === 'mental') {
            const label = r.saved ? 'RESISTED' : 'AFFECTED';
            const dmg = r.damage ? ` — ${r.damage} damage` : '';
            lines.push(`- ${actor} → ${target}: ${label}${dmg} (roll ${r.naturalRoll}+mod=${r.total})`);
            continue;
        }
        if (r.type === 'defend') {
            lines.push(`- ${actor}: braced (+${r.focRecovered ?? 0} FOC)`);
            continue;
        }
        if (r.type === 'move') {
            lines.push(`- ${actor}: moved${r.newPosition ? ` to ${r.newPosition}` : ''}${r.newRangeRelation ? ` (now ${r.newRangeRelation})` : ''}`);
            continue;
        }
        lines.push(`- ${actor}: ${r.type}`);
    }
    return lines.join('\n');
}

export function emitCombatLedgerMessage(ledgerLine: string, round: number, resolutions?: ActionResolution[], combatState?: CombatState): ChatMessage {
    let content = `⚔️ ${ledgerLine}`;
    if (resolutions && combatState) {
        const log = formatCombatLogForChat(round, resolutions, combatState);
        content += `\n${log}`;
    }
    return {
        id: uid(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        name: 'combat-ledger',
    };
}

export type CombatActionSource =
    | { kind: 'button'; action: CombatAction }
    | { kind: 'freeform'; freeformText: string; baseAction: CombatAction };

export type CombatActionCallbacks = {
    addMessage: (msg: ChatMessage) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setCombatState: (state: CombatState | null) => void;
    terminateCombat: (options?: { writeBack?: boolean }) => void;
    getAuxiliaryProvider: () => import('../../types').LLMProvider | undefined;
    getStoryProvider: () => import('../../types').LLMProvider | undefined;
    narrateCombatOutcome: (ledgerLine: string, resolutions: import('../engine/combatEngine').ActionResolution[], combatState: CombatState) => Promise<void>;
    items: ItemDef[];
    skills: SkillDef[];
};

export const ADJUDICATOR_PROMPT = `You are a combat maneuver adjudicator for a text RPG. The player has described a freeform
action mid-combat. Translate the fiction into bounded mechanical labels. You do NOT decide
damage, hit/miss, or any number — the engine owns all of that. You only choose labels.

Given the player's described maneuver, output:
- stat: which stat governs it — PWR (raw force), SPD (agility/acrobatics/finesse), WIL
  (mental/magic/willpower), VIT (endurance/toughness), RES (bracing/guarding), FOC (technique fuel).
- advantage: "advantage" if the fiction is clever or sets up a clear edge (high ground, an
  opening, a distraction); "disadvantage" if it's reckless, clumsy, or off-balance; otherwise "normal".
- positionTag: where the actor ends up — "elevated" (high ground, benefits them), "cover"
  (shielded vs ranged), "exposed" (open/vulnerable), or "none".
- momentumToken: 1 if this is clearly a setup that earns a one-use boon for the follow-up
  attack; otherwise 0. Never more than 1.
- riskOnFail: what befalls the actor if the maneuver flops — "prone", "exposed",
  "drop_weapon", "self_stagger", or "none". Bolder/riskier stunts should carry a real risk.

Respond with ONLY a JSON object, no prose, no markdown:
{"stat":"PWR","advantage":"normal","positionTag":"none","momentumToken":0,"riskOnFail":"none"}`;

export async function handleCombatAction(
    source: CombatActionSource,
    combatState: CombatState,
    callbacks: CombatActionCallbacks,
): Promise<void> {
    let llmCallCount = 0;
    let actions: CombatAction[];

    if (source.kind === 'button') {
        actions = [source.action];
    } else {
        const auxProvider = callbacks.getAuxiliaryProvider();
        if (!auxProvider) {
            actions = [source.baseAction];
        } else {
            llmCallCount++;
            const { handleAdjudicateTool } = await import('./toolHandlers');
            const { llmCall } = await import('../../utils/llmCall');
            const prompt = `${ADJUDICATOR_PROMPT}\n\n----- PLAYER MANEUVER -----\n${source.freeformText}`;
            let rawResult = await llmCall(auxProvider, prompt, {
                temperature: 0.3,
                priority: 'high',
                maxTokens: 200,
            });
            rawResult = rawResult.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            const { toolResult } = handleAdjudicateTool(rawResult);
            let adjudicated: Record<string, unknown> = {};
            try { adjudicated = JSON.parse(toolResult); } catch { /* use defaults */ }

            const VALID_STATS = new Set(['PWR', 'SPD', 'WIL', 'VIT', 'RES', 'FOC']);
            const stat: string = VALID_STATS.has(adjudicated.stat as string) ? (adjudicated.stat as string) : 'PWR';
            const advantage = adjudicated.advantage === 'advantage';
            const disadvantage = adjudicated.advantage === 'disadvantage';
            const validPositions = new Set(['cover', 'elevated', 'exposed', 'none']);
            const positionTag = validPositions.has(adjudicated.positionTag as string) && adjudicated.positionTag !== 'none'
                ? (adjudicated.positionTag as 'cover' | 'elevated' | 'exposed') : undefined;
            const momentumToken = adjudicated.momentumToken === 1;

            const validRisks = new Set(['none', 'prone', 'exposed', 'drop_weapon', 'self_stagger']);
            const riskOnFail: RiskOnFail = validRisks.has(adjudicated.riskOnFail as string) ? (adjudicated.riskOnFail as RiskOnFail) : 'none';

            const base = source.baseAction;
            const actor = combatState.combatants[base.actorId];
            let attackBonus = base.attackBonus;
            let scalingStatMod = base.scalingStatMod;
            if (actor) {
                const mod = abilityMod(actor.stats[stat as keyof typeof actor.stats] ?? actor.stats.PWR);
                attackBonus = mod + actor.proficiencyBonus;
                scalingStatMod = mod;
            }

            actions = [{
                ...base,
                attackBonus,
                scalingStatMod,
                advantage: advantage || momentumToken,
                disadvantage,
                newPosition: positionTag,
                riskOnFail: riskOnFail !== 'none' ? riskOnFail : undefined,
            }];
        }
    }

    const itemsMap = callbacks.items ? Object.fromEntries(callbacks.items.map(i => [i.id, i])) : undefined;
    const skillsMap = callbacks.skills ? Object.fromEntries(callbacks.skills.map(s => [s.id, s])) : undefined;
    const turnResult = runCombatTurn({ combatState, actions, items: itemsMap, skills: skillsMap });

    callbacks.setCombatState(turnResult.combatState);

    const ledgerMsg = emitCombatLedgerMessage(turnResult.ledgerLine, turnResult.combatState.round, turnResult.resolutions, turnResult.combatState);
    callbacks.addMessage(ledgerMsg);

    if (turnResult.terminated) {
        // Clear the live fight (HUD closes via combatState). Leave combatModeActive (the
        // feature master switch) ON — ending one fight must not disable Combat Mode.
        callbacks.terminateCombat({ writeBack: true });
    }

    if (llmCallCount < 2) {
        await callbacks.narrateCombatOutcome(
            turnResult.ledgerLine,
            turnResult.resolutions,
            turnResult.combatState,
        );
    }
}

export function buildCombatNarrationPrompt(
    ledgerLine: string,
    resolutions: ActionResolution[],
    combatState: CombatState,
    playerDescription?: string,
): string {
    const nameOf = (id?: string) => (id && combatState.combatants[id]?.name) || id || '?';

    const resolutionParts = resolutions.map(r => {
        const actor = nameOf(r.actorId);
        const target = nameOf(r.targetId);
        if (r.rejected) return `${actor}: action rejected (${r.rejectionReason})`;
        if (r.type === 'attack') return `${actor} → ${target}: ${r.hit ? 'HIT' : 'MISS'}${r.critical ? ' (CRIT)' : ''} — ${r.damage ?? 0} damage (roll ${r.naturalRoll}+mod=${r.total})`;
        if (r.type === 'heal') {
            const tgt = r.targetId && r.targetId !== r.actorId ? `${actor} → ${target}` : actor;
            return `${tgt}: healed ${r.healed ?? 0} HP${r.focSpent ? ` (spent ${r.focSpent} FOC)` : ''}`;
        }
        if (r.type === 'mental') return `${actor} → ${target}: ${r.saved ? 'RESISTED' : 'AFFECTED'}${r.damage ? ` — ${r.damage} damage` : ''} (roll ${r.naturalRoll}+mod=${r.total})`;
        if (r.type === 'defend') return `${actor}: braced (+${r.focRecovered ?? 0} FOC)`;
        if (r.type === 'move') return `${actor}: moved${r.newPosition ? ` to ${r.newPosition}` : ''}${r.newRangeRelation ? ` (now ${r.newRangeRelation})` : ''}`;
        return `${actor}: ${r.type}`;
    });

    const combatantSummary = Object.values(combatState.combatants)
        .filter(c => c.currentHP > 0)
        .map(c => `${c.name}: HP ${c.currentHP}/${c.maxHP} FOC ${c.currentFOC}/${c.maxFOC}${c.position ? ` [${c.position}]` : ''}`)
        .join('; ');

    let prompt = `[COMBAT ENGINE RESULT — narrate this outcome, numbers are FINAL from engine]\n` +
        `Ledger: ${ledgerLine}\n` +
        `Resolutions: ${resolutionParts.join(' | ')}\n` +
        `Survivors: ${combatantSummary}`;
    if (playerDescription) {
        prompt += `\nPlayer intent: ${playerDescription}`;
    }
    return prompt;
}

/**
 * Phase C: build a FULL-context narration payload for a combat round.
 *
 * Instead of a naked one-shot prompt, the engine result is fed as the final user/context turn of
 * the real story payload — system prompt + canon + volatile (incl. the live [COMBAT STATE] block)
 * + lore RAG + active NPCs + recent history (ledger lines retained). The narration therefore reads
 * in-voice and in-context.
 *
 * Cost discipline: this reuses the *synchronous* `buildPayload` + keyword lore retrieval only — it
 * fires ZERO auxiliary LLM/embedding calls, preserving the per-round budget (adjudicate + narrate).
 */
export function buildCombatNarrationPayload(opts: {
    settings: AppSettings;
    context: GameContext;
    messages: ChatMessage[];
    npcLedger: NPCEntry[];
    loreChunks: LoreChunk[];
    combatState: CombatState;
    ledgerLine: string;
    resolutions: ActionResolution[];
    playerDescription?: string;
    onStageNpcIds?: string[];
}): OpenAIMessage[] {
    const resultBlock = buildCombatNarrationPrompt(opts.ledgerLine, opts.resolutions, opts.combatState, opts.playerDescription);

    const loreQuery = [opts.playerDescription, opts.ledgerLine].filter(Boolean).join(' ');
    const relevantLore = opts.loreChunks.length > 0
        ? retrieveRelevantLore(opts.loreChunks, loreQuery, 1200, opts.messages)
        : undefined;

    const { messages } = buildPayload({
        settings: opts.settings,
        context: opts.context,
        history: opts.messages,
        userMessage: resultBlock,
        relevantLore,
        npcLedger: opts.npcLedger,
        onStageNpcIds: opts.onStageNpcIds,
        combatState: opts.combatState,
    });

    return messages;
}
