import type { DivergenceRegister, TopicClusters, TopicCluster, LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';
import { countTokens } from './tokenizer';
import { extractJsonRobust } from './jsonExtract';

export type ClusteringCancelled = { cancelled: boolean };

export async function runFactClustering(
    register: DivergenceRegister,
    utilityProvider: LLMProvider,
    contextLimit: number,
    cancel: ClusteringCancelled,
    onStatus: (msg: string) => void,
): Promise<TopicClusters> {
    const entries = register.entries;
    if (entries.length === 0) {
        return { groups: [], generatedAt: new Date().toISOString(), generatedFromFactCount: 0 };
    }

    const textLimit = entries.length > 150 ? 80 : 120;
    const factLines = entries
        .map(e => `${e.id}|${e.chapterId}|${e.text.slice(0, textLimit)}`)
        .join('\n');

    const prompt = `You are organizing campaign facts for a TTRPG. Group the facts below by recurring entity or theme — a specific NPC, a location, an ongoing storyline, a faction, or a concept that appears across multiple facts.

FACTS (id|chapter|text):
${factLines}

RULES:
- Each fact must appear in exactly one group.
- Aim for 8–20 groups. Prefer specific names (e.g. "Yuki", "The Bridge District") over generic labels.
- IMPORTANT: Include ALL ${entries.length} fact IDs across your groups — do not omit any.
- Return ONLY valid complete JSON, no prose, no truncation:
{"groups":[{"name":"Yuki","factIds":["id1","id2"]},{"name":"Reaper Contract","factIds":["id3"]}]}`;

    const promptTokens = countTokens(prompt);
    const maxTokens = Math.floor(contextLimit * 0.75);

    console.log(
        `[FactClusterer] ${entries.length} facts · prompt: ${promptTokens} tkns · maxResponse: ${maxTokens} tkns · model: ${utilityProvider.modelName || utilityProvider.endpoint}`
    );
    onStatus(`Sending ${promptTokens.toLocaleString()} tokens to model…`);

    const raw = await llmCall(utilityProvider, prompt, {
        temperature: 0.2,
        maxTokens,
        // 24 h sentinel — native readTimeout is 600 s; this just keeps the tracker alive.
        // Real "stop" is the cancel flag checked after the call.
        timeoutMs: 24 * 60 * 60 * 1000,
        trackingLabel: 'fact-clusterer',
    });

    if (cancel.cancelled) throw new Error('Clustering cancelled.');

    onStatus(`Parsing response (${raw.length.toLocaleString()} chars)…`);
    console.log(`[FactClusterer] Response: ${raw.length} chars`);

    const { value: parsed, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(
        raw,
        { groups: [] },
    );

    if (!parseOk) {
        throw new Error('Response was truncated and could not be recovered. Try a model with a larger output limit.');
    }

    if (!Array.isArray(parsed.groups)) {
        throw new Error('AI response missing "groups" array.');
    }

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

    // Any facts the AI omitted → Uncategorized
    const unassigned = entries.map(e => e.id).filter(id => !assignedIds.has(id));
    if (unassigned.length > 0) {
        groups.push({
            id: 'cluster-uncategorized',
            name: 'Uncategorized',
            factIds: unassigned,
        });
    }

    const result: TopicClusters = {
        groups,
        generatedAt: new Date().toISOString(),
        generatedFromFactCount: entries.length,
    };

    console.log(`[FactClusterer] Done — ${groups.length} groups, ${assignedIds.size} assigned, ${unassigned.length} uncategorized`);
    return result;
}
