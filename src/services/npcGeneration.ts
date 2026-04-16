import type { LLMProvider, ChatMessage, NPCEntry } from '../types';
import { llmCall } from '../utils/llmCall';
import { extractJson } from './payloadBuilder';
import { uid } from '../utils/uid';

export async function generateNPCProfile(
    provider: LLMProvider,
    history: ChatMessage[],
    npcName: string,
    addNPCToStore: (npc: NPCEntry) => void
): Promise<void> {
    try {
        console.log(`[NPC Generator] Initiating background profile generation for: ${npcName}`);

        // Grab recent context (last ~15 messages should give enough flavor)
        const recentHistory = history.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

        const systemPrompt = `You are a background GM assistant running silently.
The game mentioned a new character named "${npcName}".
Your job is to generate a psychological profile for this character based on the recent chat history.
If the character is barely mentioned, invent a plausible, tropes-appropriate profile that fits the current scene context.

RESPOND ONLY WITH VALID JSON. NO MARKDOWN FORMATTING. NO EXPLANATIONS.
The JSON must perfectly match this structure:
{
  "name": "String (The primary name)",
  "aliases": "String (Comma separated aliases or titles)",
  "status": "String (Alive, Deceased, Missing, or Unknown)",
  "faction": "String (The faction, group, or origin this NPC belongs to)",
  "storyRelevance": "String (Why this NPC matters to the current story)",
  "disposition": "String (Helpful, Hostile, Suspicion, etc)",
  "goals": "String (Core motive)",
  "nature": 5,
  "training": 5,
  "emotion": 5,
  "social": 5,
  "belief": 5,
  "ego": 5
}
Note: the 6 axes (nature...ego) MUST be integers from 1 to 10.`;

        const fullPrompt = `${systemPrompt}\n\nRECENT CHAT HISTORY:\n${recentHistory}\n\nGenerate the JSON profile for "${npcName}".`;

        const fullJsonStr = await llmCall(provider, fullPrompt, { priority: 'low' });

        if (fullJsonStr) {
            const cleanStr = extractJson(fullJsonStr);

            try {
                const parsed = JSON.parse(cleanStr);

                const newEntry: NPCEntry = {
                    id: uid(),
                    name: parsed.name || npcName,
                    aliases: parsed.aliases || '',
                    status: parsed.status || 'Alive',
                    faction: parsed.faction || 'Unknown',
                    storyRelevance: parsed.storyRelevance || 'Unknown',
                    appearance: '',
                    disposition: parsed.disposition || 'Neutral',
                    goals: parsed.goals || 'Unknown',
                    nature: Number(parsed.nature) || 5,
                    training: Number(parsed.training) || 5,
                    emotion: Number(parsed.emotion) || 5,
                    social: Number(parsed.social) || 5,
                    belief: Number(parsed.belief) || 5,
                    ego: Number(parsed.ego) || 5,
                    affinity: 50,
                };

                addNPCToStore(newEntry);
                console.log(`[NPC Generator] Successfully generated and added profile for: ${newEntry.name}`);

            } catch (parseErr) {
                console.error('[NPC Generator] Failed to parse generated JSON:', parseErr, '\nRaw String:', cleanStr);
            }
        }

    } catch (err) {
        console.error('[NPC Generator] Fatal error during generation:', err);
    }
}

/**
 * Background auto-update for existing NPCs that were mentioned in the chat.
 * Asks the LLM if any relevant attributes have changed based on recent context.
 */
export async function updateExistingNPCs(
    provider: LLMProvider,
    history: ChatMessage[],
    npcsToCheck: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void
) {
    if (!npcsToCheck.length) return;

    console.log(`[NPC Updater] Checking for attribute shifts on ${npcsToCheck.length} existing NPC(s)...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const npcDatas = npcsToCheck.map(npc => {
        let data = `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Affinity: ${npc.affinity ?? 50}/100\n` +
            `Axes: Nature=${npc.nature}/10, Training=${npc.training}/10, Emotion=${npc.emotion}/10, Social=${npc.social}/10, Belief=${npc.belief}/10, Ego=${npc.ego}/10\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`;

        return data;
    }).join('\n\n');

    const prompt = `You are a background game state analyzer. Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, psychological axes, goals, disposition, faction, or relevance.

[RECENT CONTEXT]
${recentContext}
[END CONTEXT]

[CURRENT NPC STATES]
${npcDatas}
[END STATES]

If NO changes occurred for ANY of these NPCs, respond EXACTLY with:
{"updates": []}

If ANY changes occurred, respond with a JSON object containing an "updates" array. Each update must include the basic "name" and ANY attributes that have fundamentally changed (status, disposition, goals, nature, training, emotion, social, belief, ego, affinity, faction, storyRelevance). DO NOT include attributes that stayed the same.
Valid statuses: Alive, Deceased, Missing, Unknown.
Note: "affinity" is a 0-100 scale of how much they like the player (0=Nemesis, 50=Neutral, 100=Ally). Update this if the player did something to gain or lose favor.

Example of an NPC dying and getting angry:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "emotion": 9, "storyRelevance": "His death sparked a rebellion"}}]}

RESPOND ONLY WITH VALID JSON.`;

    try {
        const fullJsonStr = await llmCall(provider, prompt, { priority: 'low' });

        if (fullJsonStr) {
            const cleanStr = extractJson(fullJsonStr);
            const parsed = JSON.parse(cleanStr);

            if (parsed.updates && Array.isArray(parsed.updates)) {
                for (const update of parsed.updates) {
                    if (!update.name || !update.changes) continue;

                    // Find matching NPC (case-insensitive)
                    const targetNpc = npcsToCheck.find(n =>
                        n.name.toLowerCase() === update.name.toLowerCase() ||
                        (n.aliases && n.aliases.toLowerCase().includes(update.name.toLowerCase()))
                    );

                    if (targetNpc) {
                        const changes = { ...update.changes };

                        // Snapshot current axes before applying changes for drift detection
                        const axisFields = ['nature', 'training', 'emotion', 'social', 'belief', 'ego', 'affinity'] as const;
                        const hasAxisChange = axisFields.some(f => changes[f] !== undefined);

                        if (hasAxisChange) {
                            const previousAxes: Record<string, number> = {};
                            for (const f of axisFields) {
                                if (changes[f] !== undefined) {
                                    previousAxes[f] = targetNpc[f] as number;
                                }
                            }
                            changes.previousAxes = previousAxes;
                            changes.shiftTurnCount = 0;
                        } else if (targetNpc.shiftTurnCount !== undefined && targetNpc.shiftTurnCount < 3) {
                            changes.shiftTurnCount = (targetNpc.shiftTurnCount || 0) + 1;
                        }

                        updateNPCStore(targetNpc.id, changes);
                        console.log(`[NPC Updater] Applied changes to ${targetNpc.name}:`, changes);
                    }
                }
            } else {
                console.log(`[NPC Updater] No updates required.`);
            }
        }
    } catch (err) {
        console.error('[NPC Updater] Failed to parse generated JSON or fatal error:', err);
    }
}
