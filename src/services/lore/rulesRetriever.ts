import type { LoreChunk, ChatMessage, RuleChunkMeta } from '../../types';

function stripChunkPrefix(header: string): string {
    return header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
}

export function retrieveRelevantRules(
    chunks: LoreChunk[],
    chunkMeta: Record<string, RuleChunkMeta> | undefined,
    userMessage: string,
    tokenBudget: number,
    recentMessages?: ChatMessage[],
    semanticRuleIds?: string[]
): { selected: LoreChunk[]; manifest: string } {
    if (chunks.length === 0) return { selected: [], manifest: '' };

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

    const scored: { chunk: LoreChunk; score: number }[] = [];
    const semanticSet = new Set(semanticRuleIds || []);

    for (const chunk of chunks) {
        if (includedSet.has(chunk.id)) continue;

        const cm = meta[chunk.id];
        const modes = cm ? cm.activationModes : ['vector'];
        const isKeywordMode = modes.includes('keyword');
        const isVectorMode = modes.includes('vector');

        if (!isKeywordMode && !isVectorMode) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);
        const keywords = cm?.triggerKeywords ?? chunk.triggerKeywords ?? [];

        let matchCount = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(scanText)) matchCount++;
        }

        let score = 0;
        let keywordMatched = false;

        if (isKeywordMode && matchCount > 0) {
            const secondaryKws = cm?.secondaryKeywords ?? chunk.secondaryKeywords ?? [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const lower = kw.toLowerCase();
                    const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }

            score += matchCount * 10;
            score += (cm?.priority ?? chunk.priority ?? 5);
            keywordMatched = true;
        }

        if (isVectorMode) {
            const isSemanticHit = semanticSet.has(chunk.id);
            if (isSemanticHit) {
                score += 25 + (cm?.priority ?? chunk.priority ?? 5);
                if (keywordMatched) score += 20;
            } else if (matchCount > 0 && !isKeywordMode) {
                score += matchCount * 10;
                score += (cm?.priority ?? chunk.priority ?? 5);
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

    const unretrievedHeaders = chunks
        .filter(c => !includedSet.has(c.id))
        .map(c => `## ${stripChunkPrefix(c.header)}`)
        .join('\n');
    const manifest = unretrievedHeaders.length > 0
        ? `[Available rule sections not loaded this turn]\n${unretrievedHeaders}\n[End section list]`
        : '';

    return { selected: results, manifest };
}