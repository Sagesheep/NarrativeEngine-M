import type { LoreChunk, LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';
import { saveLoreChunks } from '../store/campaignStore';

const BATCH_SIZE = 8;
const CONTENT_PREVIEW_CHARS = 300;
const FINAL_KEYWORD_CAP = 25;

function buildBatchPrompt(batch: LoreChunk[]): string {
    const entries = batch.map(c => {
        const preview = c.content.slice(0, CONTENT_PREVIEW_CHARS).replace(/\n+/g, ' ').trim();
        return `---\nID: ${c.id}\nHEADER: ${c.header}\nCONTENT: ${preview}`;
    }).join('\n');

    return `You are generating trigger keywords for a tabletop RPG lore retrieval system.
For each lore entry below, return 12-15 semantic trigger keywords that a player might naturally say to invoke this entry.
Include: roles (thief, guard, merchant), synonyms (steal/heist/pilfer), related concepts (faction → join/ally/betray/members), actions (hire, fight, visit, ask about), and entity names/aliases.
Do NOT include stop words, generic adjectives, or the entry id itself.
Return ONLY a JSON object mapping each entry id to its keyword array. No prose, no markdown.
Format: {"chunk-id": ["kw1", "kw2", ...], ...}

LORE ENTRIES:
${entries}
---

Respond with the JSON object now:`;
}

function parseEnrichmentResponse(raw: string): Record<string, string[]> {
    let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];

    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON object found in enrichment response');

    const parsed = JSON.parse(clean.substring(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Enrichment response is not an object');
    return parsed as Record<string, string[]>;
}

function mergeKeywords(llmKeywords: string[], existing: string[]): string[] {
    const merged = new Set<string>();
    for (const kw of [...llmKeywords, ...existing]) {
        const lower = kw.toLowerCase().trim();
        if (lower.length > 1) merged.add(lower);
    }
    return Array.from(merged).slice(0, FINAL_KEYWORD_CAP);
}

export async function enrichLoreKeywords(
    campaignId: string,
    chunks: LoreChunk[],
    utilityEndpoint: LLMProvider
): Promise<void> {
    const toEnrich = chunks.filter(c => !c.alwaysInclude && !c.keywordsEnriched);

    if (toEnrich.length === 0) {
        console.log('[LoreEnricher] All chunks already enriched, skipping.');
        return;
    }

    console.log(`[LoreEnricher] Enriching ${toEnrich.length} chunks in batches of ${BATCH_SIZE}...`);

    const batches: LoreChunk[][] = [];
    for (let i = 0; i < toEnrich.length; i += BATCH_SIZE) {
        batches.push(toEnrich.slice(i, i + BATCH_SIZE));
    }

    const enrichedMap = new Map<string, string[]>();

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        try {
            const prompt = buildBatchPrompt(batch);
            const raw = await llmCall(utilityEndpoint, prompt, {
                temperature: 0.1,
                priority: 'normal',
                maxTokens: 700,
            });
            const result = parseEnrichmentResponse(raw);

            for (const chunk of batch) {
                const llmKeywords = result[chunk.id];
                if (Array.isArray(llmKeywords) && llmKeywords.length > 0) {
                    enrichedMap.set(chunk.id, mergeKeywords(llmKeywords, chunk.triggerKeywords));
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
        const kws = enrichedMap.get(chunk.id);
        if (kws) {
            chunk.triggerKeywords = kws;
            chunk.keywordsEnriched = true;
            enrichedCount++;
        }
    }

    if (enrichedCount > 0) {
        await saveLoreChunks(campaignId, chunks);
        console.log(`[LoreEnricher] Saved ${enrichedCount} enriched chunks for campaign ${campaignId}`);
    }
}
