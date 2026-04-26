import type { LLMProvider } from '../types';
import { type TurnCallbacks, type TurnState } from './turnTypes';
export type { TurnCallbacks, TurnState } from './turnTypes';
import { uid } from '../utils/uid';
import { sendMessage } from './chatEngine';
import { shouldCondense, condenseHistory } from './condenser';
import { runSaveFilePipeline } from './saveFileEngine';
import { rollEngines, rollDiceFairness } from './engineRolls';
import { api } from './apiClient';
import { toast } from '../components/Toast';
import { sanitizePayloadForApi } from './payloadSanitizer';
import { handleInterventions } from './aiPlayers';
import { gatherContext } from './turnContext';
import { handlePostTurn } from './turnPostProcess';
import { TOOL_DEFINITIONS, handleLoreTool, handleNotebookTool } from './toolHandlers';

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

    callbacks.setPipelinePhase?.('ai-intervention');
    await handleInterventions(state, callbacks, finalInput, abortController);

    const userMsgId = uid();
    callbacks.addMessage({
        id: userMsgId,
        role: 'user',
        content: finalInput,
        displayContent: displayInput,
        timestamp: Date.now()
    });
    callbacks.setStreaming(true);
    callbacks.setLoadingStatus?.('[1/5] Extracting Lore & Stats...');

    callbacks.setPipelinePhase?.('gathering-context');
    const gathered = await gatherContext(state, callbacks, finalInput);

    callbacks.setPipelinePhase?.('building-prompt');
    const { payloadResult } = gathered;

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }

    callbacks.updateLastMessage({ debugPayload: payload });

    const triggerCondense = async () => {
        if (condenser.isCondensing || !activeCampaignId) return;
        callbacks.setCondensing(true);
        const condenseController = new AbortController();
        try {
            const currentProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
            if (!currentProvider) return;

            const currentMsgs = state.getMessages();
            const uncondensed = currentMsgs.slice(condenser.condensedUpToIndex + 1);

            try {
                const saveResult = await runSaveFilePipeline(currentProvider as LLMProvider, uncondensed, context, undefined, undefined);
                if (saveResult.canonSuccess) callbacks.updateContext({ canonState: saveResult.canonState });
                if (saveResult.indexSuccess) callbacks.updateContext({ headerIndex: saveResult.headerIndex });
                console.log(`[SavePipeline] Canon: ${saveResult.canonSuccess ? '✓' : '✗'}, Index: ${saveResult.indexSuccess ? '✓' : '✗'}`);

                if (saveResult.coreMemorySlots) {
                    callbacks.updateContext({ coreMemorySlots: saveResult.coreMemorySlots });
                }
            } catch (err) {
                toast.warning('Save pipeline failed — state not updated');
            }

            const result = await condenseHistory(
                currentProvider,
                currentMsgs,
                context,
                condenser.condensedUpToIndex,
                condenser.condensedSummary,
                activeCampaignId,
                npcLedger.map(n => n.name),
                settings.contextLimit,
                condenseController.signal
            );
            callbacks.setCondensed(result.summary, result.upToIndex);

            const freshIndex = await api.archive.getIndex(activeCampaignId);
            callbacks.setArchiveIndex(freshIndex);
            console.log(`[Archive] Reloaded index: ${freshIndex.length} entries`);
        } catch (err) {
            if ((err as Error).name !== 'AbortError') {
                console.error('[Condenser]', err);
                toast.error('Auto-condense failed');
            }
        } finally {
            callbacks.setCondensing(false);
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
        const requestPayload = sanitizePayloadForApi(currentPayload, allowTools);

        const tools = allowTools ? [...TOOL_DEFINITIONS] : undefined;

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
                        }]
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
                        }]
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

                callbacks.setStreaming(false);
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

                if (settings.autoCondenseEnabled && shouldCondense(allMsgs, settings.contextLimit, condenser.condensedUpToIndex)) {
                    triggerCondense();
                }

                callbacks.setPipelinePhase?.('idle');
                callbacks.setStreamingStats?.(null);
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
