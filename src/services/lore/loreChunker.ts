import type { LoreChunk, LoreCategory } from '../../types';
import { countTokens } from '../infrastructure';

const CATEGORY_PREFIXES = [
    'CHARACTER', 'FACTION', 'NPC', 'HERO', 'VILLAIN',
    'LOCATION', 'CITY', 'REGION', 'ORGANIZATION', 'ENCOUNTER',
];

const ALWAYS_INCLUDE_PREFIXES = [
    'wl-meta', 'wl-econ', 'wl-power'
];

const GENERIC_OBVIOUS_RULES = [
    'economy', 'currency', 'power level', 'global rules', 'mechanics'
];

// Common stop words to exclude from auto-extracted keywords
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her',
    'was', 'one', 'our', 'out', 'his', 'had', 'may', 'who', 'been', 'some',
    'them', 'than', 'its', 'into', 'only', 'with', 'from', 'this', 'that',
    'they', 'will', 'each', 'make', 'like', 'been', 'have', 'many', 'most',
    'also', 'made', 'after', 'being', 'their', 'much', 'very', 'when', 'what',
    'which', 'more', 'other', 'about', 'such', 'over', 'just', 'does', 'then',
    'could', 'would', 'should', 'where', 'there', 'those', 'these', 'still',
    'well', 'back', 'even', 'here', 'every', 'both', 'through', 'between',
    'before', 'after', 'during', 'without', 'again', 'because', 'under',
    'real', 'name', 'alias', 'note', 'key', 'class', 'status', 'location',
    'currently', 'known', 'anyone', 'power', 'none', 'variable',
]);


function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function shouldAlwaysInclude(header: string): boolean {
    const headerLower = header.toLowerCase();
    if (ALWAYS_INCLUDE_PREFIXES.some((prefix) => headerLower.includes(prefix))) return true;
    return GENERIC_OBVIOUS_RULES.some((kw) => headerLower.includes(kw));
}

function extractTriggerKeywords(header: string, content: string): string[] {
    const keywords = new Set<string>();
    const text = header + '\n' + content;

    const properNouns = text.match(/[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*/g);
    if (properNouns) {
        for (const noun of properNouns) {
            const lower = noun.toLowerCase();
            if (!STOP_WORDS.has(lower) && lower.length > 2) {
                keywords.add(lower);
            }
        }
    }

    const fieldPatterns = [
        /(?:Real Name|Alias(?:es)?|Affiliation|Location|Slogan)[:\s]+([A-Z][A-Za-z\s,]+)/g,
        /(?:Goals?|Disposition|Type|Members?|Leader|Faction|Title|Role|Occupation|Rank|Specialty|Weakness|Motivation|Known For)[:\s]+([A-Za-z][A-Za-z\s,]+)/g,
    ];
    for (const pattern of fieldPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const val = match[1].trim().toLowerCase().replace(/,$/, '');
            if (val.length > 2 && !STOP_WORDS.has(val)) {
                keywords.add(val);
                val.split(/\s+/).forEach(w => {
                    if (w.length > 2 && !STOP_WORDS.has(w)) keywords.add(w);
                });
            }
        }
    }

    const headerWords = header
        .replace(/\[CHUNK:\s*[A-Z_-]+\]\s*/i, '')
        .split(/[\s/—–]+/)
        .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    headerWords.forEach(w => keywords.add(w));

    if (/\$[\d,]+/.test(text)) {
        keywords.add('money');
        keywords.add('cost');
        keywords.add('buy');
        keywords.add('gear');
    }

    return Array.from(keywords).slice(0, 25);
}

function assignPriority(category: LoreCategory, alwaysInclude: boolean): number {
    if (alwaysInclude) return 10;
    switch (category) {
        case 'world_overview': return 10;
        case 'rules': return 9;
        case 'power_system': return 8;
        case 'faction': return 7;
        case 'character': return 7;
        case 'location': return 6;
        case 'event': return 6;
        case 'relationship': return 6;
        case 'economy': return 5;
        case 'culture': return 5;
        default: return 3;
    }
}

function assignPriorityForRules(category: LoreCategory, alwaysInclude: boolean): number {
    if (alwaysInclude) return 10;
    switch (category) {
        case 'rules': return 9;
        case 'power_system': return 8;
        case 'world_overview': return 8;
        case 'economy': return 7;
        case 'faction': return 6;
        case 'character': return 6;
        case 'location': return 5;
        case 'event': return 5;
        case 'relationship': return 5;
        case 'culture': return 5;
        default: return 4;
    }
}

