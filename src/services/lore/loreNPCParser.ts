import type { NPCEntry, LoreChunk, HexAxis, PersonalityHex } from '../../types';
import { uid } from '../../utils/uid';
import { TRAIT_NAMES } from '../npc/agencyPools';

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
const KNOWN_TRAITS = new Set<string>(TRAIT_NAMES);

const CATEGORY_PREFIXES = [
    'CHARACTER', 'FACTION', 'NPC', 'HERO', 'VILLAIN',
    'LOCATION', 'CITY', 'REGION', 'ORGANIZATION', 'ENCOUNTER',
];

/**
 * Extracts the actual name from a header that may include a category prefix.
 *
 * Handles two conventions:
 * - "CHARACTER — King Giovanni" → "King Giovanni" (prefix before dash)
 * - "Aragorn — The Ranger"      → "Aragorn"          (name before dash)
 * - "Gandalf"                   → "Gandalf"           (no dash)
 */
function extractNameFromHeader(raw: string): string {
    const stripped = raw.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();

    const doubleDashMatch = stripped.match(/^[A-Z][A-Z_\s]*--\s*(.+)/);
    if (doubleDashMatch) return doubleDashMatch[1].trim();

    const parts = stripped.split(/[—–]/);
    if (parts.length <= 1) return stripped;

    const firstPart = parts[0].trim().toUpperCase();
    if (CATEGORY_PREFIXES.includes(firstPart)) {
        return parts.slice(1).join('—').trim();
    }

    return parts[0].trim();
}

/**
 * Parses a world lore markdown file for a `## CHARACTERS` section and
 * extracts structured NPC entries for the ledger.
 *
 * Each character block must use `### Name` headers with `**Field:** Value` bullets.
 * Fields: Aliases, Appearance, Disposition, Personality, Voice, Goals, Faction,
 *         StoryRelevance, Status, Affinity (0–100), Example Output.
 *         Optional agency fields (authoritative for canon NPCs — skip LLM inference):
 *           - **PersonalityHex:** drive:+3, diligence:-1, boldness:+2, warmth:+1,
 *                                  empathy:+2, composure:-1   (CSV or inline JSON)
 *           - **Traits:** [loyal, stubborn, impulsive]   (filtered to TRAIT_VOCAB, ≤5)
 */
export function parseNPCsFromLore(chunks: LoreChunk[]): NPCEntry[] {
    const npcs: NPCEntry[] = [];
    const characterChunks = chunks.filter(c => c.category === 'character');

    for (const chunk of characterChunks) {
        const name = extractNameFromHeader(chunk.header);
        if (!name) continue;

        const body = chunk.content;

        const get = (field: string): string => {
            const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
            const m = body.match(re);
            return m ? m[1].trim() : '';
        };
        
        const getAny = (fields: string[]): string => {
            for (const field of fields) {
                const value = get(field);
                if (value) return value;
            }
            return '';
        };

        const getNum = (field: string, fallback: number): number => {
            const raw = get(field);
            if (!raw) return fallback;
            const match = raw.match(/\d+/);
            if (!match) return fallback;
            const n = parseInt(match[0], 10);
            return isNaN(n) ? fallback : n;
        };

        // ---- Lore-authored agency fields (hex + traits). ----
        // The parser is the ONE place lore can authoritatively preseed these for canon NPCs.
        // Without this, populateAgencyFields later re-infers them from the disposition string via
        // an LLM call — which is where canon mischaracterization crept in. When the lore block
        // provides them, the parser surfaces them and populateAgencyFields' existing
        // `if (!npc.personalityHex)` / `if (!npc.traits)` guards skip the LLM inference entirely.

        /** Coerce one axis value to a clamped integer in -3..+3; non-numeric → 0. */
        const clampHexValue = (v: unknown): number => {
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n)) return 0;
            return Math.max(-3, Math.min(3, Math.round(n)));
        };

        /**
         * Parse `**PersonalityHex:**` from the lore block. Accepts either a CSV of
         * `axis:value` pairs (e.g. "drive:+3, diligence:-1, boldness:+2, ...") or an inline
         * JSON object (e.g. `{"drive":3,"diligence":-1,...}`). Unknown axes are ignored;
         * missing axes default to 0. Returns `undefined` when the field is absent so the
         * downstream `npcs.push` leaves `personalityHex` unset (preserving prior behaviour).
         */
        const getHex = (field: string): PersonalityHex | undefined => {
            const raw = get(field);
            if (!raw) return undefined;
            const hex = {} as PersonalityHex;
            for (const axis of HEX_AXES) hex[axis] = 0;
            // Try JSON first (tolerates whitespace + trailing commas are not supported by
            // JSON.parse, but the common case is a single-line object).
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
                    for (const axis of HEX_AXES) {
                        if (axis in obj) hex[axis] = clampHexValue(obj[axis]);
                    }
                    return hex;
                } catch {
                    // fall through to CSV parsing
                }
            }
            // CSV form: drive:+3, diligence:-1, boldness:+2, warmth:+1, empathy:+2, composure:-1
            for (const part of raw.split(',')) {
                const m = part.match(/([a-zA-Z]+)\s*[:=]\s*([-+]?\d+)/);
                if (!m) continue;
                const axis = m[1].toLowerCase();
                const value = parseInt(m[2], 10);
                if ((HEX_AXES as readonly string[]).includes(axis)) {
                    hex[axis as HexAxis] = clampHexValue(value);
                }
            }
            return hex;
        };

        /**
         * Parse `**Traits:**` from the lore block. Accepts `[a, b, c]`, `a, b, c`, or
         * `a b c`. Filters to the controlled vocabulary in TRAIT_VOCAB (case-insensitive),
         * dedupes, caps at 5. Returns `undefined` when absent so the downstream guards still
         * trigger LLM inference for NPCs the lore author didn't seed.
         */
        const getTraits = (field: string): string[] | undefined => {
            const raw = get(field);
            if (!raw) return undefined;
            const stripped = raw.replace(/[\[\]]/g, '').trim();
            if (!stripped) return undefined;
            const out: string[] = [];
            for (const item of stripped.split(/[,;]|\s{2,}|\|/)) {
                const t = item.toLowerCase().trim();
                if (!t || !KNOWN_TRAITS.has(t)) continue;
                if (out.includes(t)) continue;
                out.push(t);
                if (out.length >= 5) break;
            }
            return out.length > 0 ? out : undefined;
        };

        const disposition = get('Disposition') || '';

        npcs.push({
            id: uid(),
            name,
            aliases: get('Aliases'),
            appearance: getAny(['Appearance', 'VisualForAI']),
            disposition,
            goals: get('Goals'),
            faction: get('Faction'),
            storyRelevance: get('StoryRelevance'),
            status: (get('Status') as NPCEntry['status']) || 'Alive',
            affinity: getNum('Affinity', 50),
            voice: getAny(['Voice', 'Speech Pattern', 'Voice & Speech Pattern']),
            personality: getAny(['Personality', 'Personality Traits']) || disposition,
            exampleOutput: getAny(['Example Output', 'Example Dialogue', 'Example Line']),
            // Lore-authored agency fields. When present, populateAgencyFields' existing
            // `if (!npc.personalityHex)` / `if (!npc.traits)` guards skip the LLM inference
            // call — canon NPCs keep their authored personality instead of being re-inferred.
            personalityHex: getHex('PersonalityHex'),
            traits: getTraits('Traits'),
        });
    }

    return npcs;
}