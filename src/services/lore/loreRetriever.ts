import type { LoreChunk, ChatMessage } from '../../types';
import { computeIdf, fuseRRF } from '../retrieval/lexicalFusion';

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

    if (!textByDepth.has(defaultDepth)) {
        getScanText(defaultDepth);
    }

    // ─── IDF computation over corpus ───
    const idf = computeIdf(chunks.map(c => c.triggerKeywords ?? []));

    const chunkById = new Map(chunks.map(c => [c.id, c]));
    const semanticSet = new Set(semanticLoreIds || []);

    // ─── Keyword ranking (IDF-weighted) ───
    const keywordScored: { chunk: LoreChunk; score: number }[] = [];

    for (const chunk of chunks) {
        if (includedSet.has(chunk.id)) continue;

        const modes = chunk.activationModes;
        const isKeywordMode = modes ? modes.includes('keyword') : true;
        const isVectorMode = modes ? modes.includes('vector') : true;

        if (!isKeywordMode && !isVectorMode) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);

        const keywords = chunk.triggerKeywords || [];

        let idfScore = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp('\\b' + escaped + '\\b', 'i');
            if (regex.test(scanText)) {
                idfScore += idf[lower] ?? 1;
            }
        }

        // Vector-only chunks with keyword overlap but no semantic hit get reduced weight
        if (idfScore > 0 && !isKeywordMode) {
            if (!semanticSet.has(chunk.id)) {
                idfScore *= 0.5;
            }
        }

        if (isKeywordMode && idfScore > 0) {
            // Secondary-key AND-gate: if secondaryKeywords exist, at least one must also match
            const secondaryKws = chunk.secondaryKeywords || [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const lower = kw.toLowerCase();
                    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp('\\b' + escaped + '\\b', 'i');
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }

            idfScore += (chunk.priority || 5) * 0.1;
        }

        // Category heuristics (applied when keyword matched, mirroring original logic)
        if (idfScore > 0) {
            if (chunk.category === 'power_system' && (scanText.includes('combat') || scanText.includes('attack') || scanText.includes('damage') || scanText.includes('cast'))) {
                idfScore += 1.5;
            }
            if (chunk.category === 'faction' && (scanText.includes('politics') || scanText.includes('war') || scanText.includes('guild') || scanText.includes('order'))) {
                idfScore += 1.5;
            }
            if (chunk.category === 'economy' && (scanText.includes('buy') || scanText.includes('sell') || scanText.includes('cost') || scanText.includes('gold') || scanText.includes('money'))) {
                idfScore += 1.5;
            }
        }

        if (idfScore > 0) {
            keywordScored.push({ chunk, score: idfScore });
        }
    }

    keywordScored.sort((a, b) => b.score - a.score);
    const keywordRanked = keywordScored.map(s => s.chunk.id);

    // ─── Embedding ranking (already cosine-ranked) ───
    const embeddingRanked = (semanticLoreIds || [])
        .filter(id => {
            const chunk = chunkById.get(id);
            if (!chunk) return false;
            const modes = chunk.activationModes;
            const isVectorMode = modes ? modes.includes('vector') : true;
            return isVectorMode;
        });

    // ─── RRF fusion ───
    const fused = fuseRRF(keywordRanked, embeddingRanked);

    for (const id of fused) {
        const chunk = chunkById.get(id);
        if (!chunk || includedSet.has(chunk.id)) continue;
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