export function classifyCategory(header: string, content: string, parentHeader?: string): LoreCategory {
    const h = (header || '').toUpperCase();
    const p = (parentHeader || '').toUpperCase();
    const c = (content || '');

    // B7 — [CHUNK: TYPE -- Name] — the TYPE token is authoritative; map it first.
    // The ad-hoc substring checks below missed headers like `[CHUNK: OVERVIEW -- Spirit Cards]`
    // (no `WORLD OVERVIEW` substring) and dumped ~40% of chunks into misc. Parse the type
    // token out of the marker and map known types to categories before any other check.
    const typeMatch = /\[CHUNK:\s*([A-Z_]+)/i.exec(header || '');
    if (typeMatch) {
        const t = typeMatch[1].toUpperCase();
        const TYPE_MAP: Record<string, LoreCategory> = {
            OVERVIEW: 'world_overview', WORLD: 'world_overview',
            FACTION: 'faction', ORGANIZATION: 'faction',
            HERO: 'character', CHARACTER: 'character', NPC: 'character',
            LOCATION: 'location', CITY: 'location', REGION: 'location',
            EVENT: 'event', TIMELINE: 'event',
            RELATIONSHIP: 'relationship',
            POWER: 'power_system', MAGIC: 'power_system',
            ECONOMY: 'economy', CULTURE: 'culture', RELIGION: 'culture',
            RULES: 'rules', MECHANIC: 'rules',
        };
        if (TYPE_MAP[t]) return TYPE_MAP[t];
    }

    if (h.includes('[CHUNK: HERO') || p.includes('CHARACTER') || h.includes('CHARACTER —')) return 'character';
    if (h.includes('[CHUNK: FACTION') || h.includes('[CHUNK: ORGANIZATION') || p.includes('FACTION')) return 'faction';
    if (h.includes('WORLD OVERVIEW') || h.includes('CORE IDENTITY') || h.includes('WORLD STATE')) return 'world_overview';
    if (h.includes('POWER SYSTEM') || h.includes('MAGIC') || h.includes('MANA') || h.includes('RANK')) return 'power_system';
    if (h.includes('ECONOMY') || h.includes('CURRENCY') || h.includes('COST')) return 'economy';
    if (h.includes('ARC SUMMARY') || h.includes('DEATH FLAG') || h.includes('TIMELINE') || p.includes('EVENT')) return 'event';
    if (h.includes('RELATIONSHIP') || h.includes('ERD') || h.includes('LEVERAGE')) return 'relationship';
    if (h.includes('RULES') || h.includes('GENERATION PROTOCOL') || h.includes('MECHANIC')) return 'rules';
    if (h.includes('LOCATION') || h.includes('CITY') || h.includes('REGION') || p.includes('LOCATION')) return 'location';
    if (h.includes('CULTURE') || h.includes('RELIGION') || h.includes('CUSTOM')) return 'culture';

    // Heuristics
    if (c.includes('**Goals:**') && (c.includes('**Disposition:**') || c.includes('**Status:**'))) return 'character';
    if (c.includes('**Type:**') && (c.includes('Members:**') || c.includes('Stance:**'))) return 'faction';

    return 'misc';
}

type RagHint = {
    mode: 'always' | 'keyword' | 'vector';
    priority?: number;
    triggers: string[];
    secondary: string[];
};

function parseRagHint(line: string): RagHint | null {
    const match = line.match(/<!--\s*rag:\s*(.+?)\s*-->/i);
    if (!match) return null;
    const body = match[1];

    const modeMatch = body.match(/^(always|keyword|vector)/i);
    if (!modeMatch) return null;
    const mode = modeMatch[1].toLowerCase() as 'always' | 'keyword' | 'vector';

    const priorityMatch = body.match(/priority:\s*(\d+)/i);
    const priority = priorityMatch ? parseInt(priorityMatch[1], 10) : undefined;

    // Capture triggers: everything from "triggers:" up to the next named param or end
    const triggersMatch = body.match(/triggers:\s*(.+?)(?=,\s*(?:priority|secondary)\s*:|$)/i);
    const triggers = triggersMatch
        ? triggersMatch[1].split(',').map(t => t.trim()).filter(Boolean)
        : [];

    const secondaryMatch = body.match(/secondary:\s*(.+?)(?=,\s*priority\s*:|$)/i);
    const secondary = secondaryMatch
        ? secondaryMatch[1].split(',').map(t => t.trim()).filter(Boolean)
        : [];

    return { mode, priority, triggers, secondary };
}

function generateSummary(_header: string, content: string): string | undefined {
    const lines = content.split('\n');
    for (const line of lines) {
        if (line.includes('**Entity:**') || line.includes('**Status:**') || line.includes('**Type:**')) {
            return line.trim();
        }
    }
    // Fallback: first non-empty line without bold that has some meat
    const cleanLines = lines.map(l => l.replace(/\*\*/g, '').trim()).filter(l => l.length > 20);
    return cleanLines.length > 0 ? cleanLines[0].substring(0, 100) : undefined;
}

function extractLinkedEntities(chunks: LoreChunk[]) {
    const entityDict = chunks.map(c => {
        let name = c.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
        const parts = name.split(/[—–]/);
        if (parts.length > 1) {
            const firstPart = parts[0].trim().toUpperCase();
            if (CATEGORY_PREFIXES.includes(firstPart)) {
                name = parts.slice(1).join('—').trim();
            } else {
                name = parts[0].trim();
            }
        }
        return { name, id: c.id, nameLower: name.toLowerCase() };
    }).filter(e => e.nameLower.length > 3);

    for (const chunk of chunks) {
        const text = chunk.content.toLowerCase();
        const linked = new Set<string>();
        for (const e of entityDict) {
            if (e.id !== chunk.id && text.includes(e.nameLower)) {
                linked.add(e.name);
            }
        }
        chunk.linkedEntities = Array.from(linked);
    }
}

export function chunkLoreFile(markdown: string, category?: 'lore' | 'rule'): LoreChunk[] {
    const normalizedMarkdown = markdown.replace(/\\(#{2,3})\s*/g, '\n$1 ');
    const lines = normalizedMarkdown.split(/\r?\n/);
    const chunks: LoreChunk[] = [];
    const usedIds = new Set<string>();

    function getUniqueId(baseId: string): string {
        let uniqueId = baseId;
        let counter = 1;
        while (usedIds.has(uniqueId)) {
            uniqueId = `${baseId}-${counter}`;
            counter++;
        }
        usedIds.add(uniqueId);
        return uniqueId;
    }

    const headerRegex = /^\s*(#{2,3})\s+(.+)/;

    let currentHeader = '';
    let parentHeader = '';
    let currentLines: string[] = [];
    let preambleLines: string[] = [];

    const flushChunk = () => {
        // Strip leading blank lines, then check first line for <!-- rag: --> hint
        const trimmedLines = [...currentLines];
        while (trimmedLines.length > 0 && trimmedLines[0].trim() === '') trimmedLines.shift();

        let ragHint: RagHint | null = null;
        if (trimmedLines.length > 0) {
            ragHint = parseRagHint(trimmedLines[0].trim());
            if (ragHint) trimmedLines.shift(); // strip the hint line — AI never sees it
        }

        const content = trimmedLines.join('\n').trim();
        if (content && currentHeader) {
            const baseId = slugify(currentHeader);
            const id = getUniqueId(baseId);

            // Hint takes precedence over heuristics when present
            const alwaysInclude = ragHint
                ? ragHint.mode === 'always'
                : shouldAlwaysInclude(currentHeader);

            let activationModes: ('vector' | 'keyword' | 'always')[];
            if (ragHint?.mode === 'always' || alwaysInclude) {
                activationModes = ['always'];
            } else if (ragHint?.mode === 'keyword') {
                activationModes = ['keyword'];
            } else if (ragHint?.mode === 'vector') {
                activationModes = ['vector'];
            } else {
                // No hint: default to BOTH semantic + keyword so the chunk can be
                // pulled in by meaning-similarity OR an exact term match.
                activationModes = ['vector', 'keyword'];
            }

            const autoCategory = classifyCategory(currentHeader, content, parentHeader);

            let finalScanDepth = 3;
            if (content.includes('**scan_depth:**')) {
                const match = content.match(/\*\*scan_depth:\*\*\s*(.+)/);
                if (match) finalScanDepth = parseInt(match[1], 10) || 3;
            }

            const basePriority = category === 'rule'
                ? assignPriorityForRules(autoCategory, alwaysInclude)
                : assignPriority(autoCategory, alwaysInclude);
            const chunkPriority = ragHint?.priority ?? basePriority;

            // If hint provides triggers, prepend them to auto-extracted keywords
            const autoKeywords = extractTriggerKeywords(currentHeader, content);
            const triggerKeywords = ragHint?.triggers.length
                ? [...new Set([...ragHint.triggers, ...autoKeywords])]
                : autoKeywords;

            chunks.push({
                id,
                header: currentHeader,
                content,
                tokens: countTokens(currentHeader + '\n' + content),
                alwaysInclude,
                triggerKeywords,
                secondaryKeywords: ragHint?.secondary.length ? ragHint.secondary : undefined,
                scanDepth: finalScanDepth,
                category: autoCategory,
                linkedEntities: [],
                parentSection: parentHeader || undefined,
                priority: chunkPriority,
                summary: generateSummary(currentHeader, content),
                ragMode: ragHint?.mode,
                activationModes,
                modesUserEdited: false,
            });
        }
    };

    for (const line of lines) {
        const match = line.match(headerRegex);
        if (match) {
            const level = match[1].length; 
            const title = match[2].trim();

            if (currentHeader) flushChunk();
            else if (currentLines.length > 0) preambleLines = [...currentLines];

            if (level === 2) {
                parentHeader = title;
            }

            currentHeader = title;
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }

    if (currentHeader) flushChunk();

    // Preamble logic
    const preamble = preambleLines.join('\n').trim();
    if (preamble && countTokens(preamble) > 20) {
        const title = 'World Overview';
        chunks.unshift({
            id: 'preamble',
            header: title,
            content: preamble,
            tokens: countTokens(title + '\n' + preamble),
            alwaysInclude: true,
            triggerKeywords: extractTriggerKeywords(title, preamble),
            scanDepth: 3,
            category: 'world_overview',
            linkedEntities: [],
            priority: 10,
            summary: generateSummary(title, preamble),
            activationModes: ['always'] as const,
            modesUserEdited: false,
        });
    }

    extractLinkedEntities(chunks);

    return chunks;
}

