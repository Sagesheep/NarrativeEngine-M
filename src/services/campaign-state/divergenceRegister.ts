import type { DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveChapter, NPCEntry, PromiseOutcome } from '../../types';
import { countTokens } from '../infrastructure';
import { notify } from '../ports/notify';
import { compareSceneRef } from './knowledgeScope';

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

/**
 * State slots: `<kind>:<slug>:<attribute>`, each naming something with exactly one
 * current value. A new fact in a slot replaces the slot's current fact, so the
 * vocabulary stays closed — free-form attributes would let cumulative facts
 * ("Mira's secrets") overwrite each other.
 */
export const STATE_KEY_KINDS = ['item', 'npc', 'place', 'debt', 'faction', 'quest'] as const;
// `attitude` (npc): how that NPC currently feels about / treats the party.
// `standing` (faction, place): the party's current standing there. Both turn a
// lasting "event" ("Mitsuru now trusts Minato") into state the next value replaces.
export const STATE_KEY_ATTRIBUTES = ['holder', 'location', 'status', 'allegiance', 'controller', 'leader', 'condition', 'role', 'attitude', 'standing'] as const;
const STATE_KEY_RE = new RegExp(`^(?:${STATE_KEY_KINDS.join('|')}):[a-z0-9][a-z0-9_-]*:(?:${STATE_KEY_ATTRIBUTES.join('|')})$`);

/** Lowercase + trim an LLM-emitted key; undefined unless it is then a valid slot. */
export function normalizeStateKey(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const key = value.trim().toLowerCase();
    return isValidStateKey(key) ? key : undefined;
}

export function isValidStateKey(value: unknown): value is string {
    return typeof value === 'string' && STATE_KEY_RE.test(value);
}

/** Missing lifecycle data is the backward-compatible active state for old campaigns. */
export function isFactActive(entry: DivergenceEntry): boolean {
    return entry.status !== 'superseded' && entry.status !== 'retracted' && entry.status !== 'resolved';
}

/**
 * Seal merge with state replacement. A new fact carrying a valid `stateKey`
 * becomes that slot's current value: every older active, unpinned fact in the
 * same slot is marked superseded (kept for history, no longer sent to the GM).
 * The latest sceneRef wins — within a batch and against the register, so
 * re-sealing an old chapter cannot overwrite a newer value. Facts without a stateKey are
 * additive. `supersedesFactId` is accepted for older extractor output but no
 * longer needed — the slot alone decides. `mergeSealEntries` stays append-only
 * for callers that never supersede (NPC avoidance facts).
 */
export function mergeLifecycleEntries(
    register: DivergenceRegister,
    newEntries: DivergenceEntry[],
    sceneId: string,
): DivergenceRegister {
    if (newEntries.length === 0) return register;

    const entries = [...register.entries];
    const ordered = newEntries
        .map((e, i) => ({ e, i }))
        .sort((a, b) => compareSceneRef(a.e.sceneRef, b.e.sceneRef) || a.i - b.i)
        .map(x => x.e);
    for (const extracted of ordered) {
        // An extraction instruction, not persistent campaign data.
        const { supersedesFactId: _legacy, ...entry } = extracted;
        let nextEntry: DivergenceEntry = { ...entry, status: 'active' };
        if (isValidStateKey(nextEntry.stateKey)) {
            // A re-sealed older chapter must not overwrite a newer value: if the slot
            // already holds a later fact, the incoming one arrives as history.
            const newer = entries.find(e => e.stateKey === nextEntry.stateKey && isFactActive(e)
                && compareSceneRef(e.sceneRef, nextEntry.sceneRef) > 0);
            if (newer) nextEntry = { ...nextEntry, status: 'superseded', supersededBy: newer.id };
            else supersedeSlot(entries, nextEntry.stateKey, nextEntry.id);
        }
        entries.push(nextEntry);
    }

    return {
        entries,
        chapterToggles: register.chapterToggles,
        categoryToggles: register.categoryToggles,
        lastUpdatedSceneId: sceneId,
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}

/** Mark every active, unpinned fact in `stateKey` superseded by `byId` (mutates the array). */
function supersedeSlot(entries: DivergenceEntry[], stateKey: string, byId: string): number {
    let count = 0;
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.stateKey === stateKey && e.id !== byId && isFactActive(e) && !e.pinned) {
            entries[i] = { ...e, status: 'superseded', supersededBy: byId };
            count++;
        }
    }
    return count;
}

