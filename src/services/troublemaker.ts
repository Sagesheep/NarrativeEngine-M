import type { LLMProvider, ChatMessage, ArchiveIndexEntry, ArchiveChapter, NPCEntry } from '../types';
import { llmCall } from '../utils/llmCall';

export async function generateTroubleOptions(
    provider: LLMProvider,
    messages: ChatMessage[],
    archiveIndex: ArchiveIndexEntry[],
    chapters: ArchiveChapter[],
    npcLedger: NPCEntry[],
): Promise<string[]> {
    const recentMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-15);
    const conversationSnippet = recentMessages
        .map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : ''}`)
        .join('\n');

    const recentScenes = archiveIndex.slice(-5).map(s => `Scene ${s.sceneId}: ${s.userSnippet}`).join('\n');

    const sealedChapters = chapters.filter(c => c.sealedAt != null && !c.invalidated);
    const unresolvedThreads = sealedChapters
        .flatMap(c => c.unresolvedThreads ?? [])
        .slice(0, 10);

    const activeNPCs = npcLedger
        .filter(npc => {
            const pressure = npc.pressure;
            return pressure && (pressure.ignored > 1 || pressure.engaged > 1);
        })
        .map(npc => ({
            name: npc.name,
            role: npc.storyRelevance || 'unknown',
            ignoredPressure: npc.pressure?.ignored ?? 0,
            engagedPressure: npc.pressure?.engaged ?? 0,
        }));

    const prompt = `You are a narrative director for a tabletop RPG. Analyze the recent campaign activity and identify what the player has been repeatedly doing (their loop or grind pattern).

Recent conversation:
${conversationSnippet}

Recent scene summaries:
${recentScenes || '(none)'}

Unresolved story threads from past chapters:
${unresolvedThreads.length > 0 ? unresolvedThreads.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)'}

Active NPCs with pressure:
${activeNPCs.length > 0 ? activeNPCs.map(n => `- ${n.name} (${n.role}): ignored=${n.ignoredPressure}, engaged=${n.engagedPressure}`).join('\n') : '(none)'}

Generate 4 distinct ARC SEEDS — each one is an ongoing storyline that unfolds over multiple scenes as a natural consequence of the player's behavior. Not a one-scene event. A new thread that will keep developing.

Each arc must:
- Be a DIFFERENT arc TYPE (one of: threat, social/relationship, rivalry, opportunity/resource)
- Start with a concrete first-scene hook (what happens NOW to begin the arc)
- Hint at where it leads over time (not resolved immediately)
- Be grounded in established world details (character names, places, factions already present)

Return ONLY a JSON array of 4 strings. Each string = 2 sentences: the hook + the direction.
["...", "...", "...", "..."]`;

    const raw = await llmCall(provider, prompt, { maxTokens: 4000, thinkingEffort: 'low' });

    try {
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('No JSON array found in response');
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed) || parsed.length < 4) {
            throw new Error('Expected 4 options, got ' + (Array.isArray(parsed) ? parsed.length : 'non-array'));
        }
        return parsed.slice(0, 4).map(String);
    } catch {
        const lines = raw.split('\n').map(l => l.replace(/^\d+[\.\)]\s*/, '').trim()).filter(l => l.length > 10);
        if (lines.length >= 4) return lines.slice(0, 4);
        throw new Error('Could not parse trouble options from LLM response');
    }
}