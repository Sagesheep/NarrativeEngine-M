import type { GameContext } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { uid } from '../utils/uid';
import { llmCall } from '../utils/llmCall';

export async function handleInterventions(state: TurnState, callbacks: TurnCallbacks, finalInput: string, abortController: AbortController) {
    const { context, forcedInterventions, messages } = state;
    const activeTriggers: ('enemy' | 'neutral' | 'ally')[] = [];

    const isCooldownActive = (type: 'enemy' | 'neutral' | 'ally') => {
        const cooldownValue = context[`${type}Cooldown` as keyof GameContext] as number ?? 2;
        if (cooldownValue === 0) return false;

        const nameMatch = `AI_${type.toUpperCase()}`;
        const sliceCount = (cooldownValue * 2) + 1;
        const recentMessages = messages.slice(-Math.abs(sliceCount));

        return recentMessages.some(m => m.name === nameMatch);
    };

    let nextQueue = [...(context.interventionQueue || [])];

    if (forcedInterventions && forcedInterventions.length > 0) {
        activeTriggers.push(...forcedInterventions);
    }
    else {
        if (nextQueue.length > 0) {
            const nextType = nextQueue.shift()!;
            activeTriggers.push(nextType);
            callbacks.updateContext({ interventionQueue: nextQueue });
        }
        else if (context.interventionChance) {
            const chance = context.interventionChance;
            const rolledSuccess: ('enemy' | 'neutral' | 'ally')[] = [];

            if (context.enemyPlayerActive && !isCooldownActive('enemy') && Math.random() * 100 < chance) rolledSuccess.push('enemy');
            if (context.neutralPlayerActive && !isCooldownActive('neutral') && Math.random() * 100 < chance) rolledSuccess.push('neutral');
            if (context.allyPlayerActive && !isCooldownActive('ally') && Math.random() * 100 < chance) rolledSuccess.push('ally');

            if (rolledSuccess.length > 0) {
                activeTriggers.push(rolledSuccess[0]);
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

    let worldGenre = context.worldVibe;
    if (!worldGenre && loreChunks.length > 0) {
        const overview = loreChunks.find(c => c.category === 'world_overview')
                      || loreChunks.find(c => c.header.toLowerCase().includes('overview'))
                      || loreChunks.find(c => c.alwaysInclude && c.priority > 8);

        if (overview) {
            worldGenre = `${overview.header}: ${overview.content.split('\n')[0].slice(0, 300)}`;
        }
    }
    worldGenre = worldGenre || "General Fantasy";

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

    const recentHistory = messages.slice(-2).map(m => ({
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content || "",
        name: m.name
    }));

    const finalPayload: import('./llmService').OpenAIMessage[] = [
        { role: 'system' as const, content: systemPrompt },
        ...recentHistory,
        { role: 'user' as const, content: `The User just attempted: "${triggerInput}". You rolled a ${d20} (${tier}). State your action.` }
    ];

    const combinedPrompt = finalPayload.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');

    callbacks.setLoadingStatus?.(`[AI PLAYER] ${type.toUpperCase()} IS INTERVENING...`);

    let resultText = "";
    try {
        resultText = await llmCall(endpoint, combinedPrompt, {
            signal: abortController.signal,
            priority: 'normal',
        });
    } catch (err) {
        console.warn(`[AI Player] ${type} failed to generate:`, err);
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
