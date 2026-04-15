import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, EndpointConfig, ProviderConfig, SemanticFact, ArchiveChapter, ArchiveScene } from '../types';
import { uid } from '../utils/uid';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs } from './chatEngine';
import { shouldCondense, condenseHistory } from './condenser';
import { runSaveFilePipeline } from './saveFileEngine';
import { retrieveRelevantLore, searchLoreByQuery } from './loreRetriever';
import { recallArchiveScenes } from './archiveMemory';
import { countTokens } from './tokenizer';
import { rollEngines, rollDiceFairness } from './engineRolls';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { api } from './apiClient';
import { offlineStorage } from './offlineStorage';
import { recommendContext } from './contextRecommender';
import { toast } from '../components/Toast';
import { shouldAutoSeal, sealChapter, recallWithChapterFunnel } from './archiveChapterEngine';
import { fetchFacts, queryFacts, formatFactsForContext } from './semanticMemory';
import { formatResolvedForContext } from './timelineResolver';
import { useAppStore } from '../store/useAppStore';
import { loadChapters } from '../store/campaignStore';
import { backgroundQueue } from './backgroundQueue';
import { llmQueue } from './llmRequestQueue';
import { isEmbedderReady } from './embedder';
import { semanticSearch } from './vectorSearch';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';

export type TurnCallbacks = {
    onCheckingNotes: (checking: boolean) => void;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    addNPC: (npc: NPCEntry) => void;
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondensing: (v: boolean) => void;
    setStreaming: (v: boolean) => void;
    setLastPayloadTrace?: (trace: any) => void;
    setLoadingStatus?: (status: string | null) => void;
    setSemanticFacts?: (facts: SemanticFact[]) => void;
    setChapters?: (chapters: ArchiveChapter[]) => void;
};

export type TurnState = {
    input: string;
    displayInput: string;
    settings: AppSettings;
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    loreChunks: LoreChunk[];
    npcLedger: NPCEntry[];
    archiveIndex: ArchiveIndexEntry[];
    semanticFacts: SemanticFact[];
    chapters: ArchiveChapter[];
    activeCampaignId: string | null;
    provider: EndpointConfig | ProviderConfig | undefined;
    getMessages: () => ChatMessage[]; // to get fresh messages midway
    getFreshProvider: () => EndpointConfig | ProviderConfig | undefined;
    getUtilityEndpoint?: () => EndpointConfig | undefined; // optional — context recommender
    forcedInterventions?: ('enemy' | 'neutral' | 'ally')[]; // For manual triggers from UI
    incrementBookkeepingTurnCounter: () => number;
    autoBookkeepingInterval: number;
    resetBookkeepingTurnCounter: () => void;
};

