import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, PayloadTrace, DivergenceRegister } from '../types';
import type { OpenAIMessage } from './llmService';
import { countTokens } from './tokenizer';
import { buildBehaviorDirective, buildDriftAlert } from './npcBehaviorDirective';
import { minifyLoreChunk, minifyNPC } from './contextMinifier';
import { renderRegisterForPayload } from './divergenceRegister';
import type { ArchiveChapter } from '../types';


/**
 * Robustly extracts the first JSON object or array found in a text string.
 * Handles <think> tags, markdown code blocks, and leading/trailing chatter.
 */
export function extractJson(text: string): string {
    // 1. Remove reasoning blocks if present
    let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // 2. Try to find content between triple backticks first
    const markdownMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (markdownMatch) {
        clean = markdownMatch[1];
    }

    // 3. Final fallback: find the first { or [ and the last } or ]
    const firstObj = clean.indexOf('{');
    const firstArr = clean.indexOf('[');
    const start = (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) ? firstObj : firstArr;

    if (start !== -1) {
        const lastObj = clean.lastIndexOf('}');
        const lastArr = clean.lastIndexOf(']');
        const end = (lastObj !== -1 && (lastArr === -1 || lastObj > lastArr)) ? lastObj : lastArr;

        if (end !== -1 && end > start) {
            return clean.substring(start, end + 1).trim();
        }
    }

    return clean.trim();
}



const TOOL_MODE_ACTION_RESOLUTION = `### ACTION RESOLUTION

Trigger: Player attempts an action with an uncertain outcome — combat hits, skill checks, saves, contested actions.

1. Identify core intent of the player's action.
2. If the outcome depends on chance, CALL the \`roll_dice\` tool BEFORE narrating. Do NOT narrate the outcome first.
   - \`dice\`: typically \`1d20\` for skill checks/attacks; use \`NdM\` form for damage or special rolls
   - \`reason\`: short label (e.g. "Stealth check vs guard", "Longsword attack")
   - \`category\`: one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane (for d20 only)
3. Use the returned \`tier\` (Catastrophe / Failure / Success / Triumph / Narrative Boon) to shape the narrative — same outcome semantics as pool mode.
4. Do NOT call \`roll_dice\` for descriptive moments, dialogue, or trivial actions. Mundane actions resolve as plain success without a roll.

**Advantage selection (tool mode):** if the player explicitly leverages a known weakness or superior tool, call \`roll_dice\` twice and use the higher result. If explicitly impaired (blinded, wounded, overwhelmed), call twice and use the lower. Otherwise, single roll.

**Outcomes:**
- Catastrophe: severe unexpected failure, consequences beyond simple loss.
- Failure: fails. Damage, setback, or resource loss.
- Success: succeeds exactly as intended.
- Triumph: succeeds with an unexpected additional benefit.
- Narrative Boon: flawless. Massive strategic or narrative advantage.`;

