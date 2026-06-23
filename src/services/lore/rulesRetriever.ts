import type { LoreChunk, ChatMessage, RuleChunkMeta } from '../../types';
import { computeIdf, fuseRRF } from '../retrieval/lexicalFusion';

export function retrieveRelevantRules(
    chunks: LoreChunk[],
    chunkMeta: Record<string, RuleChunkMeta> | undefined,
    userMessage: string,
    tokenBudget: number,
    recentMessages?: ChatMessage[],
    semanticRuleIds?: string[]
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const meta = chunkMeta ?? {};
    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    for (const chunk of chunks) {
        const cm = meta[chunk.id];
        const isAlways = cm ? cm.activationModes.includes('always') : chunk.alwaysInclude;
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

    // ─── IDF computation over corpus ───
    const idf = computeIdf(chunks.map(c => (meta[c.id]?.triggerKeywords ?? c.triggerKeywords ?? [])));

    const chunkById = new Map(chunks.map(c => [c.id, c]));
    const semanticSet = new Set(semanticRuleIds || []);

    // ─── Keyword ranking (IDF-weighted) ───
    const keywordScored: { chunk: LoreChunk; score: number }[] = [];

    for (const chunk of chunks) {
        if (includedSet.has(chunk.id)) continue;

        const cm = meta[chunk.id];
        const modes = cm ? cm.activationModes : ['vector', 'keyword'];
        const isKeywordMode = modes.includes('keyword');
        const isVectorMode = modes.includes('vector');

        if (!isKeywordMode && !isVectorMode) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);
        const keywords = cm?.triggerKeywords ?? chunk.triggerKeywords ?? [];

        let idfScore = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp('\\b' + escaped + '\\b', 'i');
            if (regex.test(scanText)) {
                idfScore += idf[lower] ?? 1;
            }
        }

        if (isKeywordMode && idfScore > 0) {
            const secondaryKws = cm?.secondaryKeywords ?? chunk.secondaryKeywords ?? [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const lower = kw.toLowerCase();
                    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp('\\b' + escaped + '\\b', 'i');
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }

            idfScore += (cm?.priority ?? chunk.priority ?? 5) * 0.1;
        }

        if (!isKeywordMode && idfScore > 0) {
            if (!semanticSet.has(chunk.id)) {
                idfScore *= 0.5;
            }
        }

        if (idfScore > 0) {
            keywordScored.push({ chunk, score: idfScore });
        }
    }

    keywordScored.sort((a, b) => b.score - a.score);
    const keywordRanked = keywordScored.map(s => s.chunk.id);

    // ─── Embedding ranking (already cosine-ranked) ───
    const embeddingRanked = (semanticRuleIds || []).filter(id => {
        const chunk = chunkById.get(id);
        if (!chunk) return false;
        const cm = meta[chunk.id];
        const modes = cm ? cm.activationModes : ['vector', 'keyword'];
        return modes.includes('vector');
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

    return results;
}