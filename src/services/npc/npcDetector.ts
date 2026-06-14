import type { NPCEntry, LLMProvider } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    extractJson,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ARRAY_ONLY_FOOTER,
    joinPromptSections,
} from '../infrastructure';
import TITLES from '../../data/titles.json';
import NAME_BLOCKLIST_DATA from '../../data/nameBlocklist.json';

const TITLES_SET = new Set(TITLES.map(t => t.toLowerCase()));
const NAME_CONNECTIVES = new Set(['of', 'the', 'von', 'de', 'di', 'al', 'el', 'ibn', 'bin']);

const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature|clone|drone|knight|priest|mage|wizard|archer|thief)\s+([a-z0-9]|#\d+)$/i;

const NPC_NAME_BLOCKLIST = new Set([
    // articles / connectives / prepositions
    "you", "i", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "about", "like", "through", "over", "before", "between", "after", "since", "without", "under", "within", "along", "following", "across", "behind", "beyond", "plus", "except", "up", "out", "around", "down", "off", "above", "near",
    // pronouns
    "she", "he", "it", "they", "them", "we", "us", "his", "her", "their", "our", "your", "my", "mine",
    // sentence starters / discourse markers
    "then", "suddenly", "meanwhile", "however", "although", "therefore", "otherwise", "inside", "outside", "perhaps", "maybe", "indeed", "certainly", "instead", "still", "also", "only", "just", "even", "yet", "soon", "later", "now", "today", "tomorrow", "yesterday", "finally", "eventually", "overall", "moreover", "furthermore", "nevertheless", "nonetheless", "regardless", "anyway", "anyhow", "besides", "actually", "really", "very", "quite", "rather", "somewhat", "always", "never", "often", "sometimes", "rarely", "seldom", "usually", "occasionally",
    // weekdays / months
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    // common sentence-initial nouns/adjectives
    "every", "each", "all", "some", "any", "no", "none", "many", "few", "several", "most", "more", "less", "much", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "first", "second", "third", "last", "next", "previous", "another", "other", "same", "different",
    "what", "when", "where", "why", "who", "how", "which", "whose", "that", "this", "these", "those", "here", "there",
    "wait", "well", "okay", "ok", "yes", "yep", "no", "nope", "sure", "fine", "good", "great", "nice", "bad", "right", "wrong", "true", "false",
    "not", "but",
    // dice / mechanics terms
    "catastrophe", "failure", "success", "triumph", "fumble", "critical", "crit", "advantage", "disadvantage", "normal", "natural", "encounter", "surprise", "world", "event", "skill", "check", "save", "saving", "throw", "roll", "rolls", "dice", "die", "result", "outcome", "modifier", "bonus", "penalty",
    // narrative meta words
    "equipment", "inventory", "scene", "chapter", "act", "session", "turn", "round", "phase", "time", "day", "night", "morning", "afternoon", "evening", "dawn", "dusk", "midnight", "noon",
    "academy", "adventure", "story", "tale", "narrative", "system",
    // structures & locations (common nouns capitalized in titles)
    "gate", "wall", "hall", "tower", "bridge", "mouth", "square", "market",
    "outpost", "garrison", "district", "quarter", "road", "path", "bay",
    "canal", "harbor", "harbour", "port", "keep", "fortress", "castle",
    "temple", "shrine", "chapel", "tavern", "inn", "manor", "estate",
    "forest", "mountain", "valley", "river", "lake", "sea", "ocean",
    "north", "south", "east", "west", "northern", "southern", "eastern", "western",
    "upper", "lower", "old", "new", "great", "grand",
    // organizations & institutions (common nouns capitalized in titles)
    "office", "business", "bureau", "department", "agency", "company",
    "corporation", "ministry", "council", "committee", "guild", "union",
    "league", "alliance", "federation", "syndicate", "consortium",
    "headquarters", "bank", "shop", "store", "school", "college",
    "university", "hospital", "library", "prison", "barracks",
]);

// Merge the engine-shipped generated blocklist (Plan 05, Component B): titles,
// ranks, kinship/address words, places, organisations, abstract/time/common
// capitalized nouns. Its #ambiguous section (words that could be real given
// names) is excluded at build time, so unioning here can't shadow legit names.
for (const w of NAME_BLOCKLIST_DATA as string[]) NPC_NAME_BLOCKLIST.add(w);

// Contraction suffix pattern — straight and curly apostrophes
const CONTRACTION_SUFFIX_RE = /['’](s|re|t|ve|ll|d|m)$/i;

// Bounded speech attribution verbs
const SPEECH_VERBS = 'said|asked|whispered|shouted|replied|muttered|growled|spoke|called|answered|continued|added|cried|yelled|barked|snapped|hissed|murmured|breathed|intoned|declared|announced|exclaimed|demanded|ordered|commanded|pleaded|begged|insisted|admitted|confessed|offered|suggested|noted|observed|remarked|commented|explained|stated';

/** Extract NPC names using explicit introduction signals only — no single-word prose fishing. */
export function extractNPCNames(content: string, excludeNames: string[] = []): string[] {
    const candidates = new Set<string>();
    const excludeSet = new Set(excludeNames.map(n => n.toLowerCase()));

    const tryAdd = (raw: string) => {
        if (!raw || raw.length < 2) return;
        if (CONTRACTION_SUFFIX_RE.test(raw)) return;
        const stripped = stripTitle(raw);
        if (!stripped || stripped.length < 2) return;
        if (CONTRACTION_SUFFIX_RE.test(stripped)) return;
        if (!isValidCandidate(stripped, excludeSet, GENERIC_ROLE_PATTERN, NPC_NAME_BLOCKLIST)) return;
        const tokens = stripped.split(/\s+/);
        if (tokens.length > 1) {
            const hasBadToken = tokens.some(t => {
                const tl = t.toLowerCase();
                return !NAME_CONNECTIVES.has(tl) && NPC_NAME_BLOCKLIST.has(tl);
            });
            if (hasBadToken) return;
        }
        candidates.add(stripped);
    };

    // Pass 1: [Name] and [**Name**]
    for (const m of content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 2: [SYSTEM: NPC_ENTRY - Name]
    for (const m of content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi)) {
        tryAdd(m[1].trim());
    }

    // Pass 3: Title-prefixed — "Captain Aldric", "Instructor Roderick Vaul"
    for (const m of content.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z''’-]+){1,3})\b/g)) {
        const raw = m[1].trim();
        if (TITLES_SET.has(raw.split(/\s+/)[0].toLowerCase())) {
            tryAdd(raw);
        }
    }

    // Pass 4a: Name followed by speech verb — "Aldric said", "Maren whispered"
    const nameVerbRe = new RegExp(
        `\\b([A-Z][a-z''\\u2019-]+(?:\\s+[A-Z][a-z''\\u2019-]+){0,2})\\s+(?:${SPEECH_VERBS})\\b`, 'g'
    );
    for (const m of content.matchAll(nameVerbRe)) {
        tryAdd(m[1].trim());
    }

    // Pass 4b: Speech verb followed by name — "said Aldric", "whispered Maren"
    const verbNameRe = new RegExp(
        `\\b(?:${SPEECH_VERBS})\\s+([A-Z][a-z''\\u2019-]+(?:\\s+[A-Z][a-z''\\u2019-]+){0,2})\\b`, 'g'
    );
    for (const m of content.matchAll(verbNameRe)) {
        tryAdd(m[1].trim());
    }

    // Pass 5a: Role-apposition — "the merchant Orin", "The guard Orin", "an innkeeper Bram"
    for (const m of content.matchAll(/\b(?:[Tt]he|[Aa]n?)\s+\w+\s+([A-Z][a-z’’’-]+(?:\s+[A-Z][a-z’’’-]+){0,2})\b/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 5b: Named/called introduction — "a man named Bram", "called Orin"
    for (const m of content.matchAll(/\b(?:[Nn]amed|[Cc]alled)\s+([A-Z][a-z’’’-]+(?:\s+[A-Z][a-z’’’-]+){0,2})\b/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 6: Connective names — "Aldric of Westhold", "Elara von Mire"
    for (const m of content.matchAll(/\b([A-Z][a-z''’-]+\s+(?:of|von|de|di|al|el|ibn|bin)\s+[A-Z][a-z''’-]+)\b/g)) {
        tryAdd(m[1].trim());
    }

    // NOTE: a former Pass 7 matched ANY two consecutive capitalized tokens with no
    // introduction signal. LLM GM prose is wall-to-wall Title Case noun phrases
    // ("Inner Courtyard", "Tactical Decision", "Rescue Force"), so it manufactured a
    // fake NPC every turn and no blocklist could keep up. Removed entirely: every
    // remaining pass requires a real signal (bracket, title, speech verb, "named X",
    // apposition, connective). A multi-word name introduced with zero signal is
    // missed until it next appears with one — rare, and far cheaper than the garbage.

    return Array.from(candidates);
}

function isValidCandidate(raw: string, excludeSet: Set<string>, genericPattern: RegExp, blocklist: Set<string>): boolean {
    if (raw.length < 2) return false;
    if (raw.includes(' ') && raw === raw.toUpperCase()) return false;
    if (blocklist.has(raw.toLowerCase())) return false;
    if (genericPattern.test(raw)) return false;
    if (excludeSet.has(raw.toLowerCase())) return false;
    return true;
}

/** Strip leading title from a name. "Captain Aldric" → "Aldric", "Lady Elara of Mire" → "Elara of Mire" */
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
        const existingNpc = ledger.find(npc => {
            if (!npc.name) return false;
            const aliasesRaw = npc.aliases || '';
            const allNames = [npc.name, ...aliasesRaw.split(',').map(a => a.trim())].filter(Boolean);
            const search = potentialName.toLowerCase();
            return allNames.some(n => {
                const lower = n.toLowerCase();
                // Symmetric prefix/suffix match: catches "Aldric" vs ledger "Aldric Stone"
                // AND "Aldric the Younger" vs ledger "Aldric".
                return lower === search
                    || lower.startsWith(search + ' ') || lower.endsWith(' ' + search)
                    || search.startsWith(lower + ' ') || search.endsWith(' ' + lower);
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
 * LLM validation pass to filter out non-name false positives.
 * Falls back to original candidates on API error.
 */
export async function validateNPCCandidates(
    provider: LLMProvider,
    candidates: string[],
    narrativeContext: string
): Promise<string[]> {
    if (candidates.length === 0) return candidates;

    console.log(`[NPC Validator] Validating ${candidates.length} candidates against LLM semantic filter...`);

    const shortContext = narrativeContext.slice(-1000);

    const prompt = joinPromptSections(
        'You are a strict data filter for a roleplay/RPG NPC ledger.',

        `TASK: Return ONLY items from the candidate list that are clearly the proper name of a SPECIFIC PERSON or sentient character (NPC). Each surviving candidate MUST be answerable to "is this the personal name of a specific individual person/being who could be addressed in dialogue?"

A valid name refers to an individual addressable as a character: e.g. "Aldric", "Seraphine Thornmere", "Dorian Ashworth".

REJECT everything that is not unambiguously a character's personal name, including:
- Dice / mechanics terms: Catastrophe, Failure, Success, Triumph, Critical, Advantage, Disadvantage, Normal, Natural, Encounter, Surprise, Skill Check, Save
- Generic roles or titles WITHOUT a name: Guard, Captain, Soldier, Academy, Equipment, Inventory
- Locations, factions, organizations, items, spells, abilities
- Organizations, offices, and institutions like "Convergence Business Office", "Merchant Guild", "City Council" — these are NEVER valid even if capitalized in prose
- Compound location names like "Main Gate", "Iron Mouth", "North Bridge" — these are NEVER valid even if capitalized in prose
- Sentence-initial common words capitalized by accident: "Two", "Not", "Every", "Equipment", "Academy", "Adventure"
- Combined dice/mechanic phrases: "Disadvantage Catastrophe", "Normal Failure"
- Anything you cannot confidently identify as a person's name from context

When in doubt, REJECT. If none are valid names, return [].`,

        JSON_ARRAY_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `[NARRATIVE CONTEXT]\n${shortContext}`,
        `[CANDIDATES]\n${candidates.join(', ')}`,
    );

    try {
        const raw = await llmCall(provider, prompt, { priority: 'normal', maxTokens: 500 });

        if (raw) {
            const cleanStr = extractJson(raw);
            const parsed = JSON.parse(cleanStr);
            if (Array.isArray(parsed)) {
                const validLower = new Set(parsed.map(s => String(s).trim().toLowerCase()));
                const filtered = candidates.filter(c => validLower.has(c.trim().toLowerCase()));
                console.log(`[NPC Validator] Filtered ${candidates.length} down to ${filtered.length}:`, filtered);
                return filtered;
            }
        }
        // Empty response or non-array shape (common with weak utility models):
        // a malformed validator output every turn would silently drop EVERY name.
        // Per this function's contract, fall back to the unvalidated candidates
        // rather than rejecting them — false positives are cheaper than total failure.
        console.warn(`[NPC Validator] No usable JSON array from validator — falling back to ${candidates.length} unvalidated candidate(s).`);
        return candidates;
    } catch (err) {
        console.warn(`[NPC Validator] API/parse failure — falling back to unvalidated candidates this pass:`, err);
        return candidates;
    }
}

export const COMBAT_TIER_ARCHETYPE_RUBRIC = `For any NPC who could plausibly fight, also assign:

combatTier (raw threat / how dangerous in a fight):
- "minion": fodder, untrained, dies fast (street thug, conscript).
- "grunt": competent rank-and-file (trained soldier, seasoned bandit). DEFAULT if unsure.
- "elite": a standout threat (captain, veteran duelist, skilled mage).
- "boss": a major antagonist who anchors an encounter.
- "legendary": world-class, a fight against them is a set-piece.
NOTE: combatTier is COMBAT threat, independent of narrative importance — a beloved harmless
shopkeeper is "minion"; a feared assassin cameo can be "elite".

archetype (how they fight — drives their AI behavior):
- "bulwark": tanky defender, protects allies (knight, bodyguard).
- "brute": raw offense, heavy hits (berserker, ogre).
- "assassin": fast, precise, burst (rogue, ninja).
- "skirmisher": mobile, adaptable, ranged/hit-and-run. DEFAULT if unsure.
- "caster": magic/tech ranged, fragile (mage, hacker, sniper-mystic).

Only assign these for combat-relevant NPCs. If the NPC is purely social/narrative and would
never fight, you may omit them (the store backfills defaults).`;