function swapActionResolutionForToolMode(rules: string): string {
    const marker = '### ACTION RESOLUTION';
    const idx = rules.indexOf(marker);
    if (idx === -1) return rules;
    const nextSectionMatch = rules.substring(idx + marker.length).match(/\n### /);
    const endIdx = nextSectionMatch ? idx + marker.length + nextSectionMatch.index! : rules.length;
    return rules.substring(0, idx) + TOOL_MODE_ACTION_RESOLUTION + rules.substring(endIdx);
}

export function buildPayload(
    settings: AppSettings,
    context: GameContext,
    history: ChatMessage[],
    userMessage: string,
    condensedUpToIndex?: number,
    relevantLore?: LoreChunk[],
    npcLedger?: NPCEntry[],
    archiveRecall?: ArchiveScene[],
    recommendedNPCNames?: string[],
    semanticFactText?: string,
    deepContextSummary?: string,
    divergenceRegister?: DivergenceRegister,
    chapters?: ArchiveChapter[],
): { messages: OpenAIMessage[]; trace?: PayloadTrace[] } {
    const trace: PayloadTrace[] = [];
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;

    // --- 1. Define Budgets (ST-inspired proportionality) ---
    // When deep context summary is present, expand world budget at expense of stable/volatile.
    const hasDeepContext = !!deepContextSummary;
    const budgetMap = {
        stable:   Math.floor(limit * (hasDeepContext ? 0.15 : 0.25)),
        summary:  Math.floor(limit * 0.10),
        world:    Math.floor(limit * (hasDeepContext ? 0.60 : 0.40)),
        volatile: Math.floor(limit * (hasDeepContext ? 0.07 : 0.10)),
        // History + User message take the remainder
    };

    // Helper to log to trace if debug
    const addTrace = (t: PayloadTrace) => {
        if (isDebug) trace.push(t);
    };

    // --- 2. Calculate Stable Truth & Summary (High Priority) ---
    const stableParts: string[] = [];
    if (context.rulesRaw) {
        let rules = context.rulesRaw;
        if (context.diceFairnessActive === false) {
            rules = swapActionResolutionForToolMode(rules);
        }
        stableParts.push(rules);
    }
    if (context.starterActive && context.starter) stableParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) stableParts.push(context.continuePrompt);

    // AI Player Adjudication instruction
    if (context.enemyPlayerActive || context.neutralPlayerActive || context.allyPlayerActive) {
        stableParts.push("ADJUDICATOR MODE: You may see messages from [AI_ENEMY], [AI_NEUTRAL], or [AI_ALLY]. These are independent narrative agents. You ARE the final adjudicator: synthesize their actions and the user's intent into a single, cohesive narrative resolution for the turn.");
    }

    // Only inject if using a known reasoning/thinking model (DeepSeek-R1, Qwen QwQ, etc.)
    const modelName = (settings as any).presets?.find?.((p: any) => p.id === (settings as any).activePresetId)?.storyAI?.modelName ?? '';
    const isReasoningModel = /deepseek-r|qwq|qwen.*think|r1/i.test(modelName);
    if (isReasoningModel) {
        stableParts.push("IMPORTANT: If you use a 'thinking' or 'reasoning' block (<think>...</think>), you MUST still provide the full narrative response AFTER the closing tag. Never end a turn with only a thinking block.");
    }

    const stableContent = stableParts.join('\n\n');
    const stableTokens = countTokens(stableContent);
    addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: 'Rules & Core state', included: true, position: 'system_static' });

    let divergenceContent = '';
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        divergenceContent = renderRegisterForPayload(divergenceRegister, chapters);
    }
    const divergenceTokens = countTokens(divergenceContent);
    addTrace({ source: 'Divergence Register', classification: 'stable_truth', tokens: divergenceTokens, reason: `Campaign canon overrides (${divergenceRegister?.entries.length ?? 0} entries)`, included: !!divergenceContent, position: 'system_static' });

    // --- 3. Gather trimmable World Context (Medium Priority) ---
    const worldBlocks: { source: string; content: string; tokens: number; reason: string }[] = [];

    // Archive Recall
    if (archiveRecall && archiveRecall.length > 0) {
        const activeAssistantContents = history
            .slice((condensedUpToIndex ?? -1) + 1)
            .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 20)
            .map(m => m.content as string);

        const filteredRecall = archiveRecall.filter(scene => {
            if (activeAssistantContents.some(asst => scene.content.includes(asst))) return false;
            return true;
        });

        if (filteredRecall.length > 0) {
            const text = `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${filteredRecall.map(s => `[SCENE #${s.sceneId}]\n${s.content}`).join('\n\n')}\n[END ARCHIVE RECALL]`;
            worldBlocks.push({ source: 'Archive Recall', content: text, tokens: countTokens(text), reason: `Verbatim history (${filteredRecall.length} scenes)` });
        }
    }

    // Deep Archive Context (AI-synthesized brief from full-archive scan)
    if (deepContextSummary) {
        const text = `[DEEP ARCHIVE CONTEXT — AI-synthesized from full campaign history]\n${deepContextSummary}\n[END DEEP ARCHIVE CONTEXT]`;
        worldBlocks.push({ source: 'Deep Archive Brief', content: text, tokens: countTokens(text), reason: 'Deep archive scan (GM long-press)' });
    }

    // RAG Lore — minified and grouped by category
    if (relevantLore && relevantLore.length > 0) {
        const grouped = new Map<string, string[]>();
        for (const chunk of relevantLore) {
            const cat = chunk.category || 'misc';
            const catTitle = cat === 'faction' ? 'FACTIONS'
                           : cat === 'character' ? 'CHARACTERS'
                           : cat === 'location' ? 'LOCATIONS'
                           : cat === 'power_system' || cat === 'rules' ? 'POWER SYSTEM & RULES'
                           : cat === 'economy' ? 'ECONOMY'
                           : cat === 'event' ? 'EVENTS'
                           : cat === 'world_overview' ? 'OVERVIEW'
                           : 'MISCELLANEOUS';
            
            if (!grouped.has(catTitle)) grouped.set(catTitle, []);
            grouped.get(catTitle)!.push(minifyLoreChunk(chunk));
        }

        const sections: string[] = [];
        for (const [title, chunks] of grouped.entries()) {
            sections.push(`[${title}]\n` + chunks.join('\n'));
        }

        const text = `[WORLD LORE — RELEVANT SECTIONS]\n${sections.join('\n\n')}\n[END WORLD LORE]`;
        worldBlocks.push({ source: 'RAG Lore', content: text, tokens: countTokens(text), reason: `RAG injected (${relevantLore.length} chunks, minified)` });
    } else if (context.loreRaw) {
        worldBlocks.push({ source: 'Raw Lore (Legacy)', content: context.loreRaw, tokens: countTokens(context.loreRaw), reason: 'Legacy fallback' });
    }

    // Phase 7: Semantic Memory Facts injection
    if (semanticFactText) {
        worldBlocks.push({ source: 'Semantic Facts', content: semanticFactText, tokens: countTokens(semanticFactText), reason: 'Injected verified facts' });
    }

    // Scene Notebook
    if (context.notebookActive && context.notebook && context.notebook.length > 0) {
        const notebookText = '[SCENE NOTEBOOK]\n' +
            context.notebook.map(n => `- ${n.text}`).join('\n') +
            '\n[END SCENE NOTEBOOK]';
        worldBlocks.push({ source: 'Scene Notebook', content: notebookText, tokens: countTokens(notebookText), reason: 'Active scene state' });
    }

    // Active NPCs
    if (npcLedger && npcLedger.length > 0) {
        const loreHeadersSet = new Set((relevantLore ?? []).map(l => l.header.toLowerCase()));
        const nonArchivedLedger = npcLedger.filter(npc => !npc.archived);

        let activeNPCs: NPCEntry[];

        if (recommendedNPCNames && recommendedNPCNames.length > 0) {
            // ── Utility AI Recommender mode ──
            // Use the pre-computed list from contextRecommender.ts
            const recommendedSet = new Set(recommendedNPCNames.map(n => n.toLowerCase()));
            activeNPCs = nonArchivedLedger.filter(npc => {
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const allNames = [npc.name.toLowerCase(), ...aliases];
                return allNames.some(n => recommendedSet.has(n));
            });
            console.log(`[PayloadBuilder] NPC selection via UtilityAI recommender: ${activeNPCs.length} active.`);
        } else {
            // ── Legacy substring scan mode ──
            const scanHistory = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;
            activeNPCs = nonArchivedLedger.filter(npc => {
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const patterns = [npc.name.toLowerCase(), ...aliases];
                return patterns.some(p => scanHistory.toLowerCase().includes(p));
            });
        }

        if (activeNPCs.length > 0) {
            const npcText = `[ACTIVE NPC CONTEXT]\n${activeNPCs.map(npc => {
                // Minified base line (compact single-line format)
                let line = minifyNPC(npc);
                const directive = buildBehaviorDirective(npc);
                if (directive) line += ` | ${directive}`;
                const drift = buildDriftAlert(npc);
                if (drift) line += ` | ${drift}`;
                return line;
            }).join('\n')}\n[END NPC CONTEXT]`;
            worldBlocks.push({ source: 'Active NPCs', content: npcText, tokens: countTokens(npcText), reason: `NPCs detected in context (${activeNPCs.length}, minified)` });
        }
    }

    // --- 4. Budget & Trim World Context ---
    let worldContent = '';
    let currentWorldTokens = 0;
    for (const block of worldBlocks) {
        if (currentWorldTokens + block.tokens <= budgetMap.world) {
            worldContent += (worldContent ? '\n\n' : '') + block.content;
            currentWorldTokens += block.tokens;
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: block.reason, included: true, position: 'system_dynamic' });
        } else {
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Dropped: Exceeds World budget (${budgetMap.world} t)`, included: false, position: 'system_dynamic' });
        }
    }

    // --- 5. Volatile State (Profile, Inventory) ---
    const volatileParts: string[] = [];
    if (context.characterProfileActive && context.characterProfile) volatileParts.push(`[CHARACTER PROFILE]\n${context.characterProfile}`);
    if (context.inventoryActive && context.inventory) volatileParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    addTrace({ source: 'Profile/Inventory', classification: 'volatile_state', tokens: volatileTokens, reason: 'Player state', included: true, position: 'system_dynamic' });

    // --- 6. Fit History ---
    const userTokens = countTokens(userMessage);
    const reservedTotal = stableTokens + divergenceTokens + currentWorldTokens + volatileTokens + userTokens;
    const historyBudget = limit - reservedTotal - 200; // Small safety margin of 200 tokens

    const candidateMessages = (condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const fitted: OpenAIMessage[] = [];
    let historyUsed = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];

        // Skip completed tool-call exchanges — only the final narrative response matters.
        // reasoning_content overhead is not needed in fitted history.
        if (msg.role === 'tool') continue;
        if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) continue;

        let content = msg.content ?? null;
        if (msg.role === 'user' && typeof content === 'string') {
            content = content.replace(/\n?\[(?:DICE OUTCOMES:|SURPRISE EVENT:|ENCOUNTER EVENT:|WORLD_EVENT:)[^\]]*\]/g, '');
        }
        // Strip in-band <think> blocks from assistant content — reasoning is
        // per-turn and not useful in long-term history (same as reasoning_content).
        if (msg.role === 'assistant' && typeof content === 'string') {
            content = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim() || content;
        }

        const textToEstimate = content || '';
        const cost = countTokens(textToEstimate);
        if (historyUsed + cost > historyBudget) break;

        const openAIMsg: OpenAIMessage = {
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content
        };
        if (msg.name) openAIMsg.name = msg.name;
        if (msg.tool_call_id) openAIMsg.tool_call_id = msg.tool_call_id;

        fitted.unshift(openAIMsg);
        historyUsed += cost;
    }

    // Protect orphaned tools
    while (fitted.length > 0 && fitted[0].role === 'tool') fitted.shift();

    addTrace({
        source: 'Fitted History', classification: 'summary', tokens: historyUsed,
        reason: `Included ${fitted.length} msgs within ${historyBudget} budget`,
        included: true, position: 'history',
        childMessages: fitted.map(m => {
            const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content) ?? '';
            return { role: m.role, tokens: countTokens(text), preview: text.slice(0, 80).replace(/\n/g, ' ') };
        }),
    });
    addTrace({ source: 'User Message', classification: 'volatile_state', tokens: userTokens, reason: 'Current turn', included: true, position: 'user' });

    // --- 7. Depth-Based Scene Note Insertion ---
    if (context.sceneNoteActive && context.sceneNote) {
        const noteText = `[SCENE NOTE: VOLATILE GUIDANCE]\n${context.sceneNote}`;
        const noteMsg: OpenAIMessage = { role: 'system', content: noteText };
        const depth = context.sceneNoteDepth ?? 3;

        // Splice into fitted history
        if (fitted.length > 0) {
            const index = Math.max(0, fitted.length - depth);
            fitted.splice(index, 0, noteMsg);
            addTrace({ source: 'Scene Note (Depth)', classification: 'scene_local', tokens: countTokens(noteText), reason: `Injected at depth ${depth}`, included: true, position: `history_at_${depth}` });
        } else {
            // Fallback to end of system prompt if no history
            fitted.push(noteMsg);
            addTrace({ source: 'Scene Note (Fallback)', classification: 'scene_local', tokens: countTokens(noteText), reason: 'Injected after system (no history)', included: true, position: 'dynamic_suffix' });
        }
    }

    // --- 8. Final Assembly ---
    const messages: OpenAIMessage[] = [];
    if (stableContent) messages.push({ role: 'system', content: stableContent });
    if (divergenceContent) messages.push({ role: 'system', content: divergenceContent });
    if (worldContent || volatileContent) {
        messages.push({ role: 'system', content: [worldContent, volatileContent].filter(Boolean).join('\n\n') });
    }
    messages.push(...fitted);
    messages.push({ role: 'user', content: userMessage });

    return { messages, trace: isDebug ? trace : undefined };
}