const sanitizePayloadForApi = (rawPayload: any[], allowTools: boolean) => {
    const cleaned: any[] = [];
    const openToolCalls = new Set<string>();

    for (const msg of rawPayload) {
        if (!msg || typeof msg !== 'object') continue;

        if (msg.role === 'assistant') {
            if (!allowTools || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
                const { tool_calls, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            const validCalls = msg.tool_calls.filter((tc: any) =>
                tc && tc.type === 'function' && typeof tc.id === 'string' &&
                tc.function && typeof tc.function.name === 'string'
            );

            if (validCalls.length === 0) {
                const { tool_calls, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            cleaned.push({ ...msg, tool_calls: validCalls });
            for (const tc of validCalls) openToolCalls.add(tc.id);
            continue;
        }

        if (msg.role === 'tool') {
            if (!allowTools) continue;

            const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (!callId || !openToolCalls.has(callId)) {
                console.warn('[Payload] Dropping orphan tool message:', msg.tool_call_id);
                continue;
            }

            openToolCalls.delete(callId);
            cleaned.push(msg);
            continue;
        }

        cleaned.push(msg);
    }

    return cleaned;
};

export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, messages, condenser, loreChunks, npcLedger, archiveIndex, activeCampaignId, provider } = state;

    if (!provider) return;

    let finalInput = input;
    const engineResult = rollEngines(context);
    finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);
    finalInput += rollDiceFairness(context);

    // --- AI INTERVENTION PHASE (Enemy, Neutral, Ally) ---
    await handleInterventions(state, callbacks, finalInput, abortController);
    
    // Provide immediate UI feedback by adding the user message synchronously before heavy async operations
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

    let semanticArchiveIds: string[] | undefined;
    let semanticLoreIds: string[] | undefined;

    if (isEmbedderReady() && activeCampaignId) {
        try {
            const [sceneIds, loreIds] = await Promise.all([
                semanticSearch(activeCampaignId, finalInput, 'scene', 20),
                semanticSearch(activeCampaignId, finalInput, 'lore', 15),
            ]);
            semanticArchiveIds = sceneIds;
            semanticLoreIds = loreIds;

            if (semanticArchiveIds?.length) {
                console.log(`[Semantic] Found ${semanticArchiveIds.length} scene candidates: [${semanticArchiveIds.join(', ')}]`);
            }
            if (semanticLoreIds?.length) {
                console.log(`[Semantic] Found ${semanticLoreIds.length} lore candidates: [${semanticLoreIds.join(', ')}]`);
            }
        } catch (e) {
            console.warn('[Semantic] Candidate search failed, using keyword fallback:', e);
        }
    }

    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, input, 1200, messages, semanticLoreIds)
        : undefined;

    let sceneNumber: string | undefined;
    if (activeCampaignId) {
        callbacks.setLoadingStatus?.('[2/5] Fetching Timeline...');
        try {
            const nextScene = await offlineStorage.archive.getNextSceneNumber(activeCampaignId);
            sceneNumber = String(nextScene).padStart(3, '0');
            console.log(`[Scene Engine] Pre-assigned scene #${sceneNumber}`);
        } catch { /* ignored */ }
    }

    // --- ARCHIVE RECALL ---
    callbacks.setLoadingStatus?.('[3/5] Recalling Archive Memory...');
    
    let archiveResult = { scenes: [] as ArchiveScene[], usedTokens: 0 };
    const { chapters, semanticFacts } = state;
    
    if (chapters.length > 0 && activeCampaignId) {
        // Use chapter-aware retrieval
        try {
            const utilityEndpoint = state.getUtilityEndpoint?.();
            const funnelPromise = recallWithChapterFunnel(
                activeCampaignId,
                chapters,
                archiveIndex,
                input,
                messages,
                npcLedger,
                semanticFacts,
                3000,
                utilityEndpoint!,
                undefined,
                semanticArchiveIds
            );
            const fallbackPromise = new Promise<{ scenes: string; usedTokens: number } | null>(resolve => setTimeout(resolve, 5000)).then(() => null);

            const result = await Promise.race([funnelPromise, fallbackPromise]);
            if (result) {
                // Funnel returns { scenes: string; usedTokens: number }
                archiveResult = { scenes: [] as ArchiveScene[], usedTokens: result.usedTokens };
                // Convert scene text back to ArchiveScene array
                const sceneMatches = (result.scenes as string).match(/--- SCENE (\d+) ---\n([\s\S]*?)(?=\n--- SCENE \d+ ---|$)/g);
                if (sceneMatches) {
                    archiveResult.scenes = sceneMatches.map(match => {
                        const idMatch = match.match(/--- SCENE (\d+) ---/);
                        const content = match.replace(/--- SCENE \d+ ---\n/, '').trim();
                        return { sceneId: idMatch ? idMatch[1] : '', content, tokens: countTokens(content) };
                    });
                }
            }
        } catch {
            // Fallback to flat retrieval
            if (activeCampaignId) {
                const flatRecall = await recallArchiveScenes(activeCampaignId, archiveIndex, input, messages, 3000, npcLedger, semanticFacts, semanticArchiveIds);
                archiveResult = { scenes: flatRecall || [], usedTokens: 0 };
            }
        }
    } else if (archiveIndex.length > 0 && activeCampaignId) {
        // No chapters, use flat retrieval with upgraded scoring
        const flatRecall = await recallArchiveScenes(
            activeCampaignId, archiveIndex, input, messages, 3000,
            npcLedger, semanticFacts, semanticArchiveIds
        );
        archiveResult = { scenes: flatRecall || [], usedTokens: 0 };
    }

    const archiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    // --- SEMANTIC FACTS ---
    let semanticFactText = '';
    try {
        semanticFactText = formatFactsForContext(
            queryFacts(semanticFacts, finalInput, messages, npcLedger, 500)
        );
    } catch {
        // Non-critical, continue without facts
    }

    // --- RESOLVED WORLD STATE ---
    try {
        const timeline = useAppStore.getState().timeline;
        if (timeline && timeline.length > 0) {
            const resolvedText = formatResolvedForContext(
                (await import('./timelineResolver')).resolveTimeline(timeline)
            );
            if (resolvedText) semanticFactText += '\n' + resolvedText;
        }
    } catch {
        // Non-critical
    }

    // ── Utility AI Context Recommender ──
    // If a utilityAI endpoint is configured, ask it which NPCs/lore are relevant.
    // On any failure, fall back silently to substring matching (recommendedNPCNames stays undefined).
    let recommendedNPCNames: string[] | undefined;

    const utilityEndpoint = state.getUtilityEndpoint?.();
    if (utilityEndpoint?.endpoint) {
        callbacks.setLoadingStatus?.('[4/5] Consulting AI Recommender...');
        try {
            const result = await recommendContext(
                utilityEndpoint,
                npcLedger,
                loreChunks,
                messages,
                finalInput
            );
            recommendedNPCNames = result.relevantNPCNames;
            console.log(`[TurnOrchestrator] Recommender returned: ${recommendedNPCNames.length} NPCs, ${result.relevantLoreIds.length} lore`);
        } catch (err) {
            console.warn('[TurnOrchestrator] UtilityAI recommender failed, falling back to substring scan:', err);
        }
    }

    const freshMessages = state.getMessages();

    callbacks.setLoadingStatus?.('[5/5] Architecting AI Prompt...');
    const payloadResult = buildPayload(
        settings,
        context,
        freshMessages,
        finalInput,
        condenser.condensedSummary || undefined,
        condenser.condensedUpToIndex,
        relevantLore,
        npcLedger,
        archiveRecall,
        sceneNumber,
        recommendedNPCNames,
        semanticFactText
    );

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }
    
    // Attach the debug payload to the user message we added earlier
    callbacks.updateLastMessage({ debugPayload: payload });

    const triggerCondense = async () => {
        if (condenser.isCondensing || !activeCampaignId) return;
        callbacks.setCondensing(true);
        try {
            const currentProvider = state.getFreshProvider();
            if (!currentProvider) return;
            
            const currentMsgs = state.getMessages();
            const uncondensed = currentMsgs.slice(condenser.condensedUpToIndex + 1);
            
            // Phase 7: Save pipeline error isolation
            try {
                const saveResult = await runSaveFilePipeline(currentProvider as EndpointConfig | ProviderConfig, uncondensed, context, undefined, undefined);
                if (saveResult.canonSuccess) callbacks.updateContext({ canonState: saveResult.canonState });
                if (saveResult.indexSuccess) callbacks.updateContext({ headerIndex: saveResult.headerIndex });
                console.log(`[SavePipeline] Canon: ${saveResult.canonSuccess ? '✓' : '✗'}, Index: ${saveResult.indexSuccess ? '✓' : '✗'}`);
                
                // Update coreMemorySlots in context
                if (saveResult.coreMemorySlots) {
                    callbacks.updateContext({ coreMemorySlots: saveResult.coreMemorySlots });
                }
            } catch (err) {
                // Non-fatal, just warn
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

        const tools = allowTools ? [{
            type: 'function',
            function: {
                name: 'query_campaign_lore',
                description: 'Search the Game Master notes for specific lore, rules, characters, or locations. Do NOT call this sequentially or spam it. If no relevant lore is found, immediately proceed with the narrative response. IMPORTANT: You MUST use the standard JSON tool call format. NEVER output raw XML <|DSML|> tags in your response text.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string', description: 'The specific search query' } },
                    required: ['query']
                }
            }
        }] : undefined;

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
                    } as unknown as import('./chatEngine').OpenAIMessage);

                    let query = '';
                    try { query = JSON.parse(toolCall.arguments).query || ''; } catch { /* Ignore */ }

                    let toolResult = "No relevant lore found.";
                    if (query) {
                        const found = searchLoreByQuery(loreChunks, query);
                        if (found.length > 0) {
                            toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
                        }
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

                    currentPayload.push({
                        role: 'tool',
                        content: toolResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('./chatEngine').OpenAIMessage);

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
                    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistant.content);
                    const appendedSceneId = appendData?.sceneId;
                    if (appendData) {
                        const freshIndex = await api.archive.getIndex(activeCampaignId);
                        callbacks.setArchiveIndex(freshIndex);
                        console.log(`[Archive] Appended scene #${appendedSceneId}`);
                    }

                    const content = lastAssistant.content;
                    const extractedNames = extractNPCNames(content);

                    // Phase 7: Refresh semantic facts after archive append
                    if (callbacks.setSemanticFacts && activeCampaignId) {
                        try {
                            const freshFacts = await fetchFacts(activeCampaignId);
                            callbacks.setSemanticFacts(freshFacts);
                        } catch {
                            // Non-critical
                        }
                    }

                    // Phase 7: Chapter auto-seal check
                    const currentChapters = useAppStore.getState().chapters;
                    if (currentChapters.length > 0 && shouldAutoSeal(currentChapters, context.headerIndex)) {
                        try {
                            const sealed = await sealChapter(currentChapters);
                            if (sealed && callbacks.setChapters && activeCampaignId) {
                                const updatedChapters = await loadChapters(activeCampaignId);
                                callbacks.setChapters(updatedChapters);
                            }
                        } catch {
                            // Non-critical
                        }
                    }

                    if (extractedNames.length > 0) {
                        const provider = state.getFreshProvider();
                        const validatedNames = provider ? 
                            await validateNPCCandidates(provider, extractedNames, content) : 
                            extractedNames;

                        if (validatedNames.length > 0) {
                            const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger);

                            for (const potentialName of newNames) {
                                console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — spawning background profile generation...`);
                                const genProvider = state.getFreshProvider();
                                if (genProvider) {
                                    generateNPCProfile(genProvider, allMsgs, potentialName, callbacks.addNPC).catch(() => {});
                                }
                            }

                            if (existingNpcsToUpdate.length > 0) {
                                const updateProvider = state.getFreshProvider();
                                if (updateProvider) {
                                    updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, callbacks.updateNPC);
                                }
                            }
                        }
                    }

                    // Auto bookkeeping: profile + inventory scan every N turns
                    const turnCount = state.incrementBookkeepingTurnCounter();
                    if (turnCount >= state.autoBookkeepingInterval && appendedSceneId) {
                        state.resetBookkeepingTurnCounter();
                        const bkProvider = state.getFreshProvider();
                        if (bkProvider) {
                            const sceneId = appendedSceneId;
                            backgroundQueue.push('Profile-Scan', async () => {
                                const newProfile = await scanCharacterProfile(bkProvider, allMsgs, useAppStore.getState().context.characterProfile);
                                callbacks.updateContext({ characterProfile: newProfile, characterProfileLastScene: sceneId });
                                console.log(`[Auto Bookkeeping] Profile updated at scene #${sceneId}`);
                            }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));

                            backgroundQueue.push('Inventory-Scan', async () => {
                                const newInventory = await scanInventory(bkProvider, allMsgs, useAppStore.getState().context.inventory);
                                callbacks.updateContext({ inventory: newInventory, inventoryLastScene: sceneId });
                                console.log(`[Auto Bookkeeping] Inventory updated at scene #${sceneId}`);
                            }).catch(err => console.warn('[Auto Bookkeeping] Inventory scan failed:', err));
                        }
                    }
                }

                if (settings.autoCondenseEnabled && shouldCondense(allMsgs, settings.contextLimit, condenser.condensedUpToIndex)) {
                    triggerCondense();
                }
            },
            (err) => {
                // Phase 7: Abort detection
                if (err === 'AbortError' || (err as any)?.name === 'AbortError' || err === 'The user aborted a request.') {
                    return; // User cancelled, silently exit
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

// ── Private AI Player Logic ───────────────────────────────────────────

async function handleInterventions(state: TurnState, callbacks: TurnCallbacks, finalInput: string, abortController: AbortController) {
    const { context, forcedInterventions, messages } = state;
    const activeTriggers: ('enemy' | 'neutral' | 'ally')[] = [];

    // Helper to check if an AI player is locked out due to newly established cooldown limits
    const isCooldownActive = (type: 'enemy' | 'neutral' | 'ally') => {
        const cooldownValue = context[`${type}Cooldown` as keyof GameContext] as number ?? 2;
        if (cooldownValue === 0) return false;
        
        const nameMatch = `AI_${type.toUpperCase()}`;
        // Cooldown N means N user turns. 1 full turn typically is 2 messages (user + gm). 
        // Adding +1 ensures we check the slice properly spanning back to the last trigger.
        const sliceCount = (cooldownValue * 2) + 1;
        const recentMessages = messages.slice(-Math.abs(sliceCount));
        
        return recentMessages.some(m => m.name === nameMatch);
    };

    let nextQueue = [...(context.interventionQueue || [])];

    // Priority 1: Manual forces (UI buttons, etc)
    if (forcedInterventions && forcedInterventions.length > 0) {
        activeTriggers.push(...forcedInterventions);
    } 
    else {
        // Priority 2: Pop ONE from the existing queue and update context
        if (nextQueue.length > 0) {
            const nextType = nextQueue.shift()!; // Take first in queue
            activeTriggers.push(nextType);
            callbacks.updateContext({ interventionQueue: nextQueue });
        } 
        // Priority 3: Only roll if the queue is empty
        else if (context.interventionChance) {
            const chance = context.interventionChance;
            const rolledSuccess: ('enemy' | 'neutral' | 'ally')[] = [];

            // Execute 3 independent rolls, restricting by active respective cooldown
            if (context.enemyPlayerActive && !isCooldownActive('enemy') && Math.random() * 100 < chance) rolledSuccess.push('enemy');
            if (context.neutralPlayerActive && !isCooldownActive('neutral') && Math.random() * 100 < chance) rolledSuccess.push('neutral');
            if (context.allyPlayerActive && !isCooldownActive('ally') && Math.random() * 100 < chance) rolledSuccess.push('ally');

            if (rolledSuccess.length > 0) {
                // Fire the first successful roll immediately this turn
                activeTriggers.push(rolledSuccess[0]);
                // Push the remaining successes into the state queue for subsequent turns
                if (rolledSuccess.length > 1) {
                    callbacks.updateContext({ interventionQueue: rolledSuccess.slice(1) });
                }
            }
        }
    }

    if (activeTriggers.length === 0) return;

    for (const type of activeTriggers) {
        try {
            await generateAIPlayerAction(state, callbacks, type, finalInput, abortController);
        } catch (err) {
            console.warn(`[AI Player] ${type} failed to generate:`, err);
        }
    }
}


async function generateAIPlayerAction(
    state: TurnState, 
    callbacks: TurnCallbacks, 
    type: 'enemy' | 'neutral' | 'ally',
    triggerInput: string,
    abortController: AbortController
) {
    const { context, settings, messages, npcLedger, loreChunks } = state;
    const activePreset = settings.presets.find(p => p.id === settings.activePresetId) || settings.presets[0];
    
    // Step 4: Determine World Genre/Context from Lore
    let worldGenre = context.worldVibe;
    if (!worldGenre && loreChunks.length > 0) {
        // Try to find a world overview or high-priority world lore
        const overview = loreChunks.find(c => c.category === 'world_overview') 
                      || loreChunks.find(c => c.header.toLowerCase().includes('overview'))
                      || loreChunks.find(c => c.alwaysInclude && c.priority > 8);
        
        if (overview) {
            // Use the header and a snippet of the content
            worldGenre = `${overview.header}: ${overview.content.split('\n')[0].slice(0, 300)}`;
        }
    }
    worldGenre = worldGenre || "General Fantasy";

    // Choose endpoint: Use specific if exists, fallback to storyAI
    const endpoint = (type === 'enemy' ? activePreset.enemyAI 
                     : type === 'neutral' ? activePreset.neutralAI 
                     : activePreset.allyAI) || activePreset.storyAI;

    if (!endpoint || !endpoint.endpoint) return;

    const personaPrompt = (type === 'enemy' ? context.enemyPlayerPrompt 
                         : type === 'neutral' ? context.neutralPlayerPrompt 
                         : context.allyPlayerPrompt);

    const d20 = Math.floor(Math.random() * 20) + 1;
    let tier = "Success";
    if (d20 <= (context.diceConfig?.catastrophe ?? 2)) tier = "Catastrophe";
    else if (d20 <= (context.diceConfig?.failure ?? 6)) tier = "Failure";
    else if (d20 >= (context.diceConfig?.crit ?? 20)) tier = "Critical";
    else if (d20 >= (context.diceConfig?.triumph ?? 19)) tier = "Triumph";

    // Step 2: Inject Relevant NPC Context (Grounding)
    const relevantNPCs = npcLedger.filter(npc => {
        const d = npc.disposition.toLowerCase();
        if (type === 'enemy') return d.includes('hostile') || d.includes('enemy');
        if (type === 'ally') return d.includes('ally') || d.includes('friendly');
        return !d.includes('hostile') && !d.includes('enemy') && !d.includes('ally') && !d.includes('friendly');
    });

    const npcContext = relevantNPCs.length > 0 
        ? "\n\nRELEVANT NPCs IN SCENE:\n" + relevantNPCs.map(n => 
            `- ${n.name} (Status: ${n.status}) | Goals: ${n.goals} | Stats: N:${n.nature} T:${n.training} E:${n.emotion} S:${n.social} B:${n.belief} G:${n.ego}`
          ).join('\n')
        : "";

    const systemPrompt = [
        `WORLD GENRE: ${worldGenre}`,
        personaPrompt,
        context.sceneNoteActive && context.sceneNote ? `CURRENT SCENE NOTE: ${context.sceneNote}` : "",
        `CRITICAL ROLE: You are an independent AI Player acting as a force or character of the ${type.toUpperCase()} alignment. YOU ARE NOT THE GAME MASTER.`,
        npcContext,
        "CRITICAL RULE 1: Describe your action in the 3rd-person perspective (e.g. 'The goblin lunges...', 'The guard turns...'). DO NOT use 2nd-person ('You...').",
        "CRITICAL RULE 2: Keep it brief: 1 to 3 sentences maximum.",
        "CRITICAL RULE 3: DO NOT resolve the user's action or narrate the outcome of their intent. You can only attempt to interfere, help, or act in parallel.",
        "CRITICAL RULE 4: Begin your action by explicitly stating your assumed ROLE based on what you are controlling (e.g., 'ROLE: A stray dog | ' or 'ROLE: Guard Kaelen | ').",
        "COGNITIVE FIREWALL: As an NPC, you are NOT omniscient. You CANNOT read the User's mind or understand out-of-character mechanics. Base your action SOLELY on the physical events described in the immediate history."
    ].filter(Boolean).join("\n\n");

    // Step 1: Truncate the Chat History (only last 2 messages for limited context)
    const recentHistory = messages.slice(-2).map(m => ({
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content || "",
        name: m.name
    }));

    const finalPayload: import('./chatEngine').OpenAIMessage[] = [
        { role: 'system' as const, content: systemPrompt },
        ...recentHistory,
        { role: 'user' as const, content: `The User just attempted: "${triggerInput}". You rolled a ${d20} (${tier}). State your action.` }
    ];

    callbacks.setLoadingStatus?.(`[AI PLAYER] ${type.toUpperCase()} IS INTERVENING...`);
    
    let resultText = "";
    await llmQueue.acquireSlot('normal');
    try {
        await sendMessage(
            endpoint,
            finalPayload,
            () => {},
            (finalContent) => { resultText = finalContent; },
            (err) => { throw new Error(err); },
            undefined,
            abortController
        );
    } finally {
        llmQueue.releaseSlot();
    }

    if (resultText) {
        callbacks.addMessage({
            id: uid(),
            role: 'assistant',
            name: `AI_${type.toUpperCase()}`,
            content: `[Rolled ${d20} - ${tier}] ${resultText}`,
            timestamp: Date.now()
        });
    }
}
