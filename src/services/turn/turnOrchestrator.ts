import { type TurnCallbacks, type TurnState } from './turnTypes';
export type { TurnCallbacks, TurnState } from './turnTypes';
import { tierAllows } from './aiTier';
import { uid } from '../../utils/uid';
import { sendMessage } from '../chatEngine';
import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from '../payload';
import { rollEngines, rollDiceFairness, rollCharacterIntroEngine, resolveManualRoll, resolveLootDrop } from '../engine';
import { toast } from '../../components/Toast';
import { sanitizePayloadForApi } from '../llm/payloadSanitizer';
import { gatherContext } from './turnContext';
import { handlePostTurn } from './turnPostProcess';
import { getToolDefinitions, handleLoreTool, handleNotebookTool, handleDiceTool } from './toolHandlers';
import { extractAndStripSceneStakes, classifySceneStakes } from './sceneStakesTag';

import type { OpenAIMessage } from '../llm/llmService';
import type { PayloadTrace } from '../../types';
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
    let displayInputFinal = displayInput;
    const engineResult = rollEngines(context);
    finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);

    // Player-called dice ("dice me"). When the player armed a roll, resolve REAL dice now
    // (hidden until this commit), assert the tier as FACT, and SUPPRESS the auto pool menu +
    // dice tool for this turn so the model gets exactly one signal it cannot cherry-pick.
    const armed = state.armedRoll;
    if (armed) {
        const r = resolveManualRoll(armed, context.diceConfig);
        const rollsLabel = r.rolls.length > 1 ? ` (rolled ${r.rolls.join(', ')})` : '';
        finalInput +=
            `\n[RESOLVED ROLL — ${r.detail}: ${r.faceValue}${rollsLabel} → ${r.tier}. ` +
            `This HAPPENED. Narrate the consequence as fact; do NOT soften, re-roll, or treat it as optional.]`;
        // Player-facing reveal — shows on their own turn bubble.
        displayInputFinal += `\n\n🎲 ${r.detail} → ${r.tier} (${r.faceValue})`;
    } else {
        finalInput += rollDiceFairness(context);
    }

    // Loot Engine WO-05: player-armed loot drop. Mirrors the dice block above —
    // the engine returns a BARE `[LOOT DROP: ...]` tag and the orchestrator adds
    // the fact-assertion wrapper. The caller (ChatArea) clears `armedLoot`
    // before runTurn, exactly as it clears `armedRoll` — so this only reads the
    // captured value. The engine is pure: dice + JSON, zero LLM at runtime.
    const armedLoot = state.armedLoot;
    if (armedLoot && context.lootTree) {
        const loot = resolveLootDrop(context.lootTree, {
            rolls: armedLoot.rolls,
            profile: armedLoot.reweight ? { reweight: armedLoot.reweight } : undefined,
        });
        if (loot.appendToInput) {
            // Inject the fact-assertion INSIDE the closing bracket so the whole
            // block reads as one engine signal — matches the [RESOLVED ROLL — ...]
            // precedent. The engine returns a bare `\n[LOOT DROP: ...]`; we own the
            // wrapper here. (Assertion OUTSIDE the bracket reads as player OOC text
            // the model can refuse — which is why it was saying "there is no loot".)
            const bare = loot.appendToInput.replace(/\]$/, '');
            finalInput +=
                bare +
                ` — this loot DROPPED. Narrate the player finding it as fact; ` +
                `do NOT change its identity, inflate it, or add items beyond this list.]`;
            // Player-facing reveal — shows the drop on their own turn bubble.
            displayInputFinal += `\n\n💰 Loot drop armed (${armedLoot.rolls})`;
        }
    }

    const userMsgId = uid();
    callbacks.addMessage({
        id: userMsgId,
        role: 'user',
        content: finalInput,
        displayContent: displayInputFinal,
        timestamp: Date.now()
    });
    callbacks.setStreaming(true);

    // Async character introduction engine (Phase 4) — Max tier only
    if (tierAllows(settings.aiTier, 'introEngine')) {
        const pm = state.npcPressure ?? {};
        const seenNpcNames = npcLedger
            .filter(npc => (pm[npc.id]?.engaged ?? 0) > 0)
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

    // Tool calls fire after the snapshot above; append a row each time a tool result is
    // folded back into the payload and re-publish so the debug panel includes them too.
    const liveTrace: PayloadTrace[] = payloadResult.trace ? [...payloadResult.trace] : [];
    const pushToolTrace = (name: string, args: string, result: string) => {
        if (!settings.debugMode || !callbacks.setLastPayloadTrace) return;
        liveTrace.push({
            source: `Tool Call — ${name}`,
            classification: 'world_context',
            tokens: Math.round((args.length + result.length) / 4),
            reason: `Model called ${name}; result folded back into the payload`,
            included: true,
            position: 'tool',
            preview: `↳ ARGS:\n${args}\n\n↳ RESULT:\n${result}`,
        });
        callbacks.setLastPayloadTrace([...liveTrace]);
    };

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

        // Suppress the dice tool when the player armed a manual roll — the resolved fact is
        // already in the payload; offering the tool too would let the model double-roll.
        const allowDiceTool = context.diceFairnessActive === false && !armed;
        const tools = allowTools ? getToolDefinitions({ allowDiceTool }) : undefined;

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
                    pushToolTrace(toolCall.name, toolCall.arguments, toolResult);

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
                    pushToolTrace(toolCall.name, toolCall.arguments, toolResult);
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
                    pushToolTrace(toolCall.name, toolCall.arguments, toolResult);

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

                // ── Scene stakes tag: parse + strip from display text (§9.3#2) ──
                const { displayText: stakesStrippedText, stakes: parsedStakes } = extractAndStripSceneStakes(finalText);
                let sceneStakes = parsedStakes;
                const tagWasPresent = parsedStakes !== 'calm' || finalText !== stakesStrippedText;
                if (!tagWasPresent) {
                    const utilityProvider = state.getUtilityEndpoint?.();
                    if (utilityProvider && tierAllows(settings.aiTier, 'sceneStakesClassify')) {
                        try {
                            const recentScene = state.messages.slice(-3).map(m => {
                                const role = m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
                                return `[${role}]: ${(m.content || '').slice(0, 500)}`;
                            }).join('\n\n');
                            sceneStakes = await classifySceneStakes(utilityProvider, recentScene + '\n\n' + finalText.slice(0, 1000));
                        } catch (e) {
                            console.warn('[TurnOrchestrator] scene-stakes fallback classify failed:', e);
                        }
                    }
                }
                callbacks.updateContext({ lastSceneStakes: sceneStakes });

                callbacks.updateLastAssistant(stakesStrippedText);
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
