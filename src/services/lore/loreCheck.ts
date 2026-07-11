import type {
    LLMProvider,
    LoreChunk,
    ArchiveIndexEntry,
    ArchiveChapter,
    ChatMessage,
    LoreCheckResult,
    LoreCheckCitation,
    LoreCheckVerdict,
    LoreCheckCategory,
    NPCEntry,
} from '../../types';
import { llmCall } from '../llm/llmCall';
import { retrieveRelevantLore } from './loreRetriever';
import { deepArchiveScan } from '../archive';
import { semanticSearch, isEmbedderReady } from '../embedding';
import { expandQuery } from '../turn/stages/expandQueryStage';
import { realUtilityLLM } from '../turn/utilityLLM';
import {
    extractJsonRobust,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    joinPromptSections,
} from '../infrastructure';

export type LoreCheckInput = {
    utilityEndpoint: LLMProvider;
    selectedText: string;
    surroundingContext: string;
    messages: ChatMessage[];
    targetMessageId: string;
    loreChunks: LoreChunk[];
    archiveIndex: ArchiveIndexEntry[];
    sealedChapters: ArchiveChapter[];
    campaignId: string;
    npcLedger: NPCEntry[];
    onStatus: (msg: string) => void;
    signal?: AbortSignal;
    hint?: string;
    categories?: LoreCheckCategory[];
};

export function buildSearchQuery(selectedText: string, hint?: string): string {
    const parts = [selectedText, hint?.trim()].filter(Boolean);
    return parts.join(' — ');
}

export async function runLoreCheck(input: LoreCheckInput): Promise<LoreCheckResult> {
    const {
        utilityEndpoint, selectedText, surroundingContext,
        messages, targetMessageId, loreChunks,
        archiveIndex, sealedChapters, campaignId,
        npcLedger, onStatus, signal, hint, categories,
    } = input;

    const searchQuery = buildSearchQuery(selectedText, hint);

    const targetIdx = messages.findIndex(m => m.id === targetMessageId);
    const contextSlice = targetIdx >= 0
        ? messages.slice(Math.max(0, targetIdx - 3), targetIdx + 1)
        : messages.slice(-4);

    onStatus('Expanding query...');
    let queries = [searchQuery];
    const isShort = searchQuery.trim().split(/\s+/).length < 8;
    if (isShort) {
        try {
            const utilityLLM = realUtilityLLM(() => utilityEndpoint);
            queries = await expandQuery(searchQuery, npcLedger, utilityLLM);
        } catch (err) {
            console.warn('[LoreCheck] Query expansion failed (non-fatal):', err);
        }
    }

    onStatus('Searching lore...');
    let semanticLoreIds: string[] | undefined;
    if (isEmbedderReady() && campaignId) {
        try {
            semanticLoreIds = await semanticSearch(campaignId, queries, 'lore', 25, 0.30) ?? undefined;
        } catch (err) {
            console.warn('[LoreCheck] Semantic lore search failed (non-fatal):', err);
        }
    }

    const loreHits = retrieveRelevantLore(loreChunks, searchQuery, 1500, contextSlice, semanticLoreIds);

    onStatus('Scanning archive...');
    let archiveBrief = '';
    if (sealedChapters.length > 0 && archiveIndex.length > 0) {
        try {
            archiveBrief = await deepArchiveScan(
                utilityEndpoint,
                archiveIndex,
                sealedChapters,
                campaignId,
                contextSlice,
                searchQuery,
                1500,
                onStatus,
            );
        } catch (err) {
            console.warn('[LoreCheck] deepArchiveScan failed (non-fatal):', err);
            archiveBrief = '';
        }
    }

    onStatus('Verifying...');
    const loreText = loreHits.length === 0
        ? '(no relevant lore entries found)'
        : loreHits.map(c => `### ${c.header}\n${c.content}`).join('\n\n');

    const archiveText = archiveBrief.trim() || '(no archived scenes available)';

    const prompt = buildVerifierPrompt({
        selectedText,
        surroundingContext,
        loreText,
        archiveText,
        hint,
        categories,
    });

    const raw = await llmCall(utilityEndpoint, prompt, {
        temperature: 0.1,
        maxTokens: 16384,
        priority: 'high',
        signal,
    });

    return parseVerdict(raw, selectedText);
}

