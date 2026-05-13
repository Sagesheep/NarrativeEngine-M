import type { LLMProvider, DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveChapter } from '../types';
import { llmCall } from '../utils/llmCall';
import { uid } from '../utils/uid';
import { countTokens } from './tokenizer';
import { extractJson } from './payloadBuilder';
import { toast } from '../components/Toast';

export const EMPTY_REGISTER: DivergenceRegister = {
    entries: [],
    chapterToggles: {},
    categoryToggles: {},
    lastUpdatedSceneId: '',
    lastUpdatedAt: 0,
    version: 2,
};

export const DIVERGENCE_CATEGORIES: DivergenceCategory[] = [
    'locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc'
];

const VALID_CATEGORIES: ReadonlySet<DivergenceCategory> = new Set(DIVERGENCE_CATEGORIES);

export const CATEGORY_LABELS: Record<DivergenceCategory, string> = {
    locations: 'LOCATIONS',
    npc_events: 'NPC EVENTS',
    promises_debts: 'PROMISES & DEBTS',
    world_state: 'WORLD STATE',
    party_facts: 'PARTY FACTS',
    rules_lore: 'RULES & LORE',
    misc: 'MISCELLANEOUS',
};

export const CATEGORY_DEFINITIONS: Record<DivergenceCategory, string> = {
    locations: 'Named locations that were discovered, destroyed, or permanently changed',
    npc_events: 'Specific events involving named NPCs (alliances, betrayals, deaths, arrivals)',
    promises_debts: 'Transactional agreements, oaths, debts, and their settlement state',
    world_state: 'Deaths, regime changes, destruction of untracked entities, broad world changes',
    party_facts: 'PC scars, possessions gained/lost, reputation, titles, abilities',
    rules_lore: 'World rules or lore established mid-story that constrain future narration',
    misc: 'Anything that does not fit the other categories',
};

export function coerceCategory(raw: string): DivergenceCategory {
    const norm = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (VALID_CATEGORIES.has(norm as DivergenceCategory)) return norm as DivergenceCategory;
    return 'misc';
}

export function stripReasoning(raw: string): string {
    let clean = raw
        .replace(/<think[\s\S]*?<\/think\s*>/gi, '')
        .replace(/<reasoning[\s\S]*?<\/reasoning\s*>/gi, '')
        .replace(/<reflection[\s\S]*?<\/reflection\s*>/gi, '');
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) clean = fence[1];
    return clean.trim();
}

function buildSealExtractionPrompt(
    chapterText: string,
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[]
): string {
    const npcList = npcLedger.map(n =>
        `- ${n.name} (id: ${n.id}${n.aliases ? ', also known as: ' + n.aliases : ''})`
    ).join('\n');

    const slotDefinitions = DIVERGENCE_CATEGORIES.filter(c => c !== 'misc').map(c =>
        `### ${c.toUpperCase()}\nDefinition: ${CATEGORY_DEFINITIONS[c]}\nOutput: JSON array for this slot, or [] if empty.`
    ).join('\n\n');

    return `You are extracting established facts from a sealed chapter of a TTRPG campaign. These facts will be injected into future AI prompts so the AI does not contradict them.

CHAPTER: "${chapterTitle}"
SCENE IDs IN THIS CHAPTER: ${sceneIds.join(', ')}

NPC LEDGER (resolve names to IDs):
${npcList || '(no NPCs in ledger)'}

CHAPTER TEXT:
${chapterText}

TASK: Extract facts that would BREAK A FUTURE SCENE if the AI contradicted them. Skip transient details, emotional narration, momentary states, and anything the archive would already surface.

SLOTS (fill each, output [] if empty):

${slotDefinitions}

### MISC
Definition: ${CATEGORY_DEFINITIONS.misc}
Output: JSON array for this slot, or [] if empty.

OUTPUT FORMAT — single JSON object with one key per category slot. Each value is an array of objects:
{
  "locations": [
    { "text": "Eastern gate destroyed by siege", "sceneRef": "014", "npcIds": [], "unrecognizedNpcNames": [] }
  ],
  "npc_events": [
    { "text": "Goblin King Grak allied with the player", "sceneRef": "018", "npcIds": ["npc_42"], "unrecognizedNpcNames": [] }
  ],
  "promises_debts": [],
  "world_state": [],
  "party_facts": [
    { "text": "Player acquired the Shadow Blade", "sceneRef": "020", "npcIds": [], "unrecognizedNpcNames": [] }
  ],
  "rules_lore": [],
  "misc": []
}

RULES:
- Each fact is ONE SHORT SENTENCE, max 15 words. No compound sentences, no explanations.
- sceneRef must be one of: ${sceneIds.join(', ')}
- npcIds: list the NPC ledger IDs mentioned. If a name appears that is NOT in the ledger, put it in unrecognizedNpcNames instead.
- If a name is unknown, still extract the fact and list the name in unrecognizedNpcNames.
- Do NOT re-extract facts that are common knowledge or already obviously true.
- Focus on: permanent changes, new information, relationship shifts, acquisitions, losses, oaths, regime changes.
- If a slot is empty, output [] for that slot.`;
}