/**
 * Migration: apply stateKey assignments to existing facts, then collapse every
 * slot to its newest fact (by sceneRef). Older facts become superseded — never
 * deleted, and restorable from the Knowledge tab.
 */
export function applyStateKeys(
    register: DivergenceRegister,
    updates: Array<{ id: string; stateKey: string }>,
): { register: DivergenceRegister; keyed: number; superseded: number } {
    const keyMap = new Map(updates.filter(u => isValidStateKey(u.stateKey)).map(u => [u.id, u.stateKey]));
    const entries = register.entries.map(e => keyMap.has(e.id) ? { ...e, stateKey: keyMap.get(e.id) } : e);

    const superseded = collapseSlots(entries);

    return {
        register: { ...register, entries, lastUpdatedAt: Date.now() },
        keyed: keyMap.size,
        superseded,
    };
}

/** Collapse each slot (all slots, or only `slots`) to its newest active, unpinned fact (mutates the array). */
function collapseSlots(entries: DivergenceEntry[], slots?: Set<string>): number {
    const newestBySlot = new Map<string, DivergenceEntry>();
    for (const e of entries) {
        if (!isValidStateKey(e.stateKey) || !isFactActive(e) || e.pinned) continue;
        if (slots && !slots.has(e.stateKey)) continue;
        const cur = newestBySlot.get(e.stateKey);
        if (!cur || compareSceneRef(e.sceneRef, cur.sceneRef) >= 0) newestBySlot.set(e.stateKey, e);
    }
    let superseded = 0;
    for (const [slot, newest] of newestBySlot) superseded += supersedeSlot(entries, slot, newest.id);
    return superseded;
}

/**
 * Drop auto-extracted facts matching `shouldRemove`; manual (user-edited) and
 * pinned facts always stay. Facts a dropped fact had superseded become active
 * again, then each touched slot collapses back to its newest fact — so removing
 * a chapter's or a rolled-back scene's writes restores the state before them.
 */
export function removeAutoFacts(
    register: DivergenceRegister,
    shouldRemove: (entry: DivergenceEntry) => boolean,
): { register: DivergenceRegister; removed: number } {
    const removedIds = new Set(register.entries
        .filter(e => e.source === 'auto' && !e.pinned && shouldRemove(e))
        .map(e => e.id));
    if (removedIds.size === 0) return { register, removed: 0 };

    const touchedSlots = new Set<string>();
    const entries = register.entries
        .filter(e => !removedIds.has(e.id))
        .map(e => {
            if (!e.supersededBy || !removedIds.has(e.supersededBy)) return e;
            const { supersededBy: _by, ...rest } = e;
            if (isValidStateKey(e.stateKey)) touchedSlots.add(e.stateKey);
            return { ...rest, status: 'active' as const };
        });
    collapseSlots(entries, touchedSlots);

    return {
        register: { ...register, entries, lastUpdatedAt: Date.now() },
        removed: removedIds.size,
    };
}

/**
 * (Re-)seal merge for one chapter: its previous auto facts are replaced by the
 * fresh extraction instead of piling up next to it. An empty extraction leaves
 * the register untouched — a failed parse must not wipe a chapter's facts.
 */
export function replaceChapterFacts(
    register: DivergenceRegister,
    chapterId: string,
    newEntries: DivergenceEntry[],
    sceneId: string,
): DivergenceRegister {
    if (newEntries.length === 0) return register;
    // Promises this chapter's previous seal closed reopen; the fresh seal re-closes them.
    const reopened = reopenResolved(register, e => e.resolvedIn === chapterId);
    const { register: cleared } = removeAutoFacts(reopened, e => e.chapterId === chapterId);
    return mergeLifecycleEntries(cleared, dropRepeatedFacts(cleared, newEntries), sceneId);
}

/** Lowercased words only — "Kotone owes custard." and "kotone owes custard" match. */
function factFingerprint(e: DivergenceEntry): string {
    return `${e.category}|${e.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`;
}

