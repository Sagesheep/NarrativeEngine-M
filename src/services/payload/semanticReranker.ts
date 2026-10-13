import type { LLMProvider } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    JSON_ARRAY_ONLY_FOOTER,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    joinPromptSections,
} from '../infrastructure';

export type RerankCandidate = {
    id: string;
    summary: string;
    type: 'scene' | 'lore';
};

export async function rerankCandidates(
    query: string,
    candidates: RerankCandidate[],
    utilityEndpoint: LLMProvider,
    opts?: { maxCandidates?: number; topN?: number; timeoutMs?: number; trackingLabel?: string }
): Promise<string[]> {
    const maxCandidates = opts?.maxCandidates ?? 30;
    const topN = opts?.topN ?? 12;

    if (candidates.length < 5) {
        return candidates.map(c => c.id);
    }

    const inputIds = new Set(candidates.map(c => c.id));
    const capped = candidates.slice(0, maxCandidates);

    const prompt = joinPromptSections(
        'You are filtering memory candidates for relevance.',

        `Return a JSON array of the candidate ids most relevant to the query, in descending order of relevance, each id written exactly as below as a JSON string (e.g. ["${capped[0].id}"]). Max ${topN} ids.`,

        JSON_ARRAY_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `QUERY: "${query}"`,
        `CANDIDATES (id → summary):\n${capped.map(c => `${c.id}: ${c.summary}`).join('\n')}`,
    );

    try {
        const raw = await llmCall(utilityEndpoint, prompt, {
            temperature: 0.1,
            priority: 'high',
            maxTokens: 500,
            thinkingEffort: 'off',
            ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs, trackingLabel: opts?.trackingLabel ?? 'reranker' } : {}),
        });

        let cleanContent = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = cleanContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) cleanContent = mdMatch[1];
        // Models often answer scene ids as bare numbers ("[534, 062]"): a leading zero is
        // not valid JSON, and a number is not a string, so the whole answer used to be
        // dropped and the input order kept. Quote bare numbers, then match by number too.
        cleanContent = cleanContent.replace(/([[,]\s*)(\d+)(?=\s*[,\]])/g, '$1"$2"');

        const bracketStart = cleanContent.indexOf('[');
        const bracketEnd = cleanContent.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1 || bracketEnd <= bracketStart) {
            console.warn('[Reranker] No JSON array found in response');
            return candidates.map(c => c.id);
        }

        const arrayStr = cleanContent.substring(bracketStart, bracketEnd + 1);
        const parsed = JSON.parse(arrayStr);

        if (!Array.isArray(parsed)) {
            console.warn('[Reranker] Response is not an array');
            return candidates.map(c => c.id);
        }

        const validIds: string[] = [];
        const dropped: string[] = [];
        const byNumber = new Map(candidates.filter(c => /^\d+$/.test(c.id)).map(c => [Number(c.id), c.id]));
        for (const item of parsed) {
            if (typeof item !== 'string' && typeof item !== 'number') continue;
            const key = String(item).trim();
            const id = inputIds.has(key) ? key : /^\d+$/.test(key) ? byNumber.get(Number(key)) : undefined;
            if (id && !validIds.includes(id)) validIds.push(id);
            else if (!id) dropped.push(key);
        }

        if (dropped.length > 0) {
            console.warn(`[Reranker] Dropped hallucinated ids: ${dropped.join(', ')}`);
        }

        return validIds.length > 0 ? validIds.slice(0, topN) : candidates.map(c => c.id);
    } catch (err) {
        console.warn('[Reranker] Error, returning input order:', err);
        return candidates.map(c => c.id);
    }
}