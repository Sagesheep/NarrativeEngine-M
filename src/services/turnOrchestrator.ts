import { type TurnCallbacks, type TurnState } from './turnTypes';
export type { TurnCallbacks, TurnState } from './turnTypes';
import { uid } from '../utils/uid';
import { sendMessage } from './chatEngine';
import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from './payload';
import { rollEngines, rollDiceFairness, rollCharacterIntroEngine } from './engine';
import { toast } from '../components/Toast';
import { sanitizePayloadForApi } from './payloadSanitizer';
import { gatherContext } from './turnContext';
import { handlePostTurn } from './turnPostProcess';
import { getToolDefinitions, handleLoreTool, handleNotebookTool, handleDiceTool } from './toolHandlers';

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

    // Async character introduction engine (Phase 4)
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

    callbacks.setLoadingStatus?.('[1/5] Extracting Lore & Stats...');

    callbacks.setPipelinePhase?.('gathering-context');
    const gathered = await gatherContext(state, callbacks, finalInput, userMsgId);

    callbacks.setPipelinePhase?.('building-prompt');
    const { payloadResult } = gathered;

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }

    callbacks.updateLastMessage({ debugPayload: payload });

    const triggerAutoTrim = () => {
        if (!activeCampaignId) return;
        const currentMsgs = state.getMessages();
        const newIndex = computeTrimIndex(currentMsgs, condenser.condensedUpToIndex);
        if (newIndex !== condenser.condensedUpToIndex) {
            callbacks.setCondensed(newIndex);
        }
    };

    const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0) => {
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

                    currentPayload.push({
                        role: 'assistant',
                        content: finalText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('./llmService').OpenAIMessage);

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

                    currentPayload.push({
                        role: 'tool',
                        content: toolResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('./llmService').OpenAIMessage);

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

                    currentPayload.push({
                        role: 'assistant',
                        content: finalText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('./llmService').OpenAIMessage);

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

                    currentPayload.push({
                        role: 'tool',
                        content: toolResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('./llmService').OpenAIMessage);

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

                    currentPayload.push({
                        role: 'assistant',
                        content: finalText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('./llmService').OpenAIMessage);

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

                    currentPayload.push({
                        role: 'tool',
                        content: toolResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('./llmService').OpenAIMessage);

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
                callbacks.updateLastAssistant(finalText);
                if (reasoningContent) {
                    callbacks.updateLastMessage({ reasoning_content: reasoningContent });
                }

                const allMsgs = state.getMessages();
                const lastAssistant = allMsgs[allMsgs.length - 1];

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

                callbacks.setPipelinePhase?.('idle');
                callbacks.setStreamingStats?.(null);
                callbacks.setStreaming(false);
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
