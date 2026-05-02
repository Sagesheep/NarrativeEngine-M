import type {
    LLMProvider,
    LoreChunk,
    ArchiveIndexEntry,
    ArchiveChapter,
    ChatMessage,
    LoreCheckResult,
    LoreCheckCitation,
    LoreCheckVerdict,
} from '../types';
import { llmCall } from '../utils/llmCall';
import { searchLoreByQuery } from './loreRetriever';
import { deepArchiveScan } from './deepArchiveSearch';

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
    onStatus: (msg: string) => void;
    signal?: AbortSignal;
};

export async function runLoreCheck(input: LoreCheckInput): Promise<LoreCheckResult> {
    const {
        utilityEndpoint, selectedText, surroundingContext,
        messages, targetMessageId, loreChunks,
        archiveIndex, sealedChapters, campaignId,
        onStatus, signal,
    } = input;

    onStatus('Searching lore...');
    const loreHits = searchLoreByQuery(loreChunks, selectedText, 1500, 5);

    onStatus('Scanning archive...');
    const targetIdx = messages.findIndex(m => m.id === targetMessageId);
    const contextSlice = targetIdx >= 0
        ? messages.slice(Math.max(0, targetIdx - 3), targetIdx + 1)
        : messages.slice(-4);

    let archiveBrief = '';
    if (sealedChapters.length > 0 && archiveIndex.length > 0) {
        try {
            archiveBrief = await deepArchiveScan(
                utilityEndpoint,
                archiveIndex,
                sealedChapters,
                campaignId,
                contextSlice,
                selectedText,
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
    });

    const raw = await llmCall(utilityEndpoint, prompt, {
        temperature: 0.1,
        maxTokens: 800,
        priority: 'high',
        signal,
    });

    return parseVerdict(raw, selectedText);
}

function buildVerifierPrompt(args: {
    selectedText: string;
    surroundingContext: string;
    loreText: string;
    archiveText: string;
}): string {
    return `You are a narrative continuity auditor for a tabletop RPG campaign.
A player has highlighted a sentence written by the GM and wants to know whether it is consistent with established lore and play history.

You will receive:
- The highlighted SENTENCE
- The surrounding CONTEXT (sentence before and after, for tone reference only)
- LORE evidence (canonical world facts written by the player)
- ARCHIVE evidence (a brief summarizing past scenes from the campaign)

Your job:
1. Decide a verdict:
   - "consistent": the sentence is supported (or at least not contradicted) by the evidence.
   - "unsupported": the sentence makes specific factual claims that are not covered by lore or archive — possible hallucination but not a clear contradiction.
   - "contradicts": the sentence directly contradicts at least one lore entry or archived event.
2. List up to 3 short issues (each one sentence). Empty list if verdict is "consistent".
3. List the citations you relied on. Use "lore:<exact lore header>" for lore and "scene:<sceneId>" for archive references that appear in the brief. Do NOT invent citations.
4. If verdict is "contradicts" or "unsupported", produce a SUGGESTED REWRITE that:
   - Preserves the GM's tone and approximate length.
   - Replaces ONLY the contradicted/fabricated facts with ones supported by the evidence.
   - Does NOT add new events or commitments.
   - If you cannot produce a confident rewrite from evidence, set suggestedRewrite to null.
5. If verdict is "consistent", set suggestedRewrite to null.

Respond with ONLY a single JSON object, no prose, no code fence:
{
  "verdict": "consistent" | "unsupported" | "contradicts",
  "issues": ["..."],
  "citations": [{"ref": "lore:...", "label": "..."}, {"ref": "scene:042", "label": "..."}],
  "suggestedRewrite": "..." | null
}

[SENTENCE]
${args.selectedText}

[SURROUNDING CONTEXT]
${args.surroundingContext}

[LORE EVIDENCE]
${args.loreText}

[ARCHIVE EVIDENCE]
${args.archiveText}
`;
}

function parseVerdict(raw: string, originalText: string): LoreCheckResult {
    let clean = raw.replace(/<think[\s\S]*?<\/think>/gi, '');
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) clean = fence[1];
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
        return fallback();
    }
    try {
        const parsed = JSON.parse(clean.substring(start, end + 1));
        const verdictRaw = String(parsed.verdict ?? '').toLowerCase();
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
    } catch {
        return fallback();
    }

    function fallback(): LoreCheckResult {
        return {
            verdict: 'unsupported',
            issues: ['The verifier returned an unparseable response.'],
            citations: [],
            suggestedRewrite: null,
            originalText,
        };
    }
}