/**
 * New facts that repeat an active fact (same category, same words) or an earlier
 * fact of the same batch are dropped — the extractor re-emits open promises.
 * Slot facts always pass: restating a value in its slot is how it stays current.
 */
function dropRepeatedFacts(register: DivergenceRegister, newEntries: DivergenceEntry[]): DivergenceEntry[] {
    const seen = new Set(register.entries.filter(isFactActive).map(factFingerprint));
    return newEntries.filter(e => {
        if (isValidStateKey(e.stateKey)) return true;
        const fp = factFingerprint(e);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
    });
}

export type PromiseClosure = { factId: string; outcome: PromiseOutcome; sceneRef?: string };

/**
 * Close promises/debts: they become 'resolved' (history, no longer sent to the
 * GM, reopenable). Only active promises_debts facts can close; unknown ids and
 * other categories are ignored. `chapterId` records which seal closed them.
 */
export function resolvePromises(
    register: DivergenceRegister,
    closures: PromiseClosure[],
    chapterId?: string,
): { register: DivergenceRegister; resolved: number } {
    const byId = new Map(closures.map(c => [c.factId, c]));
    let resolved = 0;
    const entries = register.entries.map(e => {
        const c = byId.get(e.id);
        if (!c || e.category !== 'promises_debts' || !isFactActive(e)) return e;
        resolved++;
        return {
            ...e, status: 'resolved' as const, resolution: c.outcome,
            ...(c.sceneRef ? { resolvedAt: c.sceneRef } : {}),
            ...(chapterId ? { resolvedIn: chapterId } : {}),
        };
    });
    if (resolved === 0) return { register, resolved };
    return { register: { ...register, entries, lastUpdatedAt: Date.now() }, resolved };
}

/**
 * Mark repeats of a fact as superseded by the original (kept, restorable). Both
 * must be active; a pair pointing at itself or at a missing fact is ignored.
 */
export function supersedeDuplicates(
    register: DivergenceRegister,
    pairs: Array<{ id: string; of: string }>,
): { register: DivergenceRegister; superseded: number } {
    const active = new Set(register.entries.filter(isFactActive).map(e => e.id));
    const dupOf = new Map(pairs.filter(p => p.id !== p.of && active.has(p.id) && active.has(p.of)).map(p => [p.id, p.of]));
    // Never let two facts mark each other: the first pair wins.
    for (const [id, of] of dupOf) if (dupOf.get(of) === id) dupOf.delete(of);
    if (dupOf.size === 0) return { register, superseded: 0 };
    const entries = register.entries.map(e => {
        const of = dupOf.get(e.id);
        return of ? { ...e, status: 'superseded' as const, supersededBy: of } : e;
    });
    return { register: { ...register, entries, lastUpdatedAt: Date.now() }, superseded: dupOf.size };
}

/** Reopen resolved promises matching `shouldReopen` (re-seal / rollback of the closing chapter). */
function reopenResolved(register: DivergenceRegister, shouldReopen: (e: DivergenceEntry) => boolean): DivergenceRegister {
    let changed = false;
    const entries = register.entries.map(e => {
        if (e.status !== 'resolved' || !shouldReopen(e)) return e;
        changed = true;
        return clearLifecycle(e);
    });
    return changed ? { ...register, entries, lastUpdatedAt: Date.now() } : register;
}

/** The fact back to plain active: no supersession, no resolution. */
function clearLifecycle(e: DivergenceEntry): DivergenceEntry {
    const { supersededBy: _by, resolution: _r, resolvedAt: _at, resolvedIn: _in, ...rest } = e;
    return { ...rest, status: 'active' };
}

/**
 * Always-on block (design #2). Sent every turn: current state (slot facts), open
 * promises, rules & lore, pinned and hand-written facts. Every other loose fact —
 * events, party/world/location notes — only while it is recent; older ones stay in
 * the register as history and reach the GM through chapter recaps and archive recall.
 */
export const RECENT_EVENT_CHAPTERS = 2;
const ALWAYS_ON_CATEGORIES: ReadonlySet<DivergenceCategory> = new Set(['promises_debts', 'rules_lore']);

/**
 * First scene of the recent window: the start of the `n`-th newest sealed chapter.
 * Facts at or after it count as recent (the open chapter's arc facts included).
 * undefined (no sealed chapter yet) = everything is recent.
 */
