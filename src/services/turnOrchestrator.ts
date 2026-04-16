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
import { TOOL_DEFINITIONS, handleLoreTool } from './toolHandlers';

export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, condenser, npcLedger, loreChunks, activeCampaignId, provider } = state;

    if (!provider) return;

    let finalInput = input;
    const engineResult = rollEngines(context);
    finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);
    finalInput += rollDiceFairness(context);

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

    const gathered = await gatherContext(state, callbacks, finalInput);

    const { payloadResult } = gathered;

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }

    callbacks.updateLastMessage({ debugPayload: payload });

    const triggerCondense = async () => {
        if (condenser.isCondensing || !activeCampaignId) return;
        callbacks.setCondensing(true);
        try {
            const currentProvider = state.getFreshProvider();
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
                abortController.signal
            );
            callbacks.setCondensed(result.summary, result.upToIndex);

            const freshIndex = await api.archive.getIndex(activeCampaignId);
            callbacks.setArchiveIndex(freshIndex);
            console.log(`[Archive] Reloaded index: ${freshIndex.length} entries`);
        } catch (err) {
            console.error('[Condenser]', err);
            toast.error('Auto-condense failed');
        } finally {
            callbacks.setCondensing(false);
        }
    };

    const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0) => {
        const assistantMsgId = uid();
        callbacks.addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
        callbacks.setStreaming(true);

        const allowTools = toolCallCount < 2 && apiRetryCount < 2;
        const requestPayload = sanitizePayloadForApi(currentPayload, allowTools);

        const tools = allowTools ? [...TOOL_DEFINITIONS] : undefined;

        callbacks.setLoadingStatus?.(null);
        await sendMessage(
            provider,
            requestPayload,
            (fullText) => callbacks.updateLastAssistant(fullText),
            async (finalText, toolCall) => {
                if (toolCall && toolCall.name === 'query_campaign_lore') {
                    callbacks.onCheckingNotes(true);
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
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('./llmService').OpenAIMessage);

                    const { toolResult } = handleLoreTool(toolCall.arguments, { loreChunks });

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
                        callbacks.onCheckingNotes(false);
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                callbacks.setStreaming(false);
                callbacks.onCheckingNotes(false);
                callbacks.updateLastAssistant(finalText);

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
            },
            (err) => {
                if (err === 'AbortError' || (err as any)?.name === 'AbortError' || err === 'The user aborted a request.') {
                    return;
                }
                if (apiRetryCount === 0) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    toast.warning('LLM request failed — retrying...');
                    setTimeout(() => executeTurn(currentPayload, toolCallCount, 1), 2000);
                } else if (apiRetryCount === 1) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                    toast.warning('Retry failed — trying without tools...');
                    setTimeout(() => executeTurn(currentPayload, 999, 2), 2000);
                } else {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}`);
                    toast.error('LLM request failed after retries');
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                }
            },
            tools,
            abortController
        );
    };

    await executeTurn(payload);
}
