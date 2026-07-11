import { type TurnCallbacks, type TurnState } from './turnTypes';
export type { TurnCallbacks, TurnState } from './turnTypes';
import { tierAllows } from './aiTier';
import { uid } from '../../utils/uid';
import { sendMessage } from '../chatEngine';
import { rollEngines, rollDiceFairness, rollCharacterIntroEngine, resolveManualRoll, resolveLootDrop } from '../engine';
import { recordLootDrop } from '../engine/lootDropTelemetry';
import { notify } from '../ports/notify';
import { sanitizePayloadForApi } from '../llm/payloadSanitizer';
import { gatherContext } from './turnContext';
import { getToolDefinitions, handleLoreTool, handleNotebookTool, handleDiceTool } from './toolHandlers';
import { extractAndStripSceneStakes } from './sceneStakesTag';
import { capturePendingTurnSnapshot, getActiveSnapshotId } from './pendingCommit';
import type { GatheredContext } from './turnContext';

import type { OpenAIMessage } from '../llm/llmService';
import type { PayloadTrace, ResolveLootOpts, SwipeVariant } from '../../types';
import { buildAssistantToolCallMessage, buildToolResultMessage } from '../../types/llmMessages';

// Smart Retry v1: build the collapsed-box summary for the precontext field.
// Kept short and non-technical — the user taps to expand for details (v2).
function buildPrecontextSummary(gathered: GatheredContext): string {
    const parts: string[] = [];
    if (gathered.relevantLore?.length) parts.push(`Lore×${gathered.relevantLore.length}`);
    if (gathered.relevantRules?.length) parts.push(`Rules×${gathered.relevantRules.length}`);
    if (gathered.archiveRecall?.length) parts.push(`Archive×${gathered.archiveRecall.length}`);
    if (gathered.semanticArchiveHits?.length) parts.push(`Hits×${gathered.semanticArchiveHits.length}`);
    if (gathered.recommendedNPCNames?.length) parts.push(`NPCs×${gathered.recommendedNPCNames.length}`);
    if (gathered.deepContextSummary) parts.push('DeepScan');
    return parts.length ? parts.join(' · ') : 'Context gathered';
}

// Smart Retry v1: stamp the terminal assistant bubble as retryable + attach the
// precontext ref. Called from every abort/failure exit branch (2.5, 3.5, 4).
// `assistantMsgId` is the id of the bubble to stamp; `gathered` provides the
// summary; the capturedPayloadRef matches the in-memory snapshot's snapshotId.
function stampRetryable(
    callbacks: TurnCallbacks,
    assistantMsgId: string,
    gathered: GatheredContext,
): void {
    const ref = getActiveSnapshotId();
    if (!ref) return;
    callbacks.updateLastMessage?.({
        retryable: true,
        precontext: { summary: buildPrecontextSummary(gathered), capturedPayloadRef: ref },
    });
    void assistantMsgId;
}

