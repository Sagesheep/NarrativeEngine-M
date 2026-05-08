import type { NPCEntry, LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';
import { extractJson } from './payloadBuilder';
import TITLES from '../data/titles.json';

// Load titles into a Set once
const TITLES_SET = new Set(TITLES.map(t => t.toLowerCase()));

/** Extract NPC names from assistant response text using bracket/system tag patterns and prose extraction */
export function extractNPCNames(content: string, excludeNames: string[] = []): string[] {
    const extractedNames: string[] = [];
    const excludeSet = new Set(excludeNames.map(n => n.toLowerCase()));

    // Pattern to exclude generic roles like "Guard A" or "Clone 1", and creature types
    const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature|clone|drone|knight|priest|mage|wizard|archer|thief)\s+([a-z0-9]|#\d+)$/i;
    const NPC_NAME_BLOCKLIST = new Set(["you", "i", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "about", "like", "through", "over", "before", "between", "after", "since", "without", "under", "within", "along", "following", "across", "behind", "beyond", "plus", "except", "up", "out", "around", "down", "off", "above", "near", "she", "he", "it", "they", "them", "then", "suddenly", "meanwhile", "however", "although", "therefore", "otherwise", "inside", "outside", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);

    // Pattern 1 & 2: [Name] or [**Name**] — no colons allowed inside (filters out [SYSTEM: ...])
    const bracketMatches = Array.from(content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g));
    for (const m of bracketMatches) {
        const raw = m[1].trim();
        if (!isValidCandidate(raw, excludeSet, GENERIC_ROLE_PATTERN, NPC_NAME_BLOCKLIST)) continue;
        extractedNames.push(stripTitle(raw));
    }

    // Pattern 3: [SYSTEM: NPC_ENTRY - NAME]
    const entryMatches = Array.from(content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi));
    for (const m of entryMatches) {
        const raw = m[1].trim();
        if (!isValidCandidate(raw, excludeSet, GENERIC_ROLE_PATTERN, NPC_NAME_BLOCKLIST)) continue;
        extractedNames.push(stripTitle(raw));
    }

    // Pattern 4: Prose extraction — capitalized proper nouns
    // Matches names like "Orin", "Captain Aldric", "Aldric of Westhold", "Lady Elara"
    // Char class includes straight (') and curly (’) apostrophes for typographic safety
    const PROSE_NAME = /\b([A-Z][a-z'’-]+(?:\s+(?:of|the|von|de|di|al|el|ibn|bin)\s+[A-Z][a-z'’-]+|\s+[A-Z][a-z'’-]+){0,3})\b/g;
    const proseMatches = Array.from(content.matchAll(PROSE_NAME));

    for (const m of proseMatches) {
        const raw = m[1].trim();

        // Strip title first, then validate the result
        const stripped = stripTitle(raw);
        if (stripped.length === 0) continue;

        if (!isValidCandidate(stripped, excludeSet, GENERIC_ROLE_PATTERN, NPC_NAME_BLOCKLIST)) continue;

        extractedNames.push(stripped);
    }

    return extractedNames;
}

/** Check if a candidate is valid before adding */
function isValidCandidate(raw: string, excludeSet: Set<string>, genericPattern: RegExp, blocklist: Set<string>): boolean {
    if (raw.length < 2) return false;
    if (raw.includes(' ') && raw === raw.toUpperCase()) return false;
    if (blocklist.has(raw.toLowerCase())) return false;
    if (genericPattern.test(raw)) return false;
    if (excludeSet.has(raw.toLowerCase())) return false;
    return true;
}

/** Strip leading title/honorific from a name. "Captain Aldric" → "Aldric", "Lady Elara of Mire" → "Elara of Mire" */
function stripTitle(raw: string): string {
    const parts = raw.split(/\s+/);
    if (parts.length === 0) return raw;

    const firstLower = parts[0].toLowerCase();
    if (TITLES_SET.has(firstLower)) {
        const remainder = parts.slice(1).join(' ').trim();
        return remainder.length > 0 ? remainder : '';
    }

    return raw;
}

/** Filter extracted names against existing ledger, return { newNames, existingNpcs } */
export function classifyNPCNames(
    names: string[],
    ledger: NPCEntry[],
    excludeNames: string[] = []
): { newNames: string[]; existingNpcs: NPCEntry[] } {
    const excludeSet = new Set(excludeNames.map(n => n.toLowerCase()));

    // Normalize: title-case all-caps single words (e.g., ORIN -> Orin)
    const normalized = names.map(n =>
        n === n.toUpperCase() && n.length > 1 ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : n
    );
    const uniqueNames = Array.from(new Set(normalized)).filter(n => !excludeSet.has(n.toLowerCase()));

    const newNames: string[] = [];
    const existingNpcs: NPCEntry[] = [];

    for (const potentialName of uniqueNames) {
        // Check if already in ledger (case-insensitive against name + aliases)
        const existingNpc = ledger.find(npc => {
            if (!npc.name) return false;
            const aliasesRaw = npc.aliases || '';
            const allNames = [npc.name, ...aliasesRaw.split(',').map(a => a.trim())].filter(Boolean);
            const search = potentialName.toLowerCase();
            return allNames.some(n => {
                const lower = n.toLowerCase();
                return lower === search || lower.startsWith(search + ' ') || lower.endsWith(' ' + search);
            });
        });

        if (!existingNpc) {
            newNames.push(potentialName);
        } else {
            existingNpcs.push(existingNpc);
        }
    }

    return { newNames, existingNpcs };
}

/** 
 * LLM validation pass to filter out non-name false positives (e.g. skills, mechanics). 
 * Falls back to original candidates on API error.
 */
export async function validateNPCCandidates(
    provider: LLMProvider,
    candidates: string[],
    narrativeContext: string
): Promise<string[]> {
    if (candidates.length === 0) return candidates;

    console.log(`[NPC Validator] Validating ${candidates.length} candidates against LLM semantic filter...`);

    const shortContext = narrativeContext.slice(-1000); // Keep it cheap

    const prompt = `You are a strict data filter for a fantasy RPG. 
Given a short narrative context and a list of bracketed terms extracted from it, return ONLY the ones that are actual character or NPC names. 
Exclude skill checks, game mechanics, actions, meta-tags, stats, spell names, locations, and any other non-name terms.

[NARRATIVE CONTEXT]
${shortContext}

[CANDIDATE NAMES TO FILTER]
${candidates.join(', ')}

Respond ONLY with a valid JSON array of strings containing the true character names. Make no other commentary.
If none are character names, respond with [].
Example: ["Captain Aldric", "Orin"]`;

    try {
        const raw = await llmCall(provider, prompt, { priority: 'normal', maxTokens: 500 });

        if (raw) {
            const cleanStr = extractJson(raw);
            const parsed = JSON.parse(cleanStr);
            if (Array.isArray(parsed)) {
                // Return only strings that were in the original candidates (case-insensitive) to prevent hallucinations
                const validLower = new Set(parsed.map(s => String(s).toLowerCase()));
                const filtered = candidates.filter(c => validLower.has(c.toLowerCase()));
                console.log(`[NPC Validator] Filtered ${candidates.length} down to ${filtered.length}:`, filtered);
                return filtered;
            }
        }
    } catch (err) {
        console.warn(`[NPC Validator] API validation failed, falling back to raw candidates:`, err);
    }
    
    return candidates;
}