export type DirectRewriteInput = {
    utilityEndpoint: LLMProvider;
    selectedText: string;
    surroundingContext: string;
    /** The authoritative fact the user supplied. Treated as ground truth, not checked. */
    fact: string;
    signal?: AbortSignal;
};

/**
 * Edit-and-replace mode. The user already knows the correct fact, so we skip all
 * retrieval/verification and just rewrite the highlighted sentence to state that fact.
 */
export async function runDirectRewrite(input: DirectRewriteInput): Promise<LoreCheckResult> {
    const { utilityEndpoint, selectedText, surroundingContext, fact, signal } = input;

    const prompt = buildRewritePrompt({ selectedText, surroundingContext, fact });

    const raw = await llmCall(utilityEndpoint, prompt, {
        temperature: 0.3,
        maxTokens: 4096,
        priority: 'high',
        signal,
    });

    return parseRewrite(raw, selectedText);
}

export function buildRewritePrompt(args: {
    selectedText: string;
    surroundingContext: string;
    fact: string;
}): string {
    return joinPromptSections(
        'You are a precise copy editor for a tabletop RPG narration. The player has highlighted a SENTENCE the GM wrote and supplied a FACT they know to be true. Your only job is to rewrite the sentence so it states the fact correctly.',

        `Rules:
- Treat the FACT as authoritative ground truth. Do NOT question it, soften it, or check it against anything.
- Change ONLY what is needed to make the SENTENCE consistent with the FACT.
- Preserve the GM's tone, voice, tense, and approximate length.
- Do NOT add new events, NPCs, places, or commitments beyond what the FACT states.
- The SURROUNDING CONTEXT is for tone and continuity reference only — your rewrite replaces just the SENTENCE, so it must read naturally between those neighbors.
- If the SENTENCE already matches the FACT, return it essentially unchanged.`,

        `OUTPUT SCHEMA:
{
  "rewrite": "the rewritten sentence"
}`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `[SENTENCE]\n${args.selectedText}`,
        `[SURROUNDING CONTEXT]\n${args.surroundingContext}`,
        `[FACT]\n${args.fact}`,
    );
}

function parseRewrite(raw: string, originalText: string): LoreCheckResult {
    const { value, parseOk } = extractJsonRobust<{ rewrite?: unknown }>(raw, { rewrite: '' });
    const rewrite =
        parseOk && typeof value.rewrite === 'string' && value.rewrite.trim().length > 0
            ? value.rewrite.trim()
            : null;

    if (rewrite) {
        return { verdict: 'corrected', issues: [], citations: [], suggestedRewrite: rewrite, originalText };
    }

    console.warn('[DirectRewrite] Rewriter returned unparseable response. Raw:\n', raw);
    return {
        verdict: 'corrected',
        issues: ['Could not produce a rewrite from your fact. See raw output below.'],
        citations: [],
        suggestedRewrite: null,
        originalText,
        rawResponse: raw,
    };
}