export type SealExtractionResult = {
    entries: DivergenceEntry[];
    chapterId: string;
};

export async function extractDivergencesAtSeal(
    provider: LLMProvider,
    chapterId: string,
    chapterTitle: string,
    chapterText: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[]
): Promise<SealExtractionResult> {
    const prompt = buildSealExtractionPrompt(chapterText, chapterTitle, sceneIds, npcLedger);

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 1500 });
        const cleaned = stripReasoning(raw);
        const jsonStr = extractJson(cleaned);

        let parsed: Record<string, unknown[]>;
        try {
            parsed = JSON.parse(jsonStr);
        } catch {
            console.warn('[DivergenceRegister] Seal extraction JSON parse failed');
            return { entries: [], chapterId };
        }

        const entries: DivergenceEntry[] = [];
        const sceneSet = new Set(sceneIds);
        const fallbackScene = sceneIds[0] ?? '000';
        const npcNameMap = new Map<string, string>();
        for (const npc of npcLedger) {
            npcNameMap.set(npc.name.toLowerCase(), npc.id);
            if (npc.aliases) {
                for (const alias of npc.aliases.split(',')) {
                    npcNameMap.set(alias.trim().toLowerCase(), npc.id);
                }
            }
        }

        for (const category of DIVERGENCE_CATEGORIES) {
            const slotArr = parsed[category];
            if (!Array.isArray(slotArr)) continue;

            for (const item of slotArr) {
                if (!item || typeof item !== 'object') continue;
                const rawItem = item as Record<string, unknown>;
                const text = typeof rawItem.text === 'string' ? rawItem.text.trim() : '';
                if (!text) continue;

                const sceneRef = typeof rawItem.sceneRef === 'string' && sceneSet.has(rawItem.sceneRef)
                    ? rawItem.sceneRef
                    : fallbackScene;

                const rawNpcIds: string[] = Array.isArray(rawItem.npcIds) ? rawItem.npcIds.filter((id): id is string => typeof id === 'string') : [];
                const resolvedNpcIds: string[] = [];
                const unrecognized: string[] = Array.isArray(rawItem.unrecognizedNpcNames)
                    ? rawItem.unrecognizedNpcNames.filter((n): n is string => typeof n === 'string')
                    : [];

                for (const id of rawNpcIds) {
                    if (npcNameMap.size > 0 && !npcNameMap.values().next().done) {
                        // If id doesn't match any ledger entry, mark as unrecognized
                        const found = npcLedger.some(n => n.id === id);
                        if (found) {
                            resolvedNpcIds.push(id);
                        } else {
                            unrecognized.push(id);
                        }
                    } else {
                        resolvedNpcIds.push(id);
                    }
                }

                // Try to resolve unrecognized names against the ledger
                const stillUnrecognized: string[] = [];
                for (const name of unrecognized) {
                    const matched = npcNameMap.get(name.toLowerCase());
                    if (matched && !resolvedNpcIds.includes(matched)) {
                        resolvedNpcIds.push(matched);
                    } else {
                        stillUnrecognized.push(name);
                    }
                }

                const hasReviewFlag = stillUnrecognized.length > 0;

                entries.push({
                    id: `div_${uid()}`,
                    chapterId,
                    category: coerceCategory(category),
                    text,
                    sceneRef,
                    npcIds: resolvedNpcIds,
                    pinned: false,
                    source: 'auto',
                    reviewFlag: hasReviewFlag ? true : undefined,
                    unrecognizedNpcNames: stillUnrecognized.length > 0 ? stillUnrecognized : undefined,
                });
            }
        }

        console.log(`[DivergenceRegister] Seal extraction for ${chapterId}: ${entries.length} entries`);
        return { entries, chapterId };
    } catch (err) {
        console.warn('[DivergenceRegister] Seal extraction failed:', err);
        return { entries: [], chapterId };
    }
}

