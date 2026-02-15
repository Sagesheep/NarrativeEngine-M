import type { LoreChunk } from '../types';

const ALWAYS_INCLUDE_KEYWORDS = [
    'economy', 'currency', 'gold', 'income', 'cost', 'price', 'reward',
    'power level', 'rank', 'f rank', 'e rank', 'd rank', 'c rank', 'b rank', 'a rank', 's rank',
];

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function shouldAlwaysInclude(header: string, content: string): boolean {
    const combined = (header + ' ' + content).toLowerCase();
    return ALWAYS_INCLUDE_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Splits a markdown lore file into chunks by ### headers.
 * Falls back to ## if no ### found.
 * Each chunk = { id, header, content, tokens, alwaysInclude }
 */
export function chunkLoreFile(markdown: string): LoreChunk[] {
    const lines = markdown.split(/\r?\n/);
    const chunks: LoreChunk[] = [];

    // Detect granularity: use ### if present, else ##
    const hasH3 = lines.some((l) => /^###\s/.test(l));
    const headerRegex = hasH3 ? /^###\s+(.+)/ : /^##\s+(.+)/;

    let currentHeader = '';
    let currentLines: string[] = [];
    let preambleLines: string[] = [];

    for (const line of lines) {
        const match = line.match(headerRegex);
        if (match) {
            // Save previous chunk
            if (currentHeader) {
                const content = currentLines.join('\n').trim();
                if (content) {
                    chunks.push({
                        id: slugify(currentHeader),
                        header: currentHeader,
                        content,
                        tokens: estimateTokens(currentHeader + '\n' + content),
                        alwaysInclude: shouldAlwaysInclude(currentHeader, content),
                    });
                }
            } else if (currentLines.length > 0) {
                // Text before first header = preamble
                preambleLines = [...currentLines];
            }
            currentHeader = match[1].trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }

    // Don't forget last chunk
    if (currentHeader) {
        const content = currentLines.join('\n').trim();
        if (content) {
            chunks.push({
                id: slugify(currentHeader),
                header: currentHeader,
                content,
                tokens: estimateTokens(currentHeader + '\n' + content),
                alwaysInclude: shouldAlwaysInclude(currentHeader, content),
            });
        }
    }

    // If preamble has substantial content, add as first chunk
    const preamble = preambleLines.join('\n').trim();
    if (preamble && estimateTokens(preamble) > 20) {
        chunks.unshift({
            id: 'preamble',
            header: 'World Overview',
            content: preamble,
            tokens: estimateTokens('World Overview\n' + preamble),
            alwaysInclude: true,
        });
    }

    return chunks;
}
