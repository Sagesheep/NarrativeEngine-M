import type { ChatMessage, GameContext, ProviderConfig } from '../types';

const VERBATIM_WINDOW = 5;
const CONDENSE_BUDGET_RATIO = 0.4;
const META_SUMMARY_THRESHOLD = 1600; // ~100-130 bullet points, ~6 hours of play

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export function shouldCondense(
    messages: ChatMessage[],
    contextLimit: number,
    condensedUpToIndex: number
): boolean {
    const uncondensedMessages = messages.slice(condensedUpToIndex + 1);
    if (uncondensedMessages.length <= VERBATIM_WINDOW) return false;

    const historyTokens = estimateTokens(
        uncondensedMessages.map((m) => m.content).join('')
    );
    return historyTokens > contextLimit * CONDENSE_BUDGET_RATIO;
}

export function getVerbatimWindow(): number {
    return VERBATIM_WINDOW;
}

/**
 * Incremental condensation prompt — only summarizes NEW messages into bullet points.
 * Does NOT re-read the existing summary. Output is appended locally.
 */
function buildIncrementalPrompt(
    newMessages: ChatMessage[],
    canonState: string,
    headerIndex: string
): string {
    const canonBlock = [canonState, headerIndex].filter(Boolean).join('\n\n');

    const turns = newMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const parts: string[] = [
        'You are a TTRPG session scribe. Compress the following chat turns into concise bullet points.',
        '',
        'RULES:',
        '1. Preserve ALL dice rolls, damage numbers, HP/MP changes exactly',
        '2. Preserve ALL item names, NPC names, location names EXACTLY as written',
        '3. Use the Canonical Terms below — DO NOT paraphrase, rename, or synonym-swap any proper nouns',
        '4. Keep quest/objective updates',
        '5. Drop flavour text and generic narration',
        '6. Output format: bullet points grouped by scene/event',
        '7. Be extremely concise — aim for 70% compression',
        '8. Output ONLY the bullet points for these turns. Do NOT include any previous history.',
    ];

    if (canonBlock) {
        parts.push('', 'CANONICAL TERMS (use these exact strings):', canonBlock);
    }

    parts.push('', 'TURNS TO SUMMARIZE:', turns);

    return parts.join('\n');
}

/**
 * Meta-summary prompt — compresses an existing bullet-point summary into broader story arcs.
 * Used when the summary exceeds META_SUMMARY_THRESHOLD tokens.
 */
function buildMetaSummaryPrompt(
    existingSummary: string,
    canonState: string,
    headerIndex: string
): string {
    const canonBlock = [canonState, headerIndex].filter(Boolean).join('\n\n');

    const parts: string[] = [
        'You are a TTRPG campaign historian. The following is a bullet-point log of events from a roleplay session.',
        'Your task is to compress this into a shorter narrative summary grouped by story arc or chapter.',
        '',
        'RULES:',
        '1. Preserve ALL proper nouns (character names, locations, items) EXACTLY',
        '2. Preserve ALL mechanical state changes (HP, status effects, deaths, quest completions)',
        '3. Merge related bullet points into paragraph-level summaries',
        '4. Group by story arc or major scene transition',
        '5. Target 50% compression — cut redundancy, not facts',
        '6. Output format: short paragraphs with arc headers',
    ];

    if (canonBlock) {
        parts.push('', 'CANONICAL TERMS (use these exact strings):', canonBlock);
    }

    parts.push('', 'BULLET-POINT LOG TO COMPRESS:', existingSummary);

    return parts.join('\n');
}

/** Send a non-streaming LLM request for condensation / meta-summary */
async function callLLM(provider: ProviderConfig, prompt: string): Promise<string> {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: provider.modelName,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Condenser API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Main condensation pipeline:
 *   1. If existing summary exceeds META_SUMMARY_THRESHOLD → meta-summarize it first
 *   2. Summarize only the NEW messages into bullet points (incremental)
 *   3. Append new bullet points to existing summary
 */
export async function condenseHistory(
    provider: ProviderConfig,
    messages: ChatMessage[],
    context: GameContext,
    condensedUpToIndex: number,
    existingSummary: string
): Promise<{ summary: string; upToIndex: number }> {
    const uncondensed = messages.slice(condensedUpToIndex + 1);
    const toCondense = uncondensed.slice(0, -VERBATIM_WINDOW);

    if (toCondense.length === 0) {
        return { summary: existingSummary, upToIndex: condensedUpToIndex };
    }

    let currentSummary = existingSummary;

    // Step 1: Meta-summary if existing summary is too long
    if (currentSummary && estimateTokens(currentSummary) > META_SUMMARY_THRESHOLD) {
        console.log(`[Condenser] Summary exceeded ${META_SUMMARY_THRESHOLD} tokens — running meta-summary compression...`);
        const metaPrompt = buildMetaSummaryPrompt(currentSummary, context.canonState, context.headerIndex);
        const compressed = await callLLM(provider, metaPrompt);
        if (compressed) {
            const before = estimateTokens(currentSummary);
            const after = estimateTokens(compressed);
            console.log(`[Condenser] Meta-summary: ${before} → ${after} tokens (${Math.round((1 - after / before) * 100)}% compression)`);
            currentSummary = compressed;
        }
    }

    // Step 2: Incremental — only summarize NEW messages
    console.log(`[Condenser] Summarizing ${toCondense.length} new message(s) incrementally...`);
    const incrementalPrompt = buildIncrementalPrompt(toCondense, context.canonState, context.headerIndex);
    const newBullets = await callLLM(provider, incrementalPrompt);

    // Step 3: Append new bullets to existing summary
    const combined = currentSummary
        ? currentSummary + '\n\n' + newBullets
        : newBullets;

    const lastCondensedMsg = toCondense[toCondense.length - 1];
    const newUpToIndex = messages.indexOf(lastCondensedMsg);

    console.log(`[Condenser] Done. Total summary: ~${estimateTokens(combined)} tokens. Condensed up to message index ${newUpToIndex}.`);

    return { summary: combined, upToIndex: newUpToIndex };
}
