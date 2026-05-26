import type { DivergenceRegister, TopicClusters, TopicCluster, LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';
import { countTokens } from './tokenizer';
import { extractJsonRobust } from './jsonExtract';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    joinPromptSections,
} from './utilityPrompts';

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

    const prompt = joinPromptSections(
        'You are organizing campaign facts for a TTRPG. Group the facts below by recurring entity or theme — a specific NPC, a location, an ongoing storyline, a faction, or a concept that appears across multiple facts.',

        `OUTPUT FORMAT — a single JSON object:
{"groups":[{"name":"<group label>","factIds":["<id>","<id>"]}]}`,

        `RULES:
- Each fact must appear in EXACTLY one group.
- Include EVERY fact ID listed below — do not omit any.
- Aim for 8–20 groups. Prefer specific names (e.g. "Yuki", "The Bridge District") over generic labels.
- Return ONLY valid complete JSON, no prose, no truncation.`,

        `EXAMPLES (synthetic — do not echo these ids):

Given facts:
f_x1|001|Yuki swore vengeance against the Reaper guild
f_x2|001|Yuki's sister was killed at the Bridge District
f_x3|002|The Reaper guild controls the eastern docks
f_x4|002|Aldric promised to help Yuki find the killer

GOOD output (every id assigned, specific names):
{"groups":[
  {"name":"Yuki","factIds":["f_x1","f_x2"]},
  {"name":"Reaper guild","factIds":["f_x3"]},
  {"name":"Aldric's promise","factIds":["f_x4"]}
]}

BAD — every fact MUST appear (this drops f_x4):
{"groups":[
  {"name":"Yuki","factIds":["f_x1","f_x2"]},
  {"name":"Reaper guild","factIds":["f_x3"]}
]}
Corrected: add a group for f_x4 (e.g. "Aldric's promise") or fold f_x4 into "Yuki".`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `Total facts to assign: ${entries.length}`,
        `FACTS (id|chapter|text):\n${factLines}`,
    );

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
