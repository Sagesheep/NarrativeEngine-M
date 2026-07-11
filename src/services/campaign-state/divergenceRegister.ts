import type { DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveChapter, NPCEntry } from '../../types';
import { countTokens } from '../infrastructure';
import { notify } from '../ports/notify';

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
    chapters?: ArchiveChapter[],
    onStageNpcIds?: string[],
    npcLedger?: NPCEntry[],
    publicOnly = false,
): string {
    if (register.entries.length === 0) return '';

    const chapterTitleMap = new Map<string, string>();
    if (chapters) {
        for (const ch of chapters) {
            chapterTitleMap.set(ch.chapterId, ch.title);
        }
    }

    const activeEntries = register.entries.filter(e => {
        // Cached-canon path renders ONLY public facts. Scoped facts (knownBy defined,
        // incl. pinned ones) are withheld from the cache and surfaced in the per-turn
        // [FACTS KNOWN TO ON-STAGE CHARACTERS] block instead. "Is knownBy defined" is a
        // static fact property → cast-independent → cache-safe (SAFETY RAIL holds).
        if (publicOnly && e.knownBy !== undefined) return false;
        if (e.enabled === false) return false;
        if (e.pinned) return true;
        const chapterOn = register.chapterToggles[e.chapterId] !== false;
        if (!chapterOn) return false;
        const catToggles = register.categoryToggles[e.chapterId];
        if (catToggles && catToggles[e.category] === false) return false;
        return true;
    });

    if (activeEntries.length === 0) return '';

    const onStageSet = new Set(onStageNpcIds ?? []);
    const offStageSet = new Set<string>();
    if (npcLedger && onStageSet.size > 0) {
        for (const n of npcLedger) {
            if (!onStageSet.has(n.id)) {
                offStageSet.add(n.id);
            }
        }
    }

    const byChapter = new Map<string, DivergenceEntry[]>();
    for (const e of activeEntries) {
        if (!byChapter.has(e.chapterId)) byChapter.set(e.chapterId, []);
        byChapter.get(e.chapterId)!.push(e);
    }

    const renderEntries = (entries: DivergenceEntry[]): string => {
        const byCategory = new Map<DivergenceCategory, DivergenceEntry[]>();
        for (const e of entries) {
            if (!byCategory.has(e.category)) byCategory.set(e.category, []);
            byCategory.get(e.category)!.push(e);
        }

        const catSections: string[] = [];
        for (const [cat, catEntries] of byCategory) {
            const label = CATEGORY_LABELS[cat] ?? cat.toUpperCase();
            const lines = catEntries.map(e => {
                const pin = e.pinned ? ' ★' : '';
                const manual = e.source === 'manual' ? ' ⚡' : '';
                return `• ${e.text}${pin}${manual}`;
            });
            catSections.push(`${label}:\n${lines.join('\n')}`);
        }
        return catSections.join('\n\n');
    };

    // If no on-stage partition or no off-stage NPCs, render as before (single block)
    if (onStageSet.size === 0 || offStageSet.size === 0) {
        const sections: string[] = [];
        for (const [chapterId, chapterEntries] of byChapter) {
            const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
            sections.push(`${title}:\n${renderEntries(chapterEntries)}`);
        }
        const pinnedCount = register.entries.filter(e => e.pinned).length;
        const banner = `${activeEntries.length} active facts across ${byChapter.size} chapters${pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}`;
        return `[ESTABLISHED FACTS]\n[${banner}]\nThese facts are TRUE in this campaign.\n\n${sections.join('\n\n')}\n[END ESTABLISHED FACTS]`;
    }

    // ── Partitioned rendering ──
    // On-stage NPCs: see all facts (knownBy undefined = broadcast, always included)
    // Off-stage NPCs: only see facts where knownBy is undefined (broadcast) OR knownBy includes them
    const onStageEntries = activeEntries;
    const offStageEntries = activeEntries.filter(e => {
        if (e.knownBy === undefined) return true; // broadcast
        return e.knownBy.some(id => offStageSet.has(id));
    });

    const sections: string[] = [];
    for (const [chapterId, chapterEntries] of byChapter) {
        const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
        sections.push(`${title}:\n${renderEntries(chapterEntries)}`);
    }
    const pinnedCount = register.entries.filter(e => e.pinned).length;
    const banner = `${activeEntries.length} active facts across ${byChapter.size} chapters${pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}`;

    // If off-stage is the same as full list, no partitioning needed
    if (offStageEntries.length === activeEntries.length) {
        return `[ESTABLISHED FACTS]\n[${banner}]\nThese facts are TRUE in this campaign.\n\n${sections.join('\n\n')}\n[END ESTABLISHED FACTS]`;
    }

    // Partitioned: separate blocks
    const onStageSections: string[] = [];
    const onStageByChapter = new Map<string, DivergenceEntry[]>();
    for (const e of onStageEntries) {
        if (!onStageByChapter.has(e.chapterId)) onStageByChapter.set(e.chapterId, []);
        onStageByChapter.get(e.chapterId)!.push(e);
    }
    for (const [chapterId, chapterEntries] of onStageByChapter) {
        const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
        onStageSections.push(`${title}:\n${renderEntries(chapterEntries)}`);
    }

    const offStageSections: string[] = [];
    const offStageByChapter = new Map<string, DivergenceEntry[]>();
    for (const e of offStageEntries) {
        if (!offStageByChapter.has(e.chapterId)) offStageByChapter.set(e.chapterId, []);
        offStageByChapter.get(e.chapterId)!.push(e);
    }
    for (const [chapterId, chapterEntries] of offStageByChapter) {
        const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
        offStageSections.push(`${title}:\n${renderEntries(chapterEntries)}`);
    }

    const onStageBanner = `${onStageEntries.length} facts (on-stage view · all)`;
    const offStageBanner = `${offStageEntries.length} facts (off-stage view · bounded)`;

    return `[ESTABLISHED FACTS — ON-STAGE]\n[${onStageBanner}]\n${onStageSections.join('\n\n')}\n[END ON-STAGE FACTS]\n\n[ESTABLISHED FACTS — OFF-STAGE]\n[${offStageBanner}]\n${offStageSections.join('\n\n')}\n[END OFF-STAGE FACTS]`;
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

/**
 * WO3 — set the knownBy list on a divergence entry immutably.
 * knownBy: undefined = public/broadcast, [] = secret, ["npc:x","player",...] = scoped.
 * Mirrors editFact's shape. Caller is responsible for token grammar.
 */
export function editKnownBy(register: DivergenceRegister, entryId: string, knownBy: string[] | undefined): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, knownBy } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

/**
 * WO4 — apply subjectToken updates to a batch of entries immutably.
 * Only subjectToken changes; enabled/pinned/text/etc are untouched (never disables/deletes).
 */
export function applySubjectTokens(register: DivergenceRegister, updates: Array<{ id: string; subjectToken: string }>): DivergenceRegister {
    const updateMap = new Map(updates.map(u => [u.id, u.subjectToken]));
    const entries = register.entries.map(e =>
        updateMap.has(e.id) ? { ...e, subjectToken: updateMap.get(e.id) } : e
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
    notify.info('Divergence register redesigned. Existing entries cleared. New facts will be extracted at chapter seal.');
    return {
        entries: [],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: v1.lastUpdatedSceneId ?? '',
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}