export function buildVerifierPrompt(args: {
    selectedText: string;
    surroundingContext: string;
    loreText: string;
    archiveText: string;
    hint?: string;
    categories?: LoreCheckCategory[];
}): string {
    const hasConcern = (args.hint?.trim()) || (args.categories && args.categories.length > 0);
    let userConcernBlock = '';
    if (hasConcern) {
        const catList = args.categories?.length ? args.categories.join(', ') : '';
        const note = args.hint?.trim() ?? '';
        const parts: string[] = [];
        if (catList) parts.push(`Categories: ${catList}`);
        if (note) parts.push(`Note: "${note}"`);
        userConcernBlock = `[USER CONCERN]
${parts.join('\n')}

The user has flagged this sentence specifically because of the concern above.
Focus your verdict on whether the concern is justified, but you may still flag other clear issues you notice.`;
    }

    return joinPromptSections(
        'You are a narrative continuity auditor for a tabletop RPG campaign. A player has highlighted a sentence written by the GM and wants to know whether it is consistent with established lore and play history.',

        `You will receive:
- The highlighted SENTENCE
- The surrounding CONTEXT (sentence before and after, for tone reference only)
- LORE evidence (canonical world facts written by the player)
- ARCHIVE evidence (a brief summarizing past scenes from the campaign)${hasConcern ? '\n- A USER CONCERN describing why they flagged this sentence' : ''}`,

        `Your job:
1. Decide a verdict:
   - "consistent": the sentence is supported (or at least not contradicted) by the evidence.
   - "unsupported": the sentence makes specific factual claims that are not covered by lore or archive — possible hallucination but not a clear contradiction.
   - "contradicts": the sentence directly contradicts at least one lore entry or archived event.${hasConcern ? '\n    If a USER CONCERN is provided, weigh it heavily in your verdict, but don\'t ignore other contradictions.' : ''}
2. List up to 3 short issues (each one sentence). Empty list if verdict is "consistent".
3. List the citations you relied on. Use "lore:<exact lore header>" for lore and "scene:<sceneId>" for archive references that appear in the brief. Do NOT invent citations.
4. If verdict is "contradicts" or "unsupported", produce a SUGGESTED REWRITE that:
   - Preserves the GM's tone and approximate length.
   - Replaces ONLY the contradicted/fabricated facts with ones supported by the evidence.
   - Does NOT add new events or commitments.
   - If you cannot produce a confident rewrite from evidence, set suggestedRewrite to null.
5. If verdict is "consistent", set suggestedRewrite to null.`,

        `OUTPUT SCHEMA:
{
  "verdict": "consistent" | "unsupported" | "contradicts",
  "issues": ["..."],
  "citations": [{"ref": "lore:...", "label": "..."}, {"ref": "scene:042", "label": "..."}],
  "suggestedRewrite": "..." | null
}`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `[SENTENCE]\n${args.selectedText}`,
        `[SURROUNDING CONTEXT]\n${args.surroundingContext}`,
        `[LORE EVIDENCE]\n${args.loreText}`,
        `[ARCHIVE EVIDENCE]\n${args.archiveText}`,
        userConcernBlock,
    );
}

function parseVerdict(raw: string, originalText: string): LoreCheckResult {
    const { value: parsed, parseOk } = extractJsonRobust<LoreCheckResult & { verdict?: string; issues?: string[]; citations?: LoreCheckCitation[]; suggestedRewrite?: string | null }>(raw, {
        verdict: 'unsupported',
        issues: ['The verifier returned an unparseable response. See raw output below.'],
        citations: [],
        suggestedRewrite: null,
        originalText,
    });

    if (parseOk && parsed.verdict) {
        const verdictRaw = String(parsed.verdict).toLowerCase();
        const verdict: LoreCheckVerdict =
            verdictRaw === 'contradicts' || verdictRaw === 'unsupported' ? verdictRaw : 'consistent';
        const issues: string[] = Array.isArray(parsed.issues)
            ? parsed.issues.filter((s: unknown): s is string => typeof s === 'string').slice(0, 3)
            : [];
        const citations: LoreCheckCitation[] = Array.isArray(parsed.citations)
            ? parsed.citations
                .map((c: unknown) => {
                    if (typeof c === 'string') return { ref: c, label: c };
                    if (c && typeof c === 'object' && 'ref' in c) {
                        const ref = String((c as { ref: unknown }).ref);
                        const label = 'label' in c ? String((c as { label: unknown }).label) : ref;
                        return { ref, label };
                    }
                    return null;
                })
                .filter((x: LoreCheckCitation | null): x is LoreCheckCitation => x !== null)
            : [];
        const suggestedRewrite =
            typeof parsed.suggestedRewrite === 'string' && parsed.suggestedRewrite.trim().length > 0
                ? parsed.suggestedRewrite
                : null;
        return { verdict, issues, citations, suggestedRewrite, originalText };
    }

    console.warn('[LoreCheck] Verifier returned unparseable response. Raw:\n', raw);
    return {
        verdict: 'unsupported',
        issues: ['The verifier returned an unparseable response. See raw output below.'],
        citations: [],
        suggestedRewrite: null,
        originalText,
        rawResponse: raw,
    };
}