export function mergeSealEntries(
    register: DivergenceRegister,
    newEntries: DivergenceEntry[],
    sceneId: string
): DivergenceRegister {
    if (newEntries.length === 0) return register;

    const entries = [...register.entries, ...newEntries];

    return {
        entries,
        chapterToggles: register.chapterToggles,
        categoryToggles: register.categoryToggles,
        lastUpdatedSceneId: sceneId,
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}

export function renderRegisterForPayload(
    register: DivergenceRegister,
    chapters?: ArchiveChapter[]
): string {
    if (register.entries.length === 0) return '';

    const chapterTitleMap = new Map<string, string>();
    if (chapters) {
        for (const ch of chapters) {
            chapterTitleMap.set(ch.chapterId, ch.title);
        }
    }

    const activeEntries = register.entries.filter(e => {
        if (e.enabled === false) return false;
        if (e.pinned) return true;
        const chapterOn = register.chapterToggles[e.chapterId] !== false;
        if (!chapterOn) return false;
        const catToggles = register.categoryToggles[e.chapterId];
        if (catToggles && catToggles[e.category] === false) return false;
        return true;
    });

    if (activeEntries.length === 0) return '';

    const byChapter = new Map<string, DivergenceEntry[]>();
    for (const e of activeEntries) {
        if (!byChapter.has(e.chapterId)) byChapter.set(e.chapterId, []);
        byChapter.get(e.chapterId)!.push(e);
    }

    const sections: string[] = [];

    for (const [chapterId, chapterEntries] of byChapter) {
        const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
        const byCategory = new Map<DivergenceCategory, DivergenceEntry[]>();
        for (const e of chapterEntries) {
            if (!byCategory.has(e.category)) byCategory.set(e.category, []);
            byCategory.get(e.category)!.push(e);
        }

        const catSections: string[] = [];
        for (const [cat, entries] of byCategory) {
            const label = CATEGORY_LABELS[cat] ?? cat.toUpperCase();
            const lines = entries.map(e => {
                const pin = e.pinned ? ' ★' : '';
                const manual = e.source === 'manual' ? ' ⚡' : '';
                return `• ${e.text}${pin}${manual}`;
            });
            catSections.push(`${label}:\n${lines.join('\n')}`);
        }

        sections.push(`${title}:\n${catSections.join('\n\n')}`);
    }

    const pinnedCount = register.entries.filter(e => e.pinned).length;
    const banner = `${activeEntries.length} active facts across ${byChapter.size} chapters${pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}`;

    return `[ESTABLISHED FACTS]\n[${banner}]\nThese facts are TRUE in this campaign.\n\n${sections.join('\n\n')}\n[END ESTABLISHED FACTS]`;
}

export function countRegisterTokens(register: DivergenceRegister): number {
    return countTokens(renderRegisterForPayload(register));
}

export function getDivergenceSceneIds(register: DivergenceRegister): Set<string> {
    const ids = new Set<string>();
    for (const e of register.entries) {
        ids.add(e.sceneRef);
    }
    return ids;
}

export function toggleChapter(register: DivergenceRegister, chapterId: string, on: boolean): DivergenceRegister {
    return {
        ...register,
        chapterToggles: { ...register.chapterToggles, [chapterId]: on },
        lastUpdatedAt: Date.now(),
    };
}

export function toggleCategory(register: DivergenceRegister, chapterId: string, category: DivergenceCategory, on: boolean): DivergenceRegister {
    const existing = register.categoryToggles[chapterId] ?? {};
    return {
        ...register,
        categoryToggles: {
            ...register.categoryToggles,
            [chapterId]: { ...existing, [category]: on },
        },
        lastUpdatedAt: Date.now(),
    };
}

export function pinFact(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, pinned: !e.pinned } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function editFact(register: DivergenceRegister, entryId: string, text: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, text, source: 'manual' as const } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function deleteFact(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.filter(e => e.id !== entryId);
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function deleteChapter(register: DivergenceRegister, chapterId: string): DivergenceRegister {
    const entries = register.entries.filter(e => e.chapterId !== chapterId);
    const { [chapterId]: _c, ...chapterToggles } = register.chapterToggles;
    const { [chapterId]: _ct, ...categoryToggles } = register.categoryToggles;
    return { ...register, entries, chapterToggles, categoryToggles, lastUpdatedAt: Date.now() };
}

export function toggleFact(register: DivergenceRegister, entryId: string, on: boolean): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, enabled: on } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function dismissReviewFlag(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, reviewFlag: undefined, unrecognizedNpcNames: undefined } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function getEntriesForChapter(register: DivergenceRegister, chapterId: string): DivergenceEntry[] {
    return register.entries.filter(e => e.chapterId === chapterId);
}

export function getEntriesForNpc(register: DivergenceRegister, npcId: string): DivergenceEntry[] {
    return register.entries.filter(e => e.npcIds.includes(npcId));
}

export function migrateV1ToV2(v1: { entries: unknown[]; prunedLog?: unknown[]; lastUpdatedSceneId?: string; lastUpdatedAt?: number; version?: number }): DivergenceRegister {
    console.log('[DivergenceRegister] Migrating v1 register to v2 — wiping all entries');
    toast.info('Divergence register redesigned. Existing entries cleared. New facts will be extracted at chapter seal.');
    return {
        entries: [],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: v1.lastUpdatedSceneId ?? '',
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}