import type { DivergenceRegister, TopicClusters, TopicCluster, LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';
import { extractJson } from './payloadBuilder';

export async function runFactClustering(
    register: DivergenceRegister,
    utilityProvider: LLMProvider,
): Promise<TopicClusters> {
    const entries = register.entries;
    if (entries.length === 0) {
        return { groups: [], generatedAt: new Date().toISOString(), generatedFromFactCount: 0 };
    }

    const factLines = entries
        .map(e => `${e.id} | ${e.chapterId} | ${e.category} | ${e.text.slice(0, 120)}`)
        .join('\n');

    const prompt = `You are organizing campaign facts for a TTRPG. Group the facts below by recurring entity or theme — a specific NPC, a location, an ongoing storyline, a faction, or a concept that appears across multiple facts.

FACTS (id | chapter | category | text):
${factLines}

RULES:
- Each fact must appear in exactly one group.
- Aim for 8–20 groups. Prefer specific names (e.g. "Yuki", "The Bridge District") over generic labels.
- If a fact doesn't fit anywhere, put it in "Uncategorized".
- Return ONLY a JSON object in this exact shape, no prose:
{
  "groups": [
    { "name": "Yuki", "factIds": ["id1", "id2"] },
    { "name": "Reaper Contract", "factIds": ["id3"] }
  ]
}`;

    const raw = await llmCall(utilityProvider, prompt, {
        temperature: 0.2,
        maxTokens: 2000,
        timeoutMs: 60_000,
        trackingLabel: 'fact-clusterer',
    });

    const jsonStr = extractJson(raw);
    const parsed: { groups: Array<{ name: string; factIds: string[] }> } = JSON.parse(jsonStr);

    const knownIds = new Set(entries.map(e => e.id));
    const assignedIds = new Set<string>();

    const groups: TopicCluster[] = parsed.groups
        .filter(g => g.name && Array.isArray(g.factIds))
        .map((g, i) => {
            const validIds = g.factIds.filter(id => knownIds.has(id) && !assignedIds.has(id));
            validIds.forEach(id => assignedIds.add(id));
            return {
                id: `cluster-${i}-${g.name.toLowerCase().replace(/\s+/g, '-').slice(0, 20)}`,
                name: g.name,
                factIds: validIds,
            };
        })
        .filter(g => g.factIds.length > 0);

    const unassigned = entries.map(e => e.id).filter(id => !assignedIds.has(id));
    if (unassigned.length > 0) {
        groups.push({
            id: 'cluster-uncategorized',
            name: 'Uncategorized',
            factIds: unassigned,
        });
    }

    return {
        groups,
        generatedAt: new Date().toISOString(),
        generatedFromFactCount: entries.length,
    };
}