export function recentWindowStart(chapters: ArchiveChapter[] | undefined, n = RECENT_EVENT_CHAPTERS): string | undefined {
    const sealed = (chapters ?? [])
        .filter(c => c.sealedAt)
        .sort((a, b) => compareSceneRef(b.sceneRange[1], a.sceneRange[1]));
    if (sealed.length < n) return undefined;
    return sealed[n - 1].sceneRange[0];
}

/** True when the fact belongs in the always-on block (see RECENT_EVENT_CHAPTERS). */
export function isAlwaysOn(e: DivergenceEntry, windowStart: string | undefined): boolean {
    if (windowStart === undefined) return true;
    if (e.pinned || e.source === 'manual' || isValidStateKey(e.stateKey)) return true;
    if (ALWAYS_ON_CATEGORIES.has(e.category)) return true;
    return compareSceneRef(e.sceneRef, windowStart) >= 0;
}

/**
 * Chapter merge/split: move every fact of `fromId` to the chapter `assign` picks
 * for it, carrying the chapter's toggles along. Without this a merged-away or
 * split chapter's facts point at an id that no longer exists.
 */
export function relabelChapterFacts(
    register: DivergenceRegister,
    fromId: string,
    assign: (entry: DivergenceEntry) => string,
): DivergenceRegister {
    const targets = new Set<string>();
    const entries = register.entries.map(e => {
        if (e.chapterId !== fromId) return e;
        const to = assign(e);
        targets.add(to);
        return to === fromId ? e : { ...e, chapterId: to };
    });
    if (targets.size === 0) return register;

    const chapterToggles = { ...register.chapterToggles };
    const categoryToggles = { ...register.categoryToggles };
    for (const to of targets) {
        if (fromId in chapterToggles && !(to in chapterToggles)) chapterToggles[to] = chapterToggles[fromId];
        if (fromId in categoryToggles && !(to in categoryToggles)) categoryToggles[to] = categoryToggles[fromId];
    }
    if (!targets.has(fromId)) {
        delete chapterToggles[fromId];
        delete categoryToggles[fromId];
    }
    return { ...register, entries, chapterToggles, categoryToggles, lastUpdatedAt: Date.now() };
}

/** Rollback: drop auto facts that came from deleted scenes (sceneRef >= fromSceneId). */
export function removeFactsFromScene(register: DivergenceRegister, fromSceneId: string): { register: DivergenceRegister; removed: number } {
    // A promise closed in a deleted scene was never closed.
    const reopened = reopenResolved(register, e => e.resolvedAt !== undefined && compareSceneRef(e.resolvedAt, fromSceneId) >= 0);
    const result = removeAutoFacts(reopened, e => compareSceneRef(e.sceneRef, fromSceneId) >= 0);
    return { register: result.removed > 0 ? result.register : reopened, removed: result.removed };
}

