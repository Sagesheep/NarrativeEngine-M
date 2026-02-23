import type { LoreChunk, ChatMessage } from '../types';

/**
 * Keyword-based World Info retrieval.
 * Scans the last N messages (per chunk's scanDepth) for exact keyword matches.
 * Only injects chunks whose trigger keywords appear in recent conversation.
 * alwaysInclude chunks bypass keyword matching entirely.
 * Enforces a token budget — ranked by keyword hit count, most relevant first.
 */
export function retrieveRelevantLore(
    chunks: LoreChunk[],
    _canonState: string,
    _headerIndex: string,
    userMessage: string,
    tokenBudget = 1200,
    recentMessages?: ChatMessage[]
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const results: LoreChunk[] = [];
    let usedTokens = 0;

    // Always-include chunks get priority (deducted from budget)
    for (const chunk of chunks) {
        if (chunk.alwaysInclude) {
            results.push(chunk);
            usedTokens += chunk.tokens;
        }
    }

    // Build text corpus from recent messages for keyword scanning
    const history = recentMessages || [];
    const defaultDepth = 2;

    // Precompute text at each depth level for efficient scanning
    const textByDepth = new Map<number, string>();
    for (const chunk of chunks) {
        if (chunk.alwaysInclude) continue;
        const depth = chunk.scanDepth || defaultDepth;
        if (!textByDepth.has(depth)) {
            const sliceForDepth = history.length > depth ? history.slice(-depth) : history;
            const text = sliceForDepth.map(m => (m.content || '').toLowerCase()).join(' ')
                + ' ' + userMessage.toLowerCase();
            textByDepth.set(depth, text);
        }
    }

    // Ensure default depth scan exists
    if (!textByDepth.has(defaultDepth)) {
        const slice = history.length > defaultDepth ? history.slice(-defaultDepth) : history;
        textByDepth.set(defaultDepth, slice.map(m => (m.content || '').toLowerCase()).join(' ')
            + ' ' + userMessage.toLowerCase());
    }

    // Score chunks by how many keywords matched (relevance ranking)
    const scored: { chunk: LoreChunk; matchCount: number }[] = [];

    for (const chunk of chunks) {
        if (chunk.alwaysInclude) continue;

        const keywords = chunk.triggerKeywords || [];
        if (keywords.length === 0) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = textByDepth.get(depth) || userMessage.toLowerCase();

        let matchCount = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(scanText)) matchCount++;
        }

        if (matchCount > 0) {
            scored.push({ chunk, matchCount });
        }
    }

    // Sort by relevance (most keyword hits first)
    scored.sort((a, b) => b.matchCount - a.matchCount);

    // Fill to budget
    for (const { chunk } of scored) {
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    console.log(`[Lore Retriever] Injected ${results.length} chunks (${usedTokens}/${tokenBudget} tokens). Dropped ${scored.length - (results.length - results.filter(r => r.alwaysInclude).length)} low-priority chunks.`);

    return results;
}

/**
 * Search lore chunks based on an explicit query string (from LLM tool call).
 * Uses keyword scoring against the query. Enforces max 3 results or 1500 tokens.
 */
export function searchLoreByQuery(
    chunks: LoreChunk[],
    query: string,
    tokenBudget = 1500,
    maxResults = 3
): LoreChunk[] {
    if (chunks.length === 0 || !query.trim()) return [];

    const stopWords = new Set(['about', 'retrieve', 'information', 'please', 'tell', 'what', 'where', 'when', 'who', 'how', 'why', 'there', 'their', 'they', 'this', 'that', 'from', 'with', 'the', 'and', 'for']);
    const queryKeywords = new Set<string>();

    const words = query.toLowerCase().split(/\s+/);
    for (const w of words) {
        const clean = w.replace(/[^a-z0-9]/g, '');
        if (clean.length > 2 && !stopWords.has(clean)) {
            queryKeywords.add(clean);
        }
    }

    // Score chunks by how many query keywords match their content + triggerKeywords
    const scored = chunks
        .map((chunk) => {
            const searchText = (chunk.header + ' ' + chunk.content).toLowerCase();
            const triggerSet = new Set((chunk.triggerKeywords || []).map(k => k.toLowerCase()));
            let score = 0;

            for (const kw of queryKeywords) {
                if (triggerSet.has(kw)) score += 3;        // trigger keyword match = high
                else if (chunk.header.toLowerCase().includes(kw)) score += 2;  // header match
                else if (searchText.includes(kw)) score += 1;                  // content match
            }
            return { chunk, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

    const results: LoreChunk[] = [];
    let usedTokens = 0;

    for (const { chunk } of scored) {
        if (results.length >= maxResults) break;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    return results;
}
