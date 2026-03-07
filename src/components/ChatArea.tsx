import { useState, useRef, useEffect } from 'react';
import { Send, Save, Loader2, Zap, ChevronDown, Scroll, Edit2, RotateCcw, Trash2, Check, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore, DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES } from '../store/useAppStore';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs, type OpenAIMessage } from '../services/chatEngine';
import type { NPCEntry, ChatMessage } from '../types';
import { shouldCondense, condenseHistory } from '../services/condenser';
import { runSaveFilePipeline } from '../services/saveFileEngine';
import { retrieveRelevantLore, searchLoreByQuery } from '../services/loreRetriever';
import { generateWorldEventTag, checkWorldEvent } from '../services/worldEngine';
import { Preferences } from '@capacitor/preferences';

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function ChatArea() {
    const {
        messages,
        settings,
        context,
        condenser,
        loreChunks,
        npcLedger,
        updateLastAssistant,
        updateContext,
        setCondensed,
        setCondensing,
        getActiveProvider,
        setActiveProvider,
        setActivePreset,
        activeCampaignId,
        deleteMessage,
        deleteMessagesFrom,
    } = useAppStore();

    const [input, setInput] = useState('');
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [isStreaming, setStreaming] = useState(false); // Moved from store to local state
    const [isCheckingNotes, setIsCheckingNotes] = useState(false);
    const [visibleCount, setVisibleCount] = useState(10);
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const turnCountRef = useRef(0); // Throttle NPC background calls

    // Auto-scroll only when a NEW message appears, not on every streaming token update.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    // Auto-resize textarea based on content
    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto'; // Reset to auto first to allow shrinking
            inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 256)}px`;
        }
    }, [input]);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    const activeProvider = getActiveProvider();

    const triggerCondense = async () => {
        if (condenser.isCondensing) return;
        setCondensing(true);
        try {
            const gmProvider = useAppStore.getState().getActiveProvider();
            const summarizerProvider = useAppStore.getState().getSummarizerProvider();
            // Step 1 & 2: Generate Canon State + Header Index BEFORE condensing
            // Uses MAIN GM provider — needs intelligence for canon extraction
            const currentCtx = useAppStore.getState().context;
            const saveResult = await runSaveFilePipeline(gmProvider, messages, currentCtx);

            // Auto-populate fields
            if (saveResult.canonSuccess) {
                updateContext({ canonState: saveResult.canonState });
            }
            if (saveResult.indexSuccess) {
                updateContext({ headerIndex: saveResult.headerIndex });
            }

            console.log(`[SavePipeline] Canon: ${saveResult.canonSuccess ? '✓' : '✗'}, Index: ${saveResult.indexSuccess ? '✓' : '✗'}`);

            // Step 3: Condense history — uses SUMMARIZER provider (can be cheap/local)
            const freshCtx = useAppStore.getState().context;
            const result = await condenseHistory(
                summarizerProvider,
                messages,
                freshCtx,
                condenser.condensedUpToIndex,
                condenser.condensedSummary
            );
            setCondensed(result.summary, result.upToIndex);
        } catch (err) {
            console.error('[Condenser]', err);
        } finally {
            setCondensing(false);
        }
    };

    const handleSend = async (overrideText?: string) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming) return;

        if (!overrideText) setInput('');

        const provider = useAppStore.getState().getActiveProvider();
        const currentMessages = useAppStore.getState().messages;

        const relevantLore = loreChunks.length > 0
            ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, textToUse, 1200, currentMessages)
            : undefined;

        const surpriseConfig = context.surpriseConfig || {
            types: [...DEFAULT_SURPRISE_TYPES],
            tones: [...DEFAULT_SURPRISE_TONES],
            initialDC: 98,
            dcReduction: 3
        };

        // Enforce safe fallbacks
        const typesList = surpriseConfig.types.length >= 3 ? surpriseConfig.types : DEFAULT_SURPRISE_TYPES;
        const tonesList = surpriseConfig.tones.length >= 3 ? surpriseConfig.tones : DEFAULT_SURPRISE_TONES;

        let newDC = context.surpriseDC ?? surpriseConfig.initialDC;
        let finalInput = textToUse;

        if (context.surpriseEngineActive !== false) {
            const roll = Math.floor(Math.random() * 100) + 1;
            if (roll >= newDC) {
                const type = typesList[Math.floor(Math.random() * typesList.length)];
                const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

                finalInput += `\n[SURPRISE EVENT: ${type} (${tone})]`;
                newDC = surpriseConfig.initialDC;
                console.log(`[Surprise Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newDC}`);
            } else {
                console.log(`[Surprise Engine] Roll: ${roll} < DC: ${newDC}. Decreasing DC by ${surpriseConfig.dcReduction}.`);
                newDC = Math.max(5, newDC - surpriseConfig.dcReduction);
            }
        }

        // <--- WORLD ENGINE ---!>
        const worldEventConfig = context.worldEventConfig || { initialDC: 198, dcReduction: 3, who: [], where: [], why: [], what: [] };
        let currentWorldEventDC = context.worldEventDC ?? worldEventConfig.initialDC;

        if (context.worldEngineActive !== false) {
            const worldEventCheck = checkWorldEvent(currentWorldEventDC, worldEventConfig.initialDC, worldEventConfig.dcReduction);
            if (worldEventCheck.hit) {
                const hasCustomTags = worldEventConfig.who && worldEventConfig.who.length >= 3 &&
                    worldEventConfig.where && worldEventConfig.where.length >= 3 &&
                    worldEventConfig.why && worldEventConfig.why.length >= 3 &&
                    worldEventConfig.what && worldEventConfig.what.length >= 3;

                const tag = hasCustomTags
                    ? `[WORLD_EVENT: ${worldEventConfig.who![Math.floor(Math.random() * worldEventConfig.who!.length)]} ${worldEventConfig.what![Math.floor(Math.random() * worldEventConfig.what!.length)]} ${worldEventConfig.why![Math.floor(Math.random() * worldEventConfig.why!.length)]} ${worldEventConfig.where![Math.floor(Math.random() * worldEventConfig.where!.length)]}]`
                    : generateWorldEventTag();

                finalInput += `\n${tag}`;
                console.log(`[World Engine] Roll: ${worldEventCheck.roll} >= DC: ${currentWorldEventDC}. Triggered! Tag: ${tag}`);
            } else {
                console.log(`[World Engine] Roll: ${worldEventCheck.roll} < DC: ${currentWorldEventDC}. Missed. New DC: ${worldEventCheck.newDC}`);
            }
            currentWorldEventDC = worldEventCheck.newDC;
        }

        updateContext({ surpriseDC: newDC, worldEventDC: currentWorldEventDC });

        // <--- DICE FAIRNESS ENGINE ---!>
        if (context.diceFairnessActive !== false) {
            const getOutcomeWord = (rollResult: number) => {
                const config = context.diceConfig || {
                    catastrophe: 2,
                    failure: 6,
                    mixedSuccess: 11,
                    cleanSuccess: 17,
                    exceptionalSuccess: 19,
                };
                if (rollResult <= config.catastrophe) return "Catastrophe";
                if (rollResult <= config.failure) return "Failure";
                if (rollResult <= config.mixedSuccess) return "Mixed Success";
                if (rollResult <= config.cleanSuccess) return "Clean Success";
                if (rollResult <= config.exceptionalSuccess) return "Exceptional Success";
                return "Narrative Boon";
            };

            const generatePool = () => {
                const rolls = [
                    Math.floor(Math.random() * 20) + 1,
                    Math.floor(Math.random() * 20) + 1,
                    Math.floor(Math.random() * 20) + 1
                ].sort((a, b) => a - b);
                return `Disadvantage: ${getOutcomeWord(rolls[0])}, Normal: ${getOutcomeWord(rolls[1])}, Advantage: ${getOutcomeWord(rolls[2])}`;
            };

            finalInput += `\n[DICE OUTCOMES: COMBAT=(${generatePool()}) | PERCEPTION=(${generatePool()}) | STEALTH=(${generatePool()}) | SOCIAL=(${generatePool()}) | MOVEMENT=(${generatePool()}) | KNOWLEDGE=(${generatePool()}) | MUNDANE=(Narrative Boon)]`;
        }
        // <----------------------!>

        const payload = buildPayload(
            settings,
            context,
            currentMessages,
            finalInput,
            condenser.condensedSummary || undefined,
            condenser.condensedUpToIndex,
            relevantLore,
            npcLedger
        );

        const executeTurn = async (currentPayload: OpenAIMessage[], toolCallCount = 0, apiRetryCount = 0) => {
            if (toolCallCount === 0) {
                const userMsg = { id: uid(), role: 'user' as const, content: finalInput, displayContent: textToUse, timestamp: Date.now(), debugPayload: payload };
                useAppStore.getState().addMessage(userMsg);
            }

            const assistantMsgId = uid();
            useAppStore.getState().addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
            setStreaming(true);

            // Limit recursion: only provide tools if we haven't looped too many times
            const tools = toolCallCount < 2 ? [{
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

            await sendMessage(
                provider,
                currentPayload,
                (fullText) => updateLastAssistant(fullText),
                async (toolCall) => {
                    if (toolCall && toolCall.name === 'query_campaign_lore') {
                        setIsCheckingNotes(true);
                        setStreaming(false);

                        // Save tool call block to assistant message
                        const { updateLastMessage } = useAppStore.getState();
                        updateLastMessage({
                            tool_calls: [{
                                id: toolCall.id,
                                type: 'function' as const,
                                function: { name: toolCall.name, arguments: toolCall.arguments }
                            }]
                        });

                        currentPayload.push({
                            role: 'assistant',
                            content: null,
                            tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                        });

                        // Execute Tool locally
                        let query = '';
                        try { query = JSON.parse(toolCall.arguments).query || ''; } catch {
                            console.warn('[ToolExecution] Failed to parse tool arguments:', toolCall.arguments);
                        }

                        let toolResult = "No relevant lore found.";
                        if (query) {
                            const found = searchLoreByQuery(loreChunks, query);
                            if (found.length > 0) {
                                toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
                            }
                        }

                        // Save tool response
                        const toolMsgId = uid();
                        useAppStore.getState().addMessage({
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
                        });

                        // Loop back to LLM after short visual delay
                        setTimeout(() => {
                            setIsCheckingNotes(false);
                            executeTurn(currentPayload, toolCallCount + 1);
                        }, 800);
                        return;
                    }

                    // Normal Completion
                    setStreaming(false);
                    setIsCheckingNotes(false);
                    const allMsgs = useAppStore.getState().messages;
                    const lastAssistant = allMsgs[allMsgs.length - 1];
                    if (lastAssistant?.role === 'assistant' && lastAssistant.content) {

                        // ── NPC Auto-Generation: Parse AI response for character name tags ──
                        // Supports 3 formats:
                        //   1. [Name]        — plain brackets
                        //   2. [**Name**]    — bold brackets
                        //   3. [SYSTEM: NPC_ENTRY - NAME] — explicit system tag
                        const content = lastAssistant.content;
                        const extractedNames: string[] = [];

                        // Blocklist: common words, pronouns, and scene-header tokens that should NEVER be NPC names
                        const NPC_NAME_BLOCKLIST = new Set([
                            'you', 'your', 'your name', 'me', 'i', 'we', 'they', 'them', 'he', 'she', 'it',
                            'the', 'a', 'an', 'this', 'that', 'here', 'there', 'who', 'what', 'where', 'when',
                            'scene', 'end', 'start', 'continue', 'note', 'notes', 'action', 'roll', 'dice',
                            'combat', 'perception', 'stealth', 'social', 'movement', 'knowledge', 'mundane',
                            'surprise', 'system', 'gm', 'dm', 'player', 'pc', 'npc', 'lore', 'world',
                            'alive', 'dead', 'deceased', 'missing', 'unknown', 'active', 'inactive',
                            'view raw payload', 'condensed', 'archive', 'edit', 'cancel',
                        ]);

                        // Pattern to exclude generic roles like "Guard A" or "Scout 1"
                        const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature)\s+[a-z0-9]$/i;

                        // Pattern 1 & 2: [Name] or [**Name**] — no colons allowed inside (filters out [SYSTEM: ...])
                        // Now allows periods for honorifics like Mr. / Mrs. / Dr.
                        const bracketMatches = Array.from(content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g));
                        for (const m of bracketMatches) {
                            const raw = m[1].trim();
                            // Skip if it contains a colon (system tags) or is too short
                            if (raw.includes(':') || raw.length < 2) continue;
                            // Skip multi-word ALL-CAPS tags like "END RECORD" or "ACTIVE NPC CONTEXT"
                            if (raw.includes(' ') && raw === raw.toUpperCase()) continue;
                            // Skip blocklisted words
                            if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
                            // Skip generic roles
                            if (GENERIC_ROLE_PATTERN.test(raw)) continue;
                            extractedNames.push(raw);
                        }

                        // Pattern 3: [SYSTEM: NPC_ENTRY - NAME]
                        const entryMatches = Array.from(content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi));
                        for (const m of entryMatches) {
                            const raw = m[1].trim();
                            if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
                            if (GENERIC_ROLE_PATTERN.test(raw)) continue;
                            extractedNames.push(raw);
                        }

                        if (extractedNames.length > 0) {
                            const { npcLedger, addNPC, updateNPC } = useAppStore.getState();
                            // Normalize: title-case all-caps single words (e.g., ORIN -> Orin)
                            const normalized = extractedNames.map(n =>
                                n === n.toUpperCase() ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : n
                            );
                            const uniqueNames = Array.from(new Set(normalized));

                            const existingNpcsToUpdate: NPCEntry[] = [];
                            const newNpcsToGenerate: string[] = [];

                            for (const potentialName of uniqueNames) {
                                // Check if already in ledger (case-insensitive against name + aliases)
                                const existingNpc = npcLedger.find(npc => {
                                    if (!npc.name) return false;
                                    const aliasesRaw = npc.aliases || '';
                                    const allNames = [npc.name, ...aliasesRaw.split(',').map(a => a.trim())].filter(Boolean);
                                    const search = potentialName.toLowerCase();
                                    return allNames.some(n => {
                                        const lower = n.toLowerCase();
                                        return lower === search || lower.startsWith(search + ' ') || lower.endsWith(' ' + search);
                                    });
                                });

                                if (!existingNpc) {
                                    newNpcsToGenerate.push(potentialName);
                                } else {
                                    existingNpcsToUpdate.push(existingNpc);
                                }
                            }

                            // ── CACHE OPTIMIZATION: Throttle NPC background API calls ──
                            // NPC generation/update calls use unique prompts that NEVER cache.
                            // Firing them every turn wastes ~7-9K uncacheable tokens per turn.
                            // New NPCs: generate immediately (important for continuity)
                            // Existing NPC updates: only every 3rd turn (attributes rarely shift turn-to-turn)
                            turnCountRef.current += 1;
                            const shouldRunNPCUpdates = turnCountRef.current % 3 === 0;

                            if (newNpcsToGenerate.length > 0) {
                                const provider = settings.providers.find(p => p.id === settings.activeProviderId);
                                if (provider) {
                                    for (const potentialName of newNpcsToGenerate) {
                                        console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — spawning background profile generation...`);
                                        generateNPCProfile(provider, allMsgs, potentialName, addNPC);
                                    }
                                }
                            }

                            if (shouldRunNPCUpdates && existingNpcsToUpdate.length > 0) {
                                const provider = settings.providers.find(p => p.id === settings.activeProviderId);
                                if (provider) {
                                    console.log(`[NPC Updater] Turn ${turnCountRef.current} — running batched update for ${existingNpcsToUpdate.length} NPC(s)`);
                                    updateExistingNPCs(provider, allMsgs, existingNpcsToUpdate, updateNPC);
                                }
                            } else if (existingNpcsToUpdate.length > 0) {
                                console.log(`[NPC Updater] Turn ${turnCountRef.current} — skipping update (throttled, next on turn ${Math.ceil(turnCountRef.current / 3) * 3})`);
                            }
                        }
                    }
                    if (settings.autoCondenseEnabled && shouldCondense(allMsgs, settings.contextLimit, condenser.condensedUpToIndex)) {
                        triggerCondense();
                    }
                },
                (err) => {
                    if (apiRetryCount === 0) {
                        updateLastAssistant(`⚠ Error: ${err}. Retrying...`);
                        setTimeout(() => executeTurn(currentPayload, toolCallCount, 1), 2000);
                    } else if (apiRetryCount === 1) {
                        updateLastAssistant(`⚠ Error: ${err}. Retrying without tools...`);
                        setTimeout(() => executeTurn(currentPayload, 999, 2), 2000);
                    } else {
                        updateLastAssistant(`⚠ Error: ${err}`);
                        setStreaming(false);
                        setIsCheckingNotes(false);
                    }
                },
                tools
            );
        };

        await executeTurn(payload);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (editingMessageId) {
                handleEditSubmit();
            } else {
                handleSend();
            }
        }
    };

    const [isSaving, setIsSaving] = useState(false);

    const handleForceSave = async () => {
        setIsSaving(true);
        const state = useAppStore.getState();
        if (state.activeCampaignId) {
            try {
                await Promise.all([
                    Preferences.set({ key: 'app_settings', value: JSON.stringify({ settings: state.settings, activeCampaignId: state.activeCampaignId }) }),
                    Preferences.set({ key: `campaign_state_${state.activeCampaignId}`, value: JSON.stringify({ context: state.context, messages: state.messages, condenser: state.condenser }) }),
                    Preferences.set({ key: `campaign_npcs_${state.activeCampaignId}`, value: JSON.stringify(state.npcLedger) })
                ]);
            } catch (e) {
                console.error("[Save] Failed to force save to Preferences:", e);
            }
        }
        setTimeout(() => setIsSaving(false), 2000);
    };

    // ─── Archive helpers ───
    const handleOpenArchive = async () => {
        if (!activeCampaignId) return;
        try {
            const { value } = await Preferences.get({ key: `campaign_archive_log_${activeCampaignId}` });
            if (value && navigator.clipboard) {
                await navigator.clipboard.writeText(value);
                alert('Archive log copied to clipboard!');
            } else {
                alert('No archive found, or clipboard unavailable.');
            }
        } catch (e) {
            console.error('Failed to open archive', e);
        }
    };

    // ─── Edit & Regenerate logic ───
    const startEditing = (msg: ChatMessage) => {
        setEditingMessageId(msg.id);
        setInput(msg.displayContent || msg.content);
        inputRef.current?.focus();
    };

    const handleEditSubmit = () => {
        if (!editingMessageId) return;
        const msg = messages.find(m => m.id === editingMessageId);
        if (!msg) return;

        if (msg.role === 'user') {
            useAppStore.getState().deleteMessagesFrom(msg.id);
            const textToResend = input.trim();
            setInput('');
            setEditingMessageId(null);
            setTimeout(() => {
                handleSend(textToResend);
            }, 50);
        } else {
            useAppStore.getState().updateMessageContent(msg.id, input.trim());
            setInput('');
            setEditingMessageId(null);
        }
    };

    const handleRegenerate = (id: string) => {
        const msgs = useAppStore.getState().messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;

        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');

        if (lastUser) {
            deleteMessagesFrom(lastUser.id);
            // Wait 50ms for the state deletion to propagate to Zustand store before passing it into handleSend's buildPayload
            setTimeout(() => {
                handleSend(lastUser.displayContent || lastUser.content);
            }, 50);
        }
    };


    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Transcript */}
            <div className="flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3">
                {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center space-y-3">
                            <div className="text-4xl">⚔</div>
                            <p className="text-text-dim text-xs uppercase tracking-widest">
                                Awaiting transmission...
                            </p>
                            <p className="text-text-dim/50 text-[11px]">
                                Paste your lore in the context drawer, configure your LLM, and begin.
                            </p>
                        </div>
                    </div>
                )}

                {/* Reverse Pagination: Load Older Messages Button */}
                {messages.length > visibleCount && (
                    <div className="flex justify-center py-2">
                        <button
                            onClick={() => setVisibleCount(prev => prev + 10)}
                            className="text-xs text-terminal/70 hover:text-terminal bg-terminal/10 hover:bg-terminal/20 px-4 py-2 rounded transition-colors"
                        >
                            ↑ Load older messages... ({messages.length - visibleCount} hidden)
                        </button>
                    </div>
                )}

                {messages.slice(-visibleCount).filter(msg => msg.role !== 'tool').map((msg) => (
                    <div
                        key={msg.id}
                        className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                        <div
                            className={`max-w-[95%] md:max-w-[75%] px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${msg.role === 'user'
                                ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary'
                                : msg.role === 'system'
                                    ? 'bg-ember/8 border-l-2 border-ember text-ember/80'
                                    : 'bg-void-lighter border-l-2 border-border text-text-primary'
                                }`}
                        >
                            {/* Action Bar (opacity-0 group-hover:opacity-100) */}
                            <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-[2px] rounded z-10`}>
                                {msg.role !== 'system' && (
                                    <button title="Edit" onClick={() => startEditing(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                        <Edit2 size={10} />
                                    </button>
                                )}
                                {msg.role === 'assistant' && (
                                    <button title="Regenerate" onClick={() => handleRegenerate(msg.id)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                        <RotateCcw size={10} />
                                    </button>
                                )}
                                <button title="Delete" onClick={() => deleteMessage(msg.id)} className="text-text-dim hover:text-red-400 p-1 bg-void-lighter rounded">
                                    <Trash2 size={10} />
                                </button>
                            </div>

                            <div className="flex items-center gap-2 mb-1">
                                <span
                                    className={`text-[10px] uppercase tracking-widest ${msg.role === 'user'
                                        ? 'text-terminal'
                                        : msg.role === 'system'
                                            ? 'text-ember'
                                            : 'text-ice'
                                        }`}
                                >
                                    {msg.role === 'user' ? '► YOU' : msg.role === 'tool' ? '◈ TOOL' : msg.role === 'system' ? '◆ SYS' : '◇ GM'}
                                </span>
                                {msg.role === 'tool' && msg.name && (
                                    <span className="text-[9px] text-terminal font-bold tracking-wider opacity-80">
                                        [{msg.name}]
                                    </span>
                                )}
                                <span className="text-[9px] text-text-dim">
                                    {new Date(msg.timestamp).toLocaleTimeString()}
                                </span>
                            </div>

                            <div className="gm-prose">
                                <ReactMarkdown>{msg.displayContent || msg.content}</ReactMarkdown>
                            </div>

                            {settings.debugMode && msg.debugPayload && (
                                <details className="mt-2 border-t border-border/50 pt-2 text-[10px]">
                                    <summary className="cursor-pointer text-terminal/60 hover:text-terminal transition-colors select-none">
                                        [View Raw Payload]
                                    </summary>
                                    <pre className="mt-2 bg-void p-2 overflow-x-auto text-text-dim text-[9px] font-mono leading-tight whitespace-pre-wrap break-all">
                                        {JSON.stringify(msg.debugPayload, null, 2)}
                                    </pre>
                                </details>
                            )}
                        </div>
                    </div>
                ))}

                {isCheckingNotes ? (
                    <div className="flex items-center gap-2 text-terminal/80 text-xs px-4">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="animate-pulse-slow">The GM is checking their notes...</span>
                    </div>
                ) : isStreaming && (
                    <div className="flex items-center gap-2 text-terminal text-xs px-4">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="animate-pulse-slow">Generating...</span>
                    </div>
                )}

                <div ref={bottomRef} />
            </div>

            {/* Macro Bar */}
            <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto">
                <button
                    onClick={handleForceSave}
                    disabled={isSaving}
                    className="flex items-center gap-1.5 bg-void border border-emerald-500/30 hover:border-emerald-500 text-emerald-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-emerald-500/5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    <span className="hidden xs:inline">{isSaving ? 'SAVING...' : 'SAVE CAMPAIGN'}</span>
                    {!isSaving && <span className="inline xs:hidden">SAVE</span>}
                </button>
                <button
                    onClick={triggerCondense}
                    disabled={condenser.isCondensing || messages.length < 6}
                    className="flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    {condenser.isCondensing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                    {condenser.isCondensing ? 'Condensing...' : 'Condense'}
                </button>
                <button
                    onClick={handleOpenArchive}
                    disabled={!activeCampaignId}
                    className="flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto"
                >
                    <Scroll size={13} />
                    Archive
                </button>
                {condenser.condensedSummary && (
                    <span className="text-[9px] text-terminal/60 self-center ml-1">
                        ● condensed
                    </span>
                )}
            </div>

            {/* Input Area */}
            <div className="flex-shrink-0 bg-void border-t border-border">
                {editingMessageId && (
                    <div className="bg-terminal/10 border-b border-border px-4 py-2 flex items-center justify-between">
                        <span className="text-terminal text-[11px] uppercase tracking-wider font-bold flex items-center gap-2">
                            <Edit2 size={12} /> Editing Message
                        </span>
                        <button
                            onClick={() => { setEditingMessageId(null); setInput(''); }}
                            className="text-text-dim hover:text-text-primary flex items-center gap-1 text-[10px] uppercase tracking-wider"
                        >
                            <X size={12} /> Cancel
                        </button>
                    </div>
                )}
                <div className="px-2 sm:px-4 pb-3 sm:pb-4 pt-3 sm:pt-4">
                    <div className="flex gap-0 border border-border bg-void focus-within:border-terminal transition-colors">
                        {/* Provider / Preset Dropdown */}
                        <div ref={dropdownRef} className="relative flex-shrink-0">
                            <button
                                onClick={() => setDropdownOpen(!dropdownOpen)}
                                className="flex items-center gap-1 px-3 h-full text-[11px] text-ice uppercase tracking-wider border-r border-border hover:bg-ice/5 transition-colors whitespace-nowrap"
                            >
                                {settings.presets && settings.presets.length > 0
                                    ? (settings.presets.find(p => p.id === settings.activePresetId)?.label || activeProvider.label)
                                    : activeProvider.label
                                }
                                <ChevronDown size={12} className={`transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {dropdownOpen && (
                                <div className="absolute bottom-full left-0 mb-1 bg-surface border border-border min-w-[180px] z-50 shadow-lg">
                                    {/* Show presets if any exist */}
                                    {settings.presets && settings.presets.length > 0 ? (
                                        <>
                                            <div className="px-3 py-1.5 text-[9px] text-text-dim/50 uppercase tracking-wider border-b border-border">
                                                Presets
                                            </div>
                                            {settings.presets.map((preset) => {
                                                const gmProv = settings.providers.find(p => p.id === preset.gmProviderId);
                                                return (
                                                    <button
                                                        key={preset.id}
                                                        onClick={() => {
                                                            setActivePreset(preset.id);
                                                            setDropdownOpen(false);
                                                        }}
                                                        className={`w-full text-left px-3 py-2 text-[11px] uppercase tracking-wider transition-colors ${preset.id === settings.activePresetId
                                                            ? 'text-ice bg-ice/10'
                                                            : 'text-text-dim hover:text-text-primary hover:bg-void'
                                                            }`}
                                                    >
                                                        <span className="font-mono">{preset.label}</span>
                                                        <span className="block text-[9px] text-text-dim/50 normal-case tracking-normal">
                                                            GM: {gmProv?.modelName || '?'}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </>
                                    ) : (
                                        /* Fallback: raw provider list (no presets configured) */
                                        settings.providers.length > 1 && settings.providers.map((p) => (
                                            <button
                                                key={p.id}
                                                onClick={() => {
                                                    setActiveProvider(p.id);
                                                    setDropdownOpen(false);
                                                }}
                                                className={`w-full text-left px-3 py-2 text-[11px] uppercase tracking-wider transition-colors ${p.id === activeProvider.id
                                                    ? 'text-ice bg-ice/10'
                                                    : 'text-text-dim hover:text-text-primary hover:bg-void'
                                                    }`}
                                            >
                                                <span className="font-mono">{p.label}</span>
                                                <span className="block text-[9px] text-text-dim/50 normal-case tracking-normal">
                                                    {p.modelName}
                                                </span>
                                            </button>
                                        ))
                                    )}
                                </div>
                            )}
                        </div>

                        <textarea
                            ref={inputRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={editingMessageId ? "Edit message..." : "What do you do?"}
                            className="flex-1 bg-transparent px-3 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[44px] max-h-64 overflow-y-auto"
                            rows={1}
                        />
                        <button
                            onClick={editingMessageId ? handleEditSubmit : () => handleSend()}
                            disabled={isStreaming || !input.trim()}
                            className="px-4 text-terminal hover:bg-terminal/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed border-l border-border flex items-center justify-center gap-2"
                        >
                            {editingMessageId ? <Check size={16} /> : <Send size={16} />}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
