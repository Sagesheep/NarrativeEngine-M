import type { LoreChunk, LLMProvider } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    JSON_ONLY_FOOTER,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    joinPromptSections,
} from '../infrastructure';

const BATCH_SIZE = 8;
const CONTENT_PREVIEW_CHARS = 300;
const FINAL_KEYWORD_CAP = 25;
const ENRICHER_VERSION = 2;

const LORE_ENRICHER_STATIC = joinPromptSections(
    'You are generating trigger keywords for a tabletop RPG lore retrieval system.',

    `For each lore entry below, return TWO keyword sets:
- "primary": 10-15 distinctive, high-precision trigger words that uniquely identify this entry. Include entity names, aliases, multi-word proper nouns, rare/specific nouns. AVOID generic verbs and common role words such as: visit, ask, go, members, join, order, fight, hire, travel, meet, find, talk — these cause false triggers on unrelated text.
- "secondary": 5-10 contextual disambiguator words that, when present alongside a primary keyword, confirm this chunk is genuinely on-topic.

Format: {"chunk-id": {"primary": ["kw1", "kw2", ...], "secondary": ["kw1", ...]}, ...}`,

    JSON_ONLY_FOOTER,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
);

function buildBatchPrompt(batch: LoreChunk[]): string {
    const entries = batch.map(c => {
        const preview = c.content.slice(0, CONTENT_PREVIEW_CHARS).replace(/\n+/g, ' ').trim();
        return `---\nID: ${c.id}\nHEADER: ${c.header}\nCONTENT: ${preview}`;
    }).join('\n');

    return `${LORE_ENRICHER_STATIC}\n\nLORE ENTRIES:\n${entries}\n---`;
}

function parseEnrichmentResponse(raw: string): Record<string, { primary: string[]; secondary: string[] }> {
    let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];

    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in enrichment response');

    const parsed = JSON.parse(clean.substring(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Enrichment response is not an object');

    const result: Record<string, { primary: string[]; secondary: string[] }> = {};
    for (const [id, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) {
            // Old flat-array shape — treat as primary only
            result[id] = { primary: value as string[], secondary: [] };
        } else if (typeof value === 'object' && value !== null) {
            const v = value as Record<string, unknown>;
            const primary = Array.isArray(v.primary) ? (v.primary as string[]) : [];
            const secondary = Array.isArray(v.secondary) ? (v.secondary as string[]) : [];
            result[id] = { primary, secondary };
        }
    }
    return result;
}

function capKeywords(keywords: string[]): string[] {
    const deduped = new Set<string>();
    for (const kw of keywords) {
        const lower = kw.toLowerCase().trim();
        if (lower.length > 1) deduped.add(lower);
    }
    return Array.from(deduped).slice(0, FINAL_KEYWORD_CAP);
}

export async function enrichLoreKeywords(
    campaignId: string,
    chunks: LoreChunk[],
    utilityEndpoint: LLMProvider,
    saveLoreChunks: (campaignId: string, chunks: LoreChunk[]) => Promise<void>,
): Promise<void> {
    const toEnrich = chunks.filter(c => !c.alwaysInclude && (c.enrichedVersion ?? 0) < ENRICHER_VERSION);

    if (toEnrich.length === 0) {
        console.log('[LoreEnricher] All chunks already enriched, skipping.');
        return;
    }

    console.log(`[LoreEnricher] Enriching ${toEnrich.length} chunks in batches of ${BATCH_SIZE}...`);

    const batches: LoreChunk[][] = [];
    for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
        batches.push(toEnrich.slice(i, i + BATCH_SIZE));
    }

    const enrichedMap = new Map<string, { primary: string[]; secondary: string[] }>();

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        try {
            const prompt = buildBatchPrompt(batch);
            const raw = await llmCall(utilityEndpoint, prompt, {
                temperature: 0.1,
                priority: 'normal',
                maxTokens: 1400,
            });
            const result = parseEnrichmentResponse(raw);

            for (const chunk of batch) {
                const entry = result[chunk.id];
                if (entry && Array.isArray(entry.primary) && entry.primary.length > 0) {
                    enrichedMap.set(chunk.id, entry);
                }
            }

            console.log(`[LoreEnricher] Batch ${i + 1}/${batches.length} complete — enriched ${Object.keys(result).length} chunks`);
        } catch (err) {
            console.warn(`[LoreEnricher] Batch ${i + 1}/${batches.length} failed, skipping:`, err);
        }
    }

    // Apply enriched keywords back to the full chunks array
    let enrichedCount = 0;
    for (const chunk of chunks) {
        const entry = enrichedMap.get(chunk.id);
        if (entry) {
            // REPLACE triggerKeywords with LLM primary set (do not merge stale old keywords)
            chunk.triggerKeywords = capKeywords(entry.primary);
            chunk.secondaryKeywords = capKeywords(entry.secondary);
            chunk.keywordsEnriched = true;
            chunk.enrichedVersion = ENRICHER_VERSION;
            enrichedCount++;
        }
    }

    if (enrichedCount > 0) {
        await saveLoreChunks(campaignId, chunks);
        console.log(`[LoreEnricher] Saved ${enrichedCount} enriched chunks for campaign ${campaignId}`);
    }
}
