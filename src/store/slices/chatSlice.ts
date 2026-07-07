import type { StateCreator } from 'zustand';
import type { ChatMessage, CondenserState, GameContext, LoreCheckSelection, LoreCheckResult, DivergenceRegister, DivergenceEntry, DivergenceCategory, TopicClusters, PinnedExcerpt } from '../../types';
import { EMPTY_REGISTER, toggleChapter, toggleCategory, pinFact, editFact, deleteFact, deleteChapter, toggleFact, dismissReviewFlag, editKnownBy, applySubjectTokens, migrateV1ToV2 } from '../../services/campaign-state';
import { debouncedSaveCampaignState } from './campaignSlice';
import { countTokens } from '../../services/infrastructure';
import { uid } from '../../utils/uid';
import { imageStorage } from '../../services/storage/imageStorage';

// Re-export PinnedExcerpt from types for consumers that import from this slice
export type { PinnedExcerpt };

const PINNED_EXCERPTS_TOKEN_CAP = 3000;

// In debug mode every GM turn attaches a full `debugPayload` (the entire
// assembled prompt — hundreds of KB) to its message. The inline payload viewer
// only renders on the last ~visibleCount (10) bubbles, so payloads on older
// messages are invisible AND accumulate unbounded over a long session, rebuilding
// the same renderer-OOM baggage the persistence strip removed. Keep only the most
// recent N payloads in memory.
const DEBUG_PAYLOAD_RETENTION = 10;

// The divergence register persists to its own `divergence_<id>` key, separate from
// the campaign-state payload. UI-edit actions only debounce-saved campaign state
// (which omits the register), so manual MemoryTab edits were lost on reload.
function saveDivergence(campaignId: string | null, register: DivergenceRegister) {
    if (!campaignId) return;
    import('../../store/campaignStore')
        .then(m => m.saveDivergenceRegister(campaignId, register))
        .catch(e => console.error('Failed to save divergence register', e));
}