/** Undo a supersession or a closed promise: the fact becomes active again (a replacement stays active too). */
export function restoreFact(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.map(e => e.id === entryId ? clearLifecycle(e) : e);
    return { ...register, entries, lastUpdatedAt: Date.now() };
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
    /** Send only the always-on block (isAlwaysOn); older loose facts become history. */
    alwaysOn = false,
): string {
    if (register.entries.length === 0) return '';

    const chapterTitleMap = new Map<string, string>();
    if (chapters) {
        for (const ch of chapters) {
            chapterTitleMap.set(ch.chapterId, ch.title);
        }
    }

    const windowStart = alwaysOn ? recentWindowStart(chapters) : undefined;
    let historyCount = 0;
    const activeEntries = register.entries.filter(e => {
        // Cached-canon path renders ONLY public facts. Scoped facts (knownBy defined,
        // incl. pinned ones) are withheld from the cache and surfaced in the per-turn
        // [FACTS KNOWN TO ON-STAGE CHARACTERS] block instead. "Is knownBy defined" is a
        // static fact property → cast-independent → cache-safe (SAFETY RAIL holds).
        if (publicOnly && e.knownBy !== undefined) return false;
        if (e.enabled === false) return false;
        if (!isFactActive(e)) return false;
        if (e.pinned) return true;
        const chapterOn = register.chapterToggles[e.chapterId] !== false;
        if (!chapterOn) return false;
        const catToggles = register.categoryToggles[e.chapterId];
        if (catToggles && catToggles[e.category] === false) return false;
        if (!isAlwaysOn(e, windowStart)) { historyCount++; return false; }
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

    // Slot facts render first as one CURRENT STATE list (sorted by slot so a
    // subject's slots sit together), then OPEN PROMISES (still owed, oldest first);
    // everything else stays grouped by chapter.
    const bullet = (e: DivergenceEntry) => `• ${e.text}${e.pinned ? ' ★' : ''}${e.source === 'manual' ? ' ⚡' : ''}`;
    const renderBody = (entries: DivergenceEntry[]): string => {
        const keyed = entries.filter(e => isValidStateKey(e.stateKey))
            .sort((a, b) => (a.stateKey! < b.stateKey! ? -1 : a.stateKey! > b.stateKey! ? 1 : 0));
        const promises = entries.filter(e => !isValidStateKey(e.stateKey) && e.category === 'promises_debts')
            .sort((a, b) => compareSceneRef(a.sceneRef, b.sceneRef));
        const loose = new Map<string, DivergenceEntry[]>();
        for (const e of entries) {
            if (isValidStateKey(e.stateKey) || e.category === 'promises_debts') continue;
            if (!loose.has(e.chapterId)) loose.set(e.chapterId, []);
            loose.get(e.chapterId)!.push(e);
        }
        const sections: string[] = [];
        if (keyed.length > 0) sections.push(`CURRENT STATE:\n${keyed.map(bullet).join('\n')}`);
        if (promises.length > 0) sections.push(`OPEN PROMISES & DEBTS (still owed):\n${promises.map(bullet).join('\n')}`);
        for (const [chapterId, chapterEntries] of loose) {
            const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
            sections.push(`${title}:\n${renderEntries(chapterEntries)}`);
        }
        return sections.join('\n\n');
    };

    // Older events held back from the always-on block are not lost — say where they are.
    const historyNote = historyCount > 0 ? ` · ${historyCount} older events in chapter recaps/archive` : '';

    // If no on-stage partition or no off-stage NPCs, render as before (single block)
    if (onStageSet.size === 0 || offStageSet.size === 0) {
        const pinnedCount = register.entries.filter(e => e.pinned).length;
        const banner = `${activeEntries.length} active facts across ${byChapter.size} chapters${pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}${historyNote}`;
        return `[ESTABLISHED FACTS]\n[${banner}]\nThese facts are TRUE in this campaign.\n\n${renderBody(activeEntries)}\n[END ESTABLISHED FACTS]`;
    }

    // ── Partitioned rendering ──
    // On-stage NPCs: see all facts (knownBy undefined = broadcast, always included)
    // Off-stage NPCs: only see facts where knownBy is undefined (broadcast) OR knownBy includes them
    const onStageEntries = activeEntries;
    const offStageEntries = activeEntries.filter(e => {
        if (e.knownBy === undefined) return true; // broadcast
        return e.knownBy.some(id => offStageSet.has(id));
    });

    const pinnedCount = register.entries.filter(e => e.pinned).length;
    const banner = `${activeEntries.length} active facts across ${byChapter.size} chapters${pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}${historyNote}`;

    // If off-stage is the same as full list, no partitioning needed
    if (offStageEntries.length === activeEntries.length) {
        return `[ESTABLISHED FACTS]\n[${banner}]\nThese facts are TRUE in this campaign.\n\n${renderBody(activeEntries)}\n[END ESTABLISHED FACTS]`;
    }

    // Partitioned: separate blocks
    const onStageBanner = `${onStageEntries.length} facts (on-stage view · all)`;
    const offStageBanner = `${offStageEntries.length} facts (off-stage view · bounded)`;

    return `[ESTABLISHED FACTS — ON-STAGE]\n[${onStageBanner}]\n${renderBody(onStageEntries)}\n[END ON-STAGE FACTS]\n\n[ESTABLISHED FACTS — OFF-STAGE]\n[${offStageBanner}]\n${renderBody(offStageEntries)}\n[END OFF-STAGE FACTS]`;
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