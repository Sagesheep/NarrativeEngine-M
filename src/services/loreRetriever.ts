import type { LoreChunk } from '../types';

/**
 * Extract proper nouns and key terms from Canon State + Header Index.
 * Returns lowercase tokens for matching.
 */
function extractKeywords(canonState: string, headerIndex: string): Set<string> {
    const keywords = new Set<string>();
    const combined = canonState + '\n' + headerIndex;

    // Extract values after known field labels
    const fieldPatterns = [
        /LOCATION:\s*(.+)/gi,
        /ATMOSPHERE:\s*(.+)/gi,
        /NARRATIVE_MODE:\s*(.+)/gi,
        /THREAD_TAG[:\s]*\[?(.+?)\]?$/gim,
        /ACTIVE_THREADS:\s*-\s*\[(.+?)\]/gi,
        /SCENE_ID:\s*(\S+)/gi,
        /SESSION_TITLE:\s*(.+)/gi,
    ];

    for (const pattern of fieldPatterns) {
        let match;
        while ((match = pattern.exec(combined)) !== null) {
            // Split comma-separated values and clean
            match[1].split(/[,;/]/).forEach((part) => {
                const clean = part.trim().toLowerCase().replace(/[\[\]()]/g, '');
                if (clean.length > 2) keywords.add(clean);
            });
        }
    }

    // Extract NPC names from "- Name:" or "Name (alignment)" patterns
    const npcPatterns = [
        /^[-•]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/gm,
        /NPC.*?:\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/gi,
    ];

    for (const pattern of npcPatterns) {
        let match;
        while ((match = pattern.exec(combined)) !== null) {
            const name = match[1].trim().toLowerCase();
            if (name.length > 2) keywords.add(name);
        }
    }

    // Extract capitalized proper nouns (2+ chars, appear with context)
    const properNouns = combined.match(/[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*/g);
    if (properNouns) {
        for (const noun of properNouns) {
            keywords.add(noun.toLowerCase());
        }
    }

    return keywords;
}

/**
 * Score a lore chunk against extracted keywords.
 * Higher score = more relevant.
 */
function scoreChunk(chunk: LoreChunk, keywords: Set<string>): number {
    const searchText = (chunk.header + ' ' + chunk.content).toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
        if (searchText.includes(keyword)) {
            // Header match is worth more
            if (chunk.header.toLowerCase().includes(keyword)) {
                score += 3;
            } else {
                score += 1;
            }
        }
    }

    return score;
}

/**
 * Retrieve relevant lore chunks based on Canon State + Header Index keywords.
 * Returns: all alwaysInclude chunks + keyword-matched chunks, sorted by relevance.
 */
export function retrieveRelevantLore(
    chunks: LoreChunk[],
    canonState: string,
    headerIndex: string,
    tokenBudget = 3000
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const keywords = extractKeywords(canonState, headerIndex);
    const results: LoreChunk[] = [];
    let usedTokens = 0;

    // Always include flagged chunks first
    const alwaysOn = chunks.filter((c) => c.alwaysInclude);
    for (const chunk of alwaysOn) {
        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    // Score and sort remaining chunks
    const dynamic = chunks
        .filter((c) => !c.alwaysInclude)
        .map((c) => ({ chunk: c, score: scoreChunk(c, keywords) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

    // Fill remaining budget
    for (const { chunk } of dynamic) {
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    return results;
}