// The lore-check / rename selection is captured from the RENDERED bubble text,
// which has already had markdown stripped (bold/italic markers gone) and NPC name
// brackets removed ([**Aldric**] renders as "Aldric"). The stored message content
// still holds the raw markdown, so a literal `content.includes(selectedText)` misses
// whenever the selected span contains any formatting — the accepted rewrite then
// silently no-ops. locateRawSpan normalises the raw content the same way the renderer
// does (drop * _ ` # [ ] and collapse whitespace) while keeping an index map back to
// raw offsets, so we can find and splice the real span even when it was formatted.
const MD_MARKER = /[*_`[\]#]/;

function normalizeWithMap(raw: string): { norm: string; start: number[]; end: number[] } {
    const norm: string[] = [];
    const start: number[] = [];
    const end: number[] = [];
    let i = 0;
    while (i < raw.length) {
        const c = raw[i];
        if (/\s/.test(c)) {
            const runStart = i;
            while (i < raw.length && /\s/.test(raw[i])) i++;
            norm.push(' ');
            start.push(runStart);
            end.push(i);
            continue;
        }
        if (MD_MARKER.test(c)) { i++; continue; }
        norm.push(c);
        start.push(i);
        end.push(i + 1);
        i++;
    }
    return { norm: norm.join(''), start, end };
}

function normalizeLoose(s: string): string {
    return s.replace(/[*_`[\]#]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the raw [start, end) span in `raw` corresponding to `target`, tolerating the
 * markdown/bracket/whitespace differences introduced by rendering. Returns null if
 * the target can't be located even loosely (e.g. the text was already edited away).
 */
export function locateRawSpan(raw: string, target: string): { start: number; end: number } | null {
    const exact = raw.indexOf(target);
    if (exact !== -1) return { start: exact, end: exact + target.length };

    const targetNorm = normalizeLoose(target);
    if (!targetNorm) return null;

    const { norm, start, end } = normalizeWithMap(raw);
    const idx = norm.indexOf(targetNorm);
    if (idx === -1) return null;

    let s = start[idx];
    let e = end[idx + targetNorm.length - 1];
    // Swallow markdown markers that hug the span but were dropped during normalisation
    // (e.g. the leading "[**" of an NPC name), so they aren't orphaned after splicing.
    while (s > 0 && MD_MARKER.test(raw[s - 1])) s--;
    while (e < raw.length && MD_MARKER.test(raw[e])) e++;
    return { start: s, end: e };
}

// ── Slice type ─────────────────────────────────────────────────────────

export type ChatSlice = {
    messages: ChatMessage[];
    isStreaming: boolean;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateMessageContent: (id: string, content: string) => void;
    /** Smart Retry v1: patch a specific message by id with a partial update.
     *  Used to stamp/clear `retryable` and `precontext` on the terminal bubble
     *  from outside the orchestrator (delete/orphan-cleanup paths). Does NOT
     *  debounce-save — callers that need persistence should call saveCampaignState. */
    updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
    /** Returns true if the span was located and spliced; false if the original text could not be found. */
    replaceMessageText: (id: string, oldText: string, newText: string) => boolean;
    renameAcrossMessages: (from: string, to: string) => number;
    /**
     * First-name-only rename on the LATEST assistant message. Replaces the leading
     * token of `from` (e.g. "Pell" from "Pell Gravatt") with the leading token of
     * `to` in the most recent GM narration only. Whole-word, case-insensitive.
     * Returns 1 if the last assistant message was touched, 0 otherwise. Single-token
     * `from` (no surname) returns 0 — full-name tier already handles that case.
     */
    renameFirstNameInLatestAssistant: (from: string, to: string) => number;
    deleteMessage: (id: string) => void;
    deleteMessagesFrom: (id: string) => void;
    setStreaming: (v: boolean) => void;
    clearChat: () => void;
    clearArchive: () => void;

    condenser: CondenserState;
    setCondensed: (upToIndex: number) => void;
    setCondenser: (state: CondenserState) => void;
    resetCondenser: () => void;

    divergenceRegister: DivergenceRegister;
    setDivergenceRegister: (register: DivergenceRegister) => void;
    editDivergenceEntry: (id: string, patch: Partial<DivergenceEntry>) => void;
    updateMessageDivergence: (messageId: string, divergenceIds: string[]) => void;
    resetDivergenceRegister: () => void;
    confirmReviewEntry: (id: string) => void;
    deleteReviewedEntry: (id: string) => void;
    toggleDivergenceChapter: (chapterId: string, on: boolean) => void;
    toggleDivergenceCategory: (chapterId: string, category: DivergenceCategory, on: boolean) => void;
    pinDivergenceFact: (entryId: string) => void;
    editDivergenceFact: (entryId: string, text: string) => void;
    deleteDivergenceFact: (entryId: string) => void;
    dismissDivergenceReviewFlag: (entryId: string) => void;
    deleteDivergenceChapter: (chapterId: string) => void;
    toggleDivergenceFact: (entryId: string, on: boolean) => void;
    setManyFactsEnabled: (updates: Array<{ id: string; enabled: boolean }>) => void;
    editDivergenceKnownBy: (entryId: string, knownBy: string[] | undefined) => void;
    applySubjectTokens: (updates: Array<{ id: string; subjectToken: string }>) => void;
    setTopicClusters: (clusters: TopicClusters) => void;
    migrateDivergenceIfNeeded: () => void;

    pinnedExcerpts: PinnedExcerpt[];
    addPinnedExcerpt: (sourceMessageId: string, text: string, isFullMessage: boolean) => { ok: true } | { ok: false; reason: string };
    removePinnedExcerpt: (id: string) => void;
    clearPinnedExcerpts: () => void;

    loreCheckOpen: boolean;
    loreCheckLoading: boolean;
    loreCheckSelection: LoreCheckSelection | null;
    loreCheckResult: LoreCheckResult | null;
    loreCheckStatus: string;
    loreCheckError: string | null;
    openLoreCheck: (selection: LoreCheckSelection) => void;
    setLoreCheckStatus: (status: string) => void;
    setLoreCheckResult: (result: LoreCheckResult) => void;
    setLoreCheckError: (err: string) => void;
    closeLoreCheck: () => void;
    renameModalOpen: boolean;
    renameModalText: string;
    openRenameModal: (text: string) => void;
    closeRenameModal: () => void;
    // Loot Engine WO-05: pre-roll modal trigger (mirrors renameModalOpen).
    lootRollModalOpen: boolean;
    openLootRollModal: () => void;
    closeLootRollModal: () => void;
    setMessageImage: (messageId: string, image: ChatMessage['image']) => void;
};

// ── Cross-slice dependencies ───────────────────────────────────────────

type ChatDeps = ChatSlice & {
    activeCampaignId: string | null;
    context: GameContext;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createChatSlice: StateCreator<ChatDeps, [], [], ChatSlice> = (set) => ({
    // Condenser defaults
    condenser: {
        condensedUpToIndex: -1,
    },
    setCondensed: (upToIndex) =>
        set((s) => ({
            condenser: { ...s.condenser, condensedUpToIndex: upToIndex },
        })),
    setCondenser: (newState) => set({ condenser: newState }),
    resetCondenser: () =>
        set({ condenser: { condensedUpToIndex: -1 } } as Partial<ChatDeps>),

    divergenceRegister: { ...EMPTY_REGISTER },
    setDivergenceRegister: (register) =>
        set((s) => {
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, register);
            return { divergenceRegister: register };
        }),
    editDivergenceEntry: (id, patch) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e => {
                if (e.id !== id) return e;
                return { ...e, ...patch };
            });
            const reg = { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() };
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    updateMessageDivergence: (messageId, divergenceIds) =>
        set((s) => {
            const msgs = s.messages.map(m =>
                m.id === messageId ? { ...m, divergenceIds } : m
            );
            return { messages: msgs };
        }),
    resetDivergenceRegister: () =>
        set({ divergenceRegister: { ...EMPTY_REGISTER } } as Partial<ChatDeps>),
    confirmReviewEntry: (id) =>
        set((s) => {
            const reg = dismissReviewFlag(s.divergenceRegister, id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    deleteReviewedEntry: (id) =>
        set((s) => {
            const reg = deleteFact(s.divergenceRegister, id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    toggleDivergenceChapter: (chapterId, on) =>
        set((s) => {
            const reg = toggleChapter(s.divergenceRegister, chapterId, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    toggleDivergenceCategory: (chapterId, category, on) =>
        set((s) => {
            const reg = toggleCategory(s.divergenceRegister, chapterId, category, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    pinDivergenceFact: (entryId) =>
        set((s) => {
            const reg = pinFact(s.divergenceRegister, entryId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    editDivergenceFact: (entryId, text) =>
        set((s) => {
            const reg = editFact(s.divergenceRegister, entryId, text);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    deleteDivergenceFact: (entryId) =>
        set((s) => {
            let reg = deleteFact(s.divergenceRegister, entryId);
            if (reg.topicClusters) {
                const groups = reg.topicClusters.groups.map(g => ({
                    ...g,
                    factIds: g.factIds.filter(id => id !== entryId),
                })).filter(g => g.factIds.length > 0);
                reg = { ...reg, topicClusters: { ...reg.topicClusters, groups } };
            }
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    dismissDivergenceReviewFlag: (entryId) =>
        set((s) => {
            const reg = dismissReviewFlag(s.divergenceRegister, entryId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    deleteDivergenceChapter: (chapterId) =>
        set((s) => {
            const reg = deleteChapter(s.divergenceRegister, chapterId);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    toggleDivergenceFact: (entryId, on) =>
        set((s) => {
            const reg = toggleFact(s.divergenceRegister, entryId, on);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    setManyFactsEnabled: (updates) =>
        set((s) => {
            const updateMap = new Map(updates.map(u => [u.id, u.enabled]));
            let reg = s.divergenceRegister;
            for (const [id, on] of updateMap) {
                reg = toggleFact(reg, id, on);
            }
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    editDivergenceKnownBy: (entryId, knownBy) =>
        set((s) => {
            const reg = editKnownBy(s.divergenceRegister, entryId, knownBy);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    applySubjectTokens: (updates) =>
        set((s) => {
            const reg = applySubjectTokens(s.divergenceRegister, updates);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    setTopicClusters: (clusters) =>
        set((s) => {
            const reg = { ...s.divergenceRegister, topicClusters: clusters };
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            saveDivergence(s.activeCampaignId, reg);
            return { divergenceRegister: reg };
        }),
    migrateDivergenceIfNeeded: () =>
        set((s) => {
            const reg = s.divergenceRegister;
            if (reg.version < 2) {
                const migrated = migrateV1ToV2(reg as any);
                debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
                saveDivergence(s.activeCampaignId, migrated);
                return { divergenceRegister: migrated };
            }
            return s;
        }),

    // Chat defaults
    messages: [],
    isStreaming: false,
    addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
    updateLastAssistant: (content) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
                msgs[lastIdx] = { ...msgs[lastIdx], content };
            }
            return { messages: msgs };
        }),
    updateLastMessage: (patch) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0) {
                msgs[lastIdx] = { ...msgs[lastIdx], ...patch };
            }
            // Cap retained debug payloads so they don't accumulate unbounded.
            if (patch.debugPayload !== undefined) {
                const withPayload: number[] = [];
                for (let i = 0; i < msgs.length; i++) {
                    if (msgs[i].debugPayload !== undefined) withPayload.push(i);
                }
                for (let j = 0; j < withPayload.length - DEBUG_PAYLOAD_RETENTION; j++) {
                    const { debugPayload: _drop, ...rest } = msgs[withPayload[j]];
                    msgs[withPayload[j]] = rest;
                }
            }
            return { messages: msgs };
        }),
    updateMessageContent: (id, content) =>
        set((s) => {
            const msgs = s.messages.map(m => m.id === id ? { ...m, content } : m);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
    updateMessage: (id, patch) =>
        set((s) => {
            const idx = s.messages.findIndex(m => m.id === id);
            if (idx === -1) return { messages: s.messages };
            const msgs = [...s.messages];
            // Strip undefined fields so we "clear" rather than stamp `undefined`.
            const cleaned: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(patch)) {
                if (v === undefined) {
                    delete (msgs[idx] as Record<string, unknown>)[k];
                } else {
                    cleaned[k] = v;
                }
            }
            msgs[idx] = { ...msgs[idx], ...cleaned };
            return { messages: msgs };
        }),
    replaceMessageText: (id, oldText, newText) => {
        let applied = false;
        set((s) => {
            const msgs = s.messages.map(m => {
                if (m.id !== id) return m;
                const next = { ...m };
                if (typeof m.content === 'string') {
                    const span = locateRawSpan(m.content, oldText);
                    if (span) {
                        next.content = m.content.slice(0, span.start) + newText + m.content.slice(span.end);
                        applied = true;
                    }
                }
                if (typeof m.displayContent === 'string') {
                    const span = locateRawSpan(m.displayContent, oldText);
                    if (span) {
                        next.displayContent = m.displayContent.slice(0, span.start) + newText + m.displayContent.slice(span.end);
                        applied = true;
                    }
                }
                return next;
            });
            if (!applied) return {};
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        });
        return applied;
    },
    renameAcrossMessages: (from, to) => {
        const fromTrim = from.trim();
        if (!fromTrim || !to.trim()) return 0;
        // Whole-word, case-insensitive. \b sits before a trailing possessive so
        // "Elara's" → "<to>'s". Replacement keeps the user-typed casing verbatim.
        // Fresh regex per call; replace-and-compare avoids global-regex lastIndex bugs.
        const pat = `\\b${fromTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        let changed = 0;
        set((s) => {
            const msgs = s.messages.map(m => {
                const next = { ...m };
                let touched = false;
                if (typeof m.content === 'string') {
                    const rep = m.content.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.content) { next.content = rep; touched = true; }
                }
                if (typeof m.displayContent === 'string') {
                    const rep = m.displayContent.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.displayContent) { next.displayContent = rep; touched = true; }
                }
                if (touched) changed++;
                return next;
            });
            if (changed === 0) return {};
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        });
        return changed;
    },
    renameFirstNameInLatestAssistant: (from, to) => {
        const fromTrim = from.trim();
        const toTrim = to.trim();
        if (!fromTrim || !toTrim) return 0;
        const firstName = fromTrim.split(/\s+/)[0];
        const replacement = toTrim.split(/\s+/)[0];
        // Single-token `from` has no separate first-name tier — the full-name
        // pass (renameAcrossMessages) already covered it.
        if (!firstName || !replacement || fromTrim.split(/\s+/).length === 1) return 0;
        const pat = `\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        let changed = 0;
        set((s) => {
            // Find the LAST assistant message (not messages[length-1] — that may be
            // the scene-marker system message inserted by turnPostProcess).
            let lastIdx = -1;
            for (let i = s.messages.length - 1; i >= 0; i--) {
                if (s.messages[i].role === 'assistant') { lastIdx = i; break; }
            }
            if (lastIdx === -1) return {};
            const m = s.messages[lastIdx];
            const next = { ...m };
            let touched = false;
            if (typeof m.content === 'string') {
                const rep = m.content.replace(new RegExp(pat, 'gi'), replacement);
                if (rep !== m.content) { next.content = rep; touched = true; }
            }
            if (typeof m.displayContent === 'string') {
                const rep = m.displayContent.replace(new RegExp(pat, 'gi'), replacement);
                if (rep !== m.displayContent) { next.displayContent = rep; touched = true; }
            }
            if (!touched) return {};
            const msgs = s.messages.slice();
            msgs[lastIdx] = next;
            changed = 1;
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        });
        return changed;
    },
    deleteMessage: (id) =>
        set((s) => {
            const msgs = s.messages.filter(m => m.id !== id);
            if (s.activeCampaignId) imageStorage.delete(s.activeCampaignId, id).catch(() => {});
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
    deleteMessagesFrom: (id) =>
        set((s) => {
            const index = s.messages.findIndex(m => m.id === id);
            if (index === -1) return { messages: s.messages };
            const removed = s.messages.slice(index);
            if (s.activeCampaignId) {
                for (const m of removed) {
                    imageStorage.delete(s.activeCampaignId, m.id).catch(() => {});
                }
            }
            const msgs = s.messages.slice(0, index);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v } as Partial<ChatDeps>),
    clearChat: () => set((s) => {
        const newCondenser = { condensedUpToIndex: -1 };
        const newDivReg = { ...EMPTY_REGISTER };
        if (s.activeCampaignId) imageStorage.deleteAll(s.activeCampaignId).catch(() => {});
        debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: [], condenser: newCondenser, pinnedExcerpts: [] });
        return { messages: [], condenser: newCondenser, divergenceRegister: newDivReg, pinnedExcerpts: [] };
    }),
    clearArchive: () => set({ archiveIndex: [] } as unknown as Partial<ChatDeps>),

    // Pinned Excerpts
    pinnedExcerpts: [],
    addPinnedExcerpt: (sourceMessageId, text, isFullMessage) => {
        let result: { ok: true } | { ok: false; reason: string } = { ok: true };
        set((s) => {
            const newTokens = countTokens(text);
            const currentTotal = s.pinnedExcerpts.reduce((sum, e) => sum + countTokens(e.text), 0);
            if (currentTotal + newTokens > PINNED_EXCERPTS_TOKEN_CAP) {
                result = { ok: false, reason: 'Pinned memories full — unpin something first' };
                return s;
            }
            const excerpt: PinnedExcerpt = {
                id: `pin_${uid()}`,
                sourceMessageId,
                text,
                createdAt: Date.now(),
                isFullMessage,
            };
            const pinnedExcerpts = [...s.pinnedExcerpts, excerpt];
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts });
            return { pinnedExcerpts };
        });
        return result;
    },
    removePinnedExcerpt: (id) =>
        set((s) => {
            const pinnedExcerpts = s.pinnedExcerpts.filter(e => e.id !== id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts });
            return { pinnedExcerpts };
        }),
    clearPinnedExcerpts: () =>
        set((s) => {
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: [] });
            return { pinnedExcerpts: [] };
        }),

    loreCheckOpen: false,
    loreCheckLoading: false,
    loreCheckSelection: null,
    loreCheckResult: null,
    loreCheckStatus: '',
    loreCheckError: null,
    openLoreCheck: (selection) =>
        set({
            loreCheckOpen: true,
            loreCheckLoading: true,
            loreCheckSelection: selection,
            loreCheckResult: null,
            loreCheckStatus: 'Preparing...',
            loreCheckError: null,
        }),
    setLoreCheckStatus: (status) => set({ loreCheckStatus: status }),
    setLoreCheckResult: (result) =>
        set({ loreCheckResult: result, loreCheckLoading: false, loreCheckStatus: '' }),
    setLoreCheckError: (err) =>
        set({ loreCheckError: err, loreCheckLoading: false, loreCheckStatus: '' }),
    closeLoreCheck: () =>
        set({
            loreCheckOpen: false,
            loreCheckLoading: false,
            loreCheckSelection: null,
            loreCheckResult: null,
            loreCheckStatus: '',
            loreCheckError: null,
        }),
    renameModalOpen: false,
    renameModalText: '',
    openRenameModal: (text) => set({ renameModalOpen: true, renameModalText: text }),
    closeRenameModal: () => set({ renameModalOpen: false, renameModalText: '' }),
    lootRollModalOpen: false,
    openLootRollModal: () => set({ lootRollModalOpen: true }),
    closeLootRollModal: () => set({ lootRollModalOpen: false }),
    setMessageImage: (messageId, image) =>
        set((s) => {
            const msgs = s.messages.map(m =>
                m.id === messageId ? { ...m, image } : m
            );
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts });
            return { messages: msgs };
        }),
});
