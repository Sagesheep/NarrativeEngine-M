import type { LoreChunk, ChatMessage } from '../../types';

export function retrieveRelevantLore(
    chunks: LoreChunk[],
    userMessage: string,
    tokenBudget = 1200,
    recentMessages?: ChatMessage[],
    semanticLoreIds?: string[]
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    // Always-include: chunks with 'always' activation mode or legacy alwaysInclude flag
    for (const chunk of chunks) {
        const modes = chunk.activationModes;
        const isAlways = modes
            ? modes.includes('always')
            : chunk.alwaysInclude;
        if (isAlways) {
            results.push(chunk);
            includedSet.add(chunk.id);
            usedTokens += chunk.tokens;
        }
    }

    const history = recentMessages || [];
    const defaultDepth = 2;

    const textByDepth = new Map<number, string>();
    const getScanText = (depth: number) => {
        if (!textByDepth.has(depth)) {
            const slice = history.length > depth ? history.slice(-depth) : history;
            const text = slice.map(m => (m.content || '').toLowerCase()).join(' ')
                + ' ' + userMessage.toLowerCase();
            textByDepth.set(depth, text);
        }
        return textByDepth.get(depth)!;
    };

    // Ensure default depth text is computed
    if (!textByDepth.has(defaultDepth)) {
        getScanText(defaultDepth);
    }

    const scored: { chunk: LoreChunk; score: number }[] = [];
    const semanticSet = new Set(semanticLoreIds || []);

    for (const chunk of chunks) {
        if (includedSet.has(chunk.id)) continue;

        const modes = chunk.activationModes;
        // Back-compat: undefined = legacy hybrid behavior (vector + keyword + alwaysInclude)
        const isKeywordMode = modes ? modes.includes('keyword') : true;
        const isVectorMode = modes ? modes.includes('vector') : true;

        if (!isKeywordMode && !isVectorMode) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);

        const keywords = chunk.triggerKeywords || [];

        let matchCount = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(scanText)) matchCount++;
        }

        const isSemanticHit = semanticSet.has(chunk.id);

        let score = 0;
        let keywordMatched = false;

        if (isKeywordMode && matchCount > 0) {
            // Secondary-key AND-gate: if secondaryKeywords exist, at least one must also match
            const secondaryKws = chunk.secondaryKeywords || [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const lower = kw.toLowerCase();
                    const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }

            score += matchCount * 10;
            score += (chunk.priority || 5);
            keywordMatched = true;
        }

        if (isVectorMode) {
            if (isSemanticHit) {
                score += 25 + (chunk.priority || 5);
                if (keywordMatched) score += 20;
            } else if (matchCount > 0 && !isKeywordMode) {
                // Vector-only chunk with keyword overlap but no semantic hit still gets a small score
                score += matchCount * 10;
                score += (chunk.priority || 5);
            }
        }

        // Category heuristics (applied when keyword matched, mirroring original logic)
        if (keywordMatched || (modes === undefined && matchCount > 0)) {
            if (chunk.category === 'power_system' && (scanText.includes('combat') || scanText.includes('attack') || scanText.includes('damage') || scanText.includes('cast'))) {
                score += 15;
            }
            if (chunk.category === 'faction' && (scanText.includes('politics') || scanText.includes('war') || scanText.includes('guild') || scanText.includes('order'))) {
                score += 15;
            }
            if (chunk.category === 'economy' && (scanText.includes('buy') || scanText.includes('sell') || scanText.includes('cost') || scanText.includes('gold') || scanText.includes('money'))) {
                score += 15;
            }
        }

        if (score > 0) {
            scored.push({ chunk, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    for (const { chunk } of scored) {
        if (includedSet.has(chunk.id)) continue;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        includedSet.add(chunk.id);
        usedTokens += chunk.tokens;
    }

    // Pass 2: Linked entities cross-pull
    if (usedTokens < tokenBudget) {
        const linkedNames = new Set<string>();
        for (const chunk of results) {
            (chunk.linkedEntities || []).forEach(e => linkedNames.add(e.toLowerCase()));
        }

        if (linkedNames.size > 0) {
            const remaining = chunks.filter(c => !includedSet.has(c.id)).sort((a, b) => (b.priority || 5) - (a.priority || 5));
            for (const chunk of remaining) {
                const headerLower = chunk.header.toLowerCase();
                const isLinked = Array.from(linkedNames).some(name => headerLower.includes(name));
                if (isLinked && usedTokens + chunk.tokens <= tokenBudget) {
                    results.push(chunk);
                    includedSet.add(chunk.id);
                    usedTokens += chunk.tokens;
                }
            }
        }
    }

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

    const scored = chunks
        .map((chunk) => {
            const searchText = (chunk.header + ' ' + chunk.content).toLowerCase();
            const triggerSet = new Set((chunk.triggerKeywords || []).map(k => k.toLowerCase()));
            let score = 0;

            for (const kw of queryKeywords) {
                if (triggerSet.has(kw)) score += 3;
                else if (chunk.header.toLowerCase().includes(kw)) score += 2;
                else if (searchText.includes(kw)) score += 1;
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