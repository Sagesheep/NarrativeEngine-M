import type { NPCEntry, LoreChunk } from '../../types';
import { uid } from '../../utils/uid';

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
 *         StoryRelevance, Status, Affinity (0–100), Example Output
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
        });
    }

    return npcs;
}