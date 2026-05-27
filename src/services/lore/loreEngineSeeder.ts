import type { LoreChunk, EngineSeed, CharacterIntroEntry } from '../../types';

const CATEGORY_PREFIXES = [
    'CHARACTER', 'FACTION', 'NPC', 'HERO', 'VILLAIN',
    'LOCATION', 'CITY', 'REGION', 'ORGANIZATION', 'ENCOUNTER',
];

function extractNameFromHeader(header: string): string {
    const stripped = header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
    const parts = stripped.split(/[—–]/);
    if (parts.length <= 1) return stripped;

    const firstPart = parts[0].trim().toUpperCase();
    if (CATEGORY_PREFIXES.includes(firstPart)) {
        return parts.slice(1).join('—').trim();
    }

    return parts[0].trim();
}

export function extractEngineSeeds(chunks: LoreChunk[]): EngineSeed {
    const seed: EngineSeed = {
        surpriseTypes: [],
        surpriseTones: [],
        encounterTypes: [],
        encounterTones: [],
        worldWho: [],
        worldWhere: [],
        worldWhy: [],
        worldWhat: [],
        characterIntros: [],
    };

    const whoSet = new Set<string>();
    const whereSet = new Set<string>();
    const whySet = new Set<string>();
    const whatSet = new Set<string>();
    const surpriseTypesSet = new Set<string>();
    const surpriseTonesSet = new Set<string>();
    const encounterTypesSet = new Set<string>();
    const encounterTonesSet = new Set<string>();

    for (const chunk of chunks) {
        const text = chunk.content;
        
        // --- WHO (Factions, Orgs, Key Figures) ---
        if (chunk.category === 'faction') {
            const name = extractNameFromHeader(chunk.header);
            if (name) whoSet.add(name);
            
            // Extract leader if present
            const leaderMatch = text.match(/\*\*Key Members:\*\*\s*(.+)/i) || text.match(/\*\*Leader:\*\*\s*(.+)/i);
            if (leaderMatch) {
                leaderMatch[1].split(',').forEach(l => whoSet.add(l.trim()));
            }
        }

        // --- WHERE (Locations) ---
        if (chunk.category === 'location') {
            const name = extractNameFromHeader(chunk.header);
            if (name) whereSet.add(`in or around ${name}`);
        } else if (chunk.category === 'world_overview') {
            // grab capitalized proper nouns that might be places
            const places = text.match(/in (the )?([A-Z][a-z]+(\s[A-Z][a-z]+)*)/g);
            if (places) places.forEach(p => whereSet.add(p));
        }

        // --- WHY (Goals, Motivations) ---
        if (text.includes('**Goals:**')) {
            const match = text.match(/\*\*Goals:\*\*\s*(.+)/i);
            if (match) whySet.add(`to ${match[1].toLowerCase()}`);
        }
        if (chunk.category === 'event' || chunk.category === 'faction') {
            const match = text.match(/\*\*Motivations?:\*\*\s*(.+)/i);
            if (match) whySet.add(`driven by ${match[1].toLowerCase()}`);
        }

        // --- WHAT (Actions, Plot Events) ---
        if (chunk.category === 'event') {
            const summaryLine = chunk.summary;
            if (summaryLine && summaryLine.length > 5) {
                // simple heuristic to get verby action
                whatSet.add(summaryLine.toLowerCase());
            }
            if (chunk.header.toLowerCase().includes('arc')) {
                const name = chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
                whatSet.add(`initiated ${name}`);
            }
        }

        // --- TONES (Overview usually sets the tone) ---
        if (chunk.category === 'world_overview' && text.includes('**Tone:**')) {
            const match = text.match(/\*\*Tone:\*\*\s*(.+)/i);
            if (match) {
                match[1].split(/[,/]+/).forEach(t => {
                    const tone = t.trim().toUpperCase();
                    surpriseTonesSet.add(tone);
                    encounterTonesSet.add(tone);
                });
            }
        }

        // --- TYPES (Derived from mechanics, power systems, cultures) ---
        if (chunk.category === 'power_system') {
            encounterTypesSet.add('POWER_ANOMALY');
            surpriseTypesSet.add('MAGIC_FLUCTUATION');
        }
        if (chunk.category === 'rules') {
            encounterTypesSet.add('SYSTEM_GLITCH');
            surpriseTypesSet.add('MECHANIC_SHIFT');
        }
        if (chunk.category === 'culture') {
            surpriseTypesSet.add('CULTURAL_MISUNDERSTANDING');
            encounterTypesSet.add('SOCIAL_FAUX_PAS');
        }

        const seedFieldPatterns: [RegExp, Set<string>][] = [
            [/\*\*Surprise Types:\*\*\s*(.+)/i, surpriseTypesSet],
            [/\*\*Surprise Tones:\*\*\s*(.+)/i, surpriseTonesSet],
            [/\*\*Encounter Types:\*\*\s*(.+)/i, encounterTypesSet],
            [/\*\*Encounter Tones:\*\*\s*(.+)/i, encounterTonesSet],
            // Accept both legacy "World Event" labels and new "Quest Hook" labels
            [/\*\*(?:World Event Who|Quest Hook Who):\*\*\s*(.+)/i, whoSet],
            [/\*\*(?:World Event What|Quest Hook What):\*\*\s*(.+)/i, whatSet],
            [/\*\*(?:World Event Where|Quest Hook Where):\*\*\s*(.+)/i, whereSet],
            [/\*\*(?:World Event Why|Quest Hook Why):\*\*\s*(.+)/i, whySet],
        ];

        for (const [pattern, set] of seedFieldPatterns) {
            const m = text.match(pattern);
            if (m) {
                m[1].split(/[,/]+/).map(s => s.trim()).filter(Boolean).forEach(v => set.add(v));
            }
        }
    }

    seed.worldWho = Array.from(whoSet).filter(Boolean);
    seed.worldWhere = Array.from(whereSet).filter(Boolean);
    seed.worldWhy = Array.from(whySet).filter(Boolean);
    seed.worldWhat = Array.from(whatSet).filter(Boolean);
    seed.surpriseTypes = Array.from(surpriseTypesSet).filter(Boolean);
    seed.surpriseTones = Array.from(surpriseTonesSet).filter(Boolean);
    seed.encounterTypes = Array.from(encounterTypesSet).filter(Boolean);
    seed.encounterTones = Array.from(encounterTonesSet).filter(Boolean);

    // --- CHARACTER INTROS (Wandering / Location / Boosted) ---
    const characterChunks = chunks.filter(c => c.category === 'character');
    for (const chunk of characterChunks) {
        const text = chunk.content;
        const name = extractNameFromHeader(chunk.header);
        if (!name) continue;

        const isWandering = /\*\*Wandering:\s*true\*\*/i.test(text);
        const locMatch = text.match(/\*\*Location:\s*\*?\*?([^*]+)\*\*/i);
        const location = locMatch ? locMatch[1].trim() : undefined;
        const boostMatch = text.match(/\*\*Intro Boost:\s*\*?\*?([^*]+)\*\*/i);
        const boostKeywords = boostMatch
            ? boostMatch[1].split(/[,/]+/).map(s => s.trim()).filter(Boolean)
            : undefined;

        if (!isWandering && !location) continue;

        let type: CharacterIntroEntry['type'];
        if (isWandering && location && boostKeywords && boostKeywords.length > 0) {
            type = 'location+boosted';
        } else if (isWandering && boostKeywords && boostKeywords.length > 0) {
            type = 'wandering+boosted';
        } else if (location && boostKeywords && boostKeywords.length > 0) {
            type = 'location+boosted';
        } else if (isWandering && location) {
            type = 'location';
        } else if (isWandering) {
            type = 'wandering';
        } else {
            type = 'location';
        }

        const entry: CharacterIntroEntry = { name, type };
        if (location) entry.location = location;
        if (boostKeywords && boostKeywords.length > 0) entry.boostKeywords = boostKeywords;

        seed.characterIntros.push(entry);
    }

    return seed;
}
