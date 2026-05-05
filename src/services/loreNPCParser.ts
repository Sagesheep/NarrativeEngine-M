import type { NPCEntry, LoreChunk } from '../types';
import { uid } from '../utils/uid';

/**
 * Parses a world lore markdown file for a `## CHARACTERS` section and
 * extracts structured NPC entries for the ledger.
 *
 * Each character block must use `### Name` headers with `**Field:** Value` bullets.
 * Fields: Aliases, Appearance, Disposition, Goals, Faction, StoryRelevance,
 *         Status, Affinity, Nature, Training, Emotion, Social, Belief, Ego
 */
export function parseNPCsFromLore(chunks: LoreChunk[]): NPCEntry[] {
    const npcs: NPCEntry[] = [];
    const characterChunks = chunks.filter(c => c.category === 'character');

    for (const chunk of characterChunks) {
        let name = chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
        name = name.split(/[—–-]/)[0].trim();
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

        npcs.push({
            id: uid(),
            name,
            aliases: get('Aliases'),
            appearance: getAny(['Appearance', 'VisualForAI']),
            disposition: get('Disposition'),
            goals: get('Goals'),
            faction: get('Faction'),
            storyRelevance: get('StoryRelevance'),
            status: (get('Status') as NPCEntry['status']) || 'Alive',
            affinity: getNum('Affinity', 50),
            voice: get('Voice'),
            personality: get('Personality'),
            exampleOutput: get('ExampleOutput') || get('Example'),
        });
    }

    return npcs;
}