export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, npcLedger, loreChunks, activeCampaignId, provider } = state;

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
        const r = resolveManualRoll(armed, context.diceSystem);
        const rollsLabel = r.rolls.length > 1 ? ` (rolled ${r.rolls.join(', ')})` : '';
        const tierLabel = r.tier ?? 'Unmapped';
        finalInput += `\n[RESOLVED ROLL — ${r.detail} → ${tierLabel} (${r.faceValue})${rollsLabel}. This HAPPENED. The outcome is fixed — do not re-roll, do not alter the tier, do not skip the roll. Narrate the consequence.]`;
        // Player-facing reveal — shows on their own turn bubble.
        displayInputFinal += `\n\n🎲 ${r.detail} → ${tierLabel} (${r.faceValue})`;
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
        const lootOpts: ResolveLootOpts = {
            rolls: armedLoot.rolls,
            profile: armedLoot.reweight ? { reweight: armedLoot.reweight } : undefined,
        };
        const loot = resolveLootDrop(context.lootTree, lootOpts);
        // Record for the debug surfaces (DebugPanel + context-bank diagnostics).
        // Telemetry is fire-and-forget; never throws into the turn pipeline.
        try { recordLootDrop(loot, lootOpts); } catch (e) { console.warn('[LootEngine] telemetry failed:', e); }
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

    // Smart Retry v1: capture the precontext snapshot BEFORE the story AI runs.
    // The success path re-captures at line ~380 with tool-call history + complete
    // messages (idempotent singleton overwrite). The failure/abort path keeps
    // this early capture so the Retry button can re-enter executeTurn without
    // regathering. Pass `displayInput` (raw typed text, no 🎲/💰 reveal) to
    // preserve today's archive semantics exactly.
    capturePendingTurnSnapshot(state, payload, displayInput);

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

                    const { toolResult } = handleDiceTool(toolCall.arguments, { diceSystem: context.diceSystem });
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

                // ── Scene stakes tag: parse + strip from display text (per variant) ──
                // The tag is stripped from EVERY swipe's display text and the parsed
                // stakes are stored ON the variant. lastSceneStakes / classifySceneStakes
                // fallback run only at commit (commitPendingTurn), never per swipe.
                const { displayText: stakesStrippedText, stakes: parsedStakes } = extractAndStripSceneStakes(finalText);
                const tagPresent = parsedStakes !== 'calm' || finalText !== stakesStrippedText;

                callbacks.updateLastAssistant(stakesStrippedText);
                if (reasoningContent) {
                    callbacks.updateLastMessage({ reasoning_content: reasoningContent });
                }

                const allMsgs = state.getMessages();
                const lastAssistant = allMsgs[allMsgs.length - 1];

                // ── Swipe Generation v1: true lazy commit path ──
                // Swipe 1/1 does NOT fire handlePostTurn. Instead, snapshot the
                // TurnState (the ORIGINAL reference — bumpOnStageActivity reads
                // state.onStageNpcIds as the PREVIOUS turn's on-stage set), capture
                // the cached payload (for swipes 2–5), and stamp the assistant
                // message with pendingCommit=true + a 1-variant swipeSet. The
                // visible variant becomes canonical on commit (commitPendingTurn),
                // fired by: user sends next message, timeskip, Arc Injector,
                // campaign switch. Backgrounding the app does NOT commit.
                if (lastAssistant?.role === 'assistant' && activeCampaignId) {
                    const variant: SwipeVariant = {
                        id: uid(),
                        text: stakesStrippedText,
                        reasoningContent: reasoningContent || undefined,
                        sceneStakes: parsedStakes,
                        tagPresent,
                    };

                    // Persist pendingCommit marker + minimal snapshot to IndexedDB
                    // (rides the existing debouncedSaveCampaignState on the message).
                    // Crash safety: on app launch, reconcilePendingCommitOnLaunch
                    // fires handlePostTurn with the then-visible variant, then clears.
                    // Smart Retry v1: this refresh overwrites the early capture with
                    // tool-call history + complete messages (Fable 5 findings 1 & 2).
                    capturePendingTurnSnapshot(state, currentPayload, displayInput);

                    // Smart Retry v1: stamp `precontext` atomic with swipeSet
                    // (per Fable 5 finding 3 — terminal-point stamping). Clear
                    // `retryable` since the story AI succeeded. Read the ref AFTER
                    // the refresh so capturedPayloadRef matches the new snapshotId.
                    const ref = getActiveSnapshotId();
                    callbacks.updateLastMessage({
                        swipeSet: [variant],
                        pendingCommit: true,
                        swipeActiveIndex: 0,
                        retryable: undefined,
                        ...(ref ? { precontext: { summary: buildPrecontextSummary(gathered), capturedPayloadRef: ref } } : {}),
                    });
                }

                callbacks.setPipelinePhase?.('idle');
                callbacks.setStreamingStats?.(null);
                callbacks.setStreaming(false);
            },
            (err) => {
                if (err === '__ABORT__' || err === 'AbortError' || err === 'The user aborted a request.') {
                    // Smart Retry v1: user pressed Stop. Stamp the (partial) terminal
                    // assistant bubble as retryable so the Retry button renders. The
                    // early-captured snapshot (pre-story-AI) is still in memory and
                    // can re-enter executeTurn without regathering.
                    stampRetryable(callbacks, assistantMsgId, gathered);
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setPipelinePhase?.('idle');
                    callbacks.setStreamingStats?.(null);
                    return;
                }
                if (apiRetryCount === 0) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    notify.warning('LLM request failed — retrying...');
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
                    notify.warning('Retry failed — trying without tools...');
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
                    notify.error('LLM request failed after retries');
                    // Smart Retry v1: final retry exhaustion — stamp retryable so the
                    // user can retry from the cached precontext without regathering.
                    stampRetryable(callbacks, assistantMsgId, gathered);
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
