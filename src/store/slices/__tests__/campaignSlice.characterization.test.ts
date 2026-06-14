/**
 * Phase 7.0 — Characterization tests for campaignSlice (+ the divergence actions
 * that live in chatSlice). These pin the CURRENT behavior of the unified store so
 * the Phase 7 split (npc/lore/archive slices + persistence/hydration extraction)
 * can be verified as behavior-preserving.
 *
 * Strategy: mock idb-keyval with an in-memory store and run the REAL campaignStore
 * + apiClient + embeddingStorage against it, so the actual persistence KEYS, the
 * defaultContext merge, the AI_PLAYER_CONTEXT_KEYS strip, NPC dedup, and the
 * divergence migration are all exercised end-to-end. Only the true leaf services
 * that need a browser/ONNX/network (embedding, the offlineStorage barrel, Toast,
 * themeService, crypto) are stubbed; api-backed loaders are steered via the
 * offlineStorage.* stubs they ultimately delegate to.
 *
 * NOTE FOR THE SPLIT: assertions in groups 1/2/3/5 must remain GREEN with identical
 * expectations after the refactor. Group 4 (divergence persistence) deliberately
 * pins a KNOWN BUG (UI-edit actions don't write `divergence_${id}`); the Phase 7
 * persistence fix will intentionally change that — see the it.todo + comments.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NPCEntry, DivergenceRegister, DivergenceEntry } from '../../../types';

// ── In-memory idb-keyval (the persistence backbone) ────────────────────────
const { idbStore, idbMock } = vi.hoisted(() => {
    const store = new Map<unknown, unknown>();
    const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
    return {
        idbStore: store,
        idbMock: {
            get: vi.fn(async (key: unknown) => clone(store.get(key))),
            set: vi.fn(async (key: unknown, value: unknown) => { store.set(key, clone(value)); }),
            del: vi.fn(async (key: unknown) => { store.delete(key); }),
            keys: vi.fn(async () => Array.from(store.keys())),
            entries: vi.fn(async () => Array.from(store.entries()).map(([k, v]) => [k, clone(v)])),
            update: vi.fn(async (key: unknown, fn: (old: unknown) => unknown) => { store.set(key, clone(fn(clone(store.get(key))))); }),
            clear: vi.fn(async () => { store.clear(); }),
        },
    };
});
vi.mock('idb-keyval', () => idbMock);

// ── Leaf service stubs ─────────────────────────────────────────────────────
vi.mock('../../../services/embedding', () => ({
    embedText: vi.fn(async () => new Float32Array([0.11, 0.22, 0.33])),
    getCurrentModelId: vi.fn(() => 'test-model'),
    warmupEmbedder: vi.fn(async () => {}),
    runFullReindex: vi.fn(async () => {}),
    abortForCampaignSwitch: vi.fn(),
}));

// NOTE: apiClient is intentionally NOT mocked. The api-backed loaders
// (loadChapters/loadSemanticFacts/loadTimeline/loadEntities) do a *concurrent*
// dynamic `import('../services/apiClient')` inside one Promise.all; mocking that
// module makes vitest's mock-vs-real resolution race (one loader gets the mock,
// another transiently gets the real module). Instead we run the REAL apiClient
// (which statically imports offlineStorage, no race) and stub the leaf storage
// barrel below, driving loader return values through offlineStorage.* .
vi.mock('../../../services/storage', () => ({
    offlineStorage: {
        embeddings: { store: vi.fn(async () => {}) },
        backup: { create: vi.fn(async () => {}) },
        facts: { get: vi.fn(async () => []), save: vi.fn(async () => {}) },
        chapters: { list: vi.fn(async () => []) },
        timeline: { get: vi.fn(async () => []) },
        entities: { get: vi.fn(async () => []) },
    },
}));

vi.mock('../../../components/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../../services/infrastructure/themeService', () => ({
    applyTheme: vi.fn(),
    watchSystemTheme: vi.fn(),
    applyUIScale: vi.fn(),
}));

vi.mock('../../../services/infrastructure/settingsCrypto', () => ({
    encryptSettingsPresets: vi.fn(async (p: unknown) => p),
    decryptSettingsPresets: vi.fn(async (p: unknown) => p),
    encryptSettingsProviders: vi.fn(async (p: unknown) => p),
    decryptSettingsProviders: vi.fn(async (p: unknown) => p),
}));

// ── Real modules under test (imported after mocks are hoisted) ──────────────
import { useAppStore } from '../../useAppStore';
import { defaultContext } from '../campaignSlice';
import { EMPTY_REGISTER } from '../../../services/campaign-state';
import { embeddingStorage } from '../../../services/storage/embeddingStorage';
import { offlineStorage } from '../../../services/storage';
import { saveDivergenceRegister } from '../../campaignStore';
import { embedText } from '../../../services/embedding';

type Mock = ReturnType<typeof vi.fn>;
const apiStub = {
    facts: offlineStorage.facts.get as Mock,
    chapters: offlineStorage.chapters.list as Mock,
    timeline: offlineStorage.timeline.get as Mock,
    entities: offlineStorage.entities.get as Mock,
};

// ── Helpers ────────────────────────────────────────────────────────────────
const flush = async () => { for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0); };
const fireDebounce = async (ms = 1000) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

const makeNPC = (name: string, overrides: Partial<NPCEntry> = {}): NPCEntry => ({
    id: overrides.id ?? name.toLowerCase().replace(/\s+/g, '-'),
    name,
    aliases: '',
    appearance: '',
    faction: '',
    storyRelevance: '',
    disposition: '',
    status: '',
    goals: '',
    voice: '',
    personality: '',
    exampleOutput: '',
    affinity: 50,
    ...overrides,
});

const makeEntry = (id: string, overrides: Partial<DivergenceEntry> = {}): DivergenceEntry => ({
    id,
    chapterId: 'CH01',
    category: 'misc',
    text: `fact ${id}`,
    sceneRef: '001',
    npcIds: [],
    pinned: false,
    source: 'auto',
    ...overrides,
});

const makeRegister = (entries: DivergenceEntry[]): DivergenceRegister => ({
    ...EMPTY_REGISTER,
    entries,
});

const resetStore = () => {
    useAppStore.setState({
        activeCampaignId: null,
        context: { ...defaultContext },
        loreChunks: [],
        archiveIndex: [],
        npcLedger: [],
        onStageNpcIds: [],
        chapters: [],
        semanticFacts: [],
        timeline: [],
        entities: [],
        pinnedChapterIds: [],
        bookkeepingTurnCounter: 0,
        autoBookkeepingInterval: 5,
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        divergenceRegister: { ...EMPTY_REGISTER },
        pinnedExcerpts: [],
    });
};

// Spy on the REAL embeddingStorage (it runs against mocked idb). callThrough so
// idb effects still happen; we assert call counts AND the resulting keys.
const storeSpy = vi.spyOn(embeddingStorage, 'store');
const deleteSpy = vi.spyOn(embeddingStorage, 'deleteByTypeAndId');

beforeEach(() => {
    vi.useFakeTimers();
    idbStore.clear();
    vi.clearAllMocks();
    // api-backed loader leaves default to empty — individual tests override.
    apiStub.facts.mockResolvedValue([]);
    apiStub.chapters.mockResolvedValue([]);
    apiStub.timeline.mockResolvedValue([]);
    apiStub.entities.mockResolvedValue([]);
    resetStore();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────────────────────
// Test 1 — setActiveCampaign hydration
// ───────────────────────────────────────────────────────────────────────────
describe('setActiveCampaign — hydration', () => {
    it('loads all 9 campaign-scoped entity types into store state (incl. cross-slice chat fields)', async () => {
        const id = 'camp-hydrate';

        // idb-backed loaders
        idbStore.set(`state_${id}`, {
            context: { starter: 'seeded-starter', surpriseDC: 12, worldVibe: 'SHOULD_BE_STRIPPED' },
            messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
            condenser: { condensedUpToIndex: 7 },
            pinnedExcerpts: [],
        });
        idbStore.set(`lore_${id}`, [{ id: 'L1', header: 'Ironwall', content: 'a fortress', tokens: 3 }]);
        idbStore.set(`npcs_${id}`, [makeNPC('Gandalf')]);
        idbStore.set(`archive_index_${id}`, [{ sceneId: '001', timestamp: 1, keywords: [], npcsMentioned: [], userSnippet: 'x' }]);
        idbStore.set(`divergence_${id}`, makeRegister([makeEntry('d1')]));

        // api-backed loaders (real apiClient -> mocked offlineStorage leaves)
        apiStub.chapters.mockResolvedValue([{ chapterId: 'CH01', title: 'Ch 1' }]);
        apiStub.facts.mockResolvedValue([{ id: 'f1', subject: 's', predicate: 'p', object: 'o' }]);
        apiStub.timeline.mockResolvedValue([{ id: 't1' }]);
        apiStub.entities.mockResolvedValue([{ id: 'e1' }]);

        await useAppStore.getState().setActiveCampaign(id);
        await flush();

        const s = useAppStore.getState();
        expect(s.activeCampaignId).toBe(id);

        // context: defaultContext merged with loaded state.context
        expect(s.context.starter).toBe('seeded-starter');      // loaded value wins
        expect(s.context.surpriseDC).toBe(12);                  // loaded value wins
        expect(s.context.encounterDC).toBe(defaultContext.encounterDC); // default fills gaps
        // AI_PLAYER_CONTEXT_KEYS stripped on load
        expect((s.context as Record<string, unknown>).worldVibe).toBeUndefined();

        // cross-slice chat fields written by campaign hydration
        expect(s.messages).toHaveLength(1);
        expect(s.messages[0].content).toBe('hello');
        expect(s.condenser).toEqual({ condensedUpToIndex: 7 });
        expect(s.divergenceRegister.entries).toHaveLength(1);
        expect(s.divergenceRegister.entries[0].id).toBe('d1');
        // normalized by loadDivergenceRegister
        expect(s.divergenceRegister.chapterToggles).toEqual({});
        expect(s.divergenceRegister.categoryToggles).toEqual({});

        // campaign-owned collections
        expect(s.loreChunks).toHaveLength(1);
        expect(s.loreChunks[0].id).toBe('L1');
        expect(s.npcLedger).toHaveLength(1);
        expect(s.npcLedger[0].name).toBe('Gandalf');
        expect(s.archiveIndex).toHaveLength(1);
        expect(s.chapters).toEqual([{ chapterId: 'CH01', title: 'Ch 1' }]);
        expect(s.semanticFacts).toEqual([{ id: 'f1', subject: 's', predicate: 'p', object: 'o' }]);
        expect(s.timeline).toEqual([{ id: 't1' }]);
        expect(s.entities).toEqual([{ id: 'e1' }]);
    });

    it('uses empty/default fallbacks when nothing is stored', async () => {
        const id = 'camp-empty';
        await useAppStore.getState().setActiveCampaign(id);
        await flush();

        const s = useAppStore.getState();
        expect(s.activeCampaignId).toBe(id);
        expect(s.messages).toEqual([]);
        expect(s.condenser).toEqual({ condensedUpToIndex: -1 });
        expect(s.divergenceRegister).toEqual(EMPTY_REGISTER);
        expect(s.context).toEqual(defaultContext);
        expect(s.loreChunks).toEqual([]);
        expect(s.npcLedger).toEqual([]);
    });

    it('tolerates batch-2 (api) loader failures via .catch(() => [])', async () => {
        const id = 'camp-offline';
        apiStub.chapters.mockRejectedValue(new Error('offline'));
        apiStub.facts.mockRejectedValue(new Error('offline'));
        apiStub.timeline.mockRejectedValue(new Error('offline'));
        apiStub.entities.mockRejectedValue(new Error('offline'));

        await useAppStore.getState().setActiveCampaign(id);
        await flush();

        const s = useAppStore.getState();
        expect(s.activeCampaignId).toBe(id);
        expect(s.chapters).toEqual([]);
        expect(s.semanticFacts).toEqual([]);
        expect(s.timeline).toEqual([]);
        expect(s.entities).toEqual([]);
    });

    it('null id is an early return that only clears activeCampaignId', async () => {
        useAppStore.setState({ activeCampaignId: 'something', messages: [{ id: 'm', role: 'user', content: 'keep', timestamp: 1 }] });
        await useAppStore.getState().setActiveCampaign(null);
        await flush();

        const s = useAppStore.getState();
        expect(s.activeCampaignId).toBeNull();
        // does NOT wipe other state (no hydration happened)
        expect(s.messages).toHaveLength(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 2 — NPC lifecycle (dedup, embed gate, save)
// ───────────────────────────────────────────────────────────────────────────
describe('NPC lifecycle', () => {
    const id = 'camp-npc';
    beforeEach(() => { useAppStore.setState({ activeCampaignId: id, npcLedger: [] }); });

    it('addNPC dedupes and does NOT embed; debounced save writes npcs_<id>', async () => {
        const { addNPC } = useAppStore.getState();
        addNPC(makeNPC('Gandalf', { id: 'g1' }));
        addNPC(makeNPC('Gandalf', { id: 'g2', affinity: 99 })); // exact dup -> keep newer

        const s = useAppStore.getState();
        expect(s.npcLedger).toHaveLength(1);
        expect(s.npcLedger[0].affinity).toBe(99);
        expect(embedText).not.toHaveBeenCalled();
        expect(storeSpy).not.toHaveBeenCalled();

        await fireDebounce();
        expect(idbStore.get(`npcs_${id}`)).toEqual(s.npcLedger);
    });

    it('addNPCs batch dedupes against existing ledger', async () => {
        useAppStore.setState({ npcLedger: [makeNPC('Frodo', { id: 'f1' })] });
        useAppStore.getState().addNPCs([makeNPC('Frodo', { id: 'f2' }), makeNPC('Sam', { id: 's1' })]);

        const names = useAppStore.getState().npcLedger.map(n => n.name).sort();
        expect(names).toEqual(['Frodo', 'Sam']);
        expect(embedText).not.toHaveBeenCalled();
    });

    it('updateNPC re-embeds ONLY when an NPC_EMBED_FIELDS field changes', async () => {
        useAppStore.setState({ npcLedger: [makeNPC('Gandalf', { id: 'g1' })] });

        // non-embed field (affinity) -> no embedding
        useAppStore.getState().updateNPC('g1', { affinity: 80 });
        await flush();
        expect(useAppStore.getState().npcLedger[0].affinity).toBe(80);
        expect(embedText).not.toHaveBeenCalled();
        expect(storeSpy).not.toHaveBeenCalled();

        // embed field (personality) -> embeds via embedText + embeddingStorage.store
        useAppStore.getState().updateNPC('g1', { personality: 'grumpy but kind' });
        await flush();
        expect(embedText).toHaveBeenCalledTimes(1);
        expect(storeSpy).toHaveBeenCalledTimes(1);
        expect(storeSpy).toHaveBeenCalledWith(id, 'g1', expect.any(Array), 'npc', 'test-model');
        // vector landed in idb under the npc-typed key
        expect(idbStore.get(`nn_embed_${id}_npc_g1`)).toBeDefined();
    });

    it('removeNPC removes from ledger, clears pressure, and saves — no embedding', async () => {
        useAppStore.setState({
            npcLedger: [makeNPC('Gandalf', { id: 'g1' }), makeNPC('Frodo', { id: 'f1' })],
            npcPressure: { g1: { ignored: 3, engaged: 1, lastDecayTurn: 0, history: [] } },
        });

        useAppStore.getState().removeNPC('g1');

        expect(useAppStore.getState().npcLedger.map(n => n.id)).toEqual(['f1']);
        expect(useAppStore.getState().npcPressure['g1']).toBeUndefined();

        expect(embedText).not.toHaveBeenCalled();
        await fireDebounce();
        expect(idbStore.get(`npcs_${id}`)).toHaveLength(1);
    });

    it('removeNPC drops the entry and deletes its vector', async () => {
        useAppStore.setState({ npcLedger: [makeNPC('Gandalf', { id: 'g1' }), makeNPC('Frodo', { id: 'f1' })] });
        // seed an existing npc vector so we can see it removed
        await embeddingStorage.store(id, 'g1', [0.1, 0.2, 0.3], 'npc', 'test-model');
        storeSpy.mockClear();
        expect(idbStore.get(`nn_embed_${id}_npc_g1`)).toBeDefined();

        useAppStore.getState().removeNPC('g1');
        await flush();

        expect(useAppStore.getState().npcLedger.map(n => n.id)).toEqual(['f1']);
        expect(deleteSpy).toHaveBeenCalledWith(id, 'npc', 'g1');
        expect(idbStore.get(`nn_embed_${id}_npc_g1`)).toBeUndefined();

        await fireDebounce();
        expect(idbStore.get(`npcs_${id}`)).toHaveLength(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 3 — persistence shapes
// ───────────────────────────────────────────────────────────────────────────
describe('persistence shapes', () => {
    const id = 'camp-persist';
    beforeEach(() => { useAppStore.setState({ activeCampaignId: id }); });

    it('updateContext debounces a state_<id> save with {context,messages,condenser,pinnedExcerpts}', async () => {
        useAppStore.setState({
            messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
            condenser: { condensedUpToIndex: 3 },
            pinnedExcerpts: [],
        });

        useAppStore.getState().updateContext({ starter: 'new-starter', starterActive: true });
        expect(useAppStore.getState().context.starter).toBe('new-starter');

        // nothing persisted before the debounce fires
        expect(idbStore.get(`state_${id}`)).toBeUndefined();

        await fireDebounce();
        const saved = idbStore.get(`state_${id}`) as Record<string, unknown>;
        expect(saved).toBeDefined();
        expect(Object.keys(saved).sort()).toEqual(['condenser', 'context', 'messages', 'pinnedExcerpts']);
        expect((saved.context as Record<string, unknown>).starter).toBe('new-starter');
        expect(saved.messages).toHaveLength(1);
        expect(saved.condenser).toEqual({ condensedUpToIndex: 3 });
    });

    it('updateLoreChunk saves lore_<id> inline (not debounced)', async () => {
        useAppStore.setState({ loreChunks: [{ id: 'L1', header: 'A', content: 'old', tokens: 1 } as never] });

        useAppStore.getState().updateLoreChunk('L1', { content: 'new content' });
        expect(useAppStore.getState().loreChunks[0].content).toBe('new content');

        await flush(); // inline dynamic-import save, no timer advance needed
        const saved = idbStore.get(`lore_${id}`) as Array<{ id: string; content: string }>;
        expect(saved).toBeDefined();
        expect(saved[0].content).toBe('new content');
    });

    it('setNPCLedger debounces an npcs_<id> save', async () => {
        useAppStore.getState().setNPCLedger([makeNPC('Aragorn', { id: 'a1' })]);
        await fireDebounce();
        expect(idbStore.get(`npcs_${id}`)).toHaveLength(1);
    });

    it('the shared state debounce coalesces rapid edits into one save', async () => {
        useAppStore.getState().updateContext({ starter: 'one' });
        useAppStore.getState().updateContext({ starter: 'two' });
        useAppStore.getState().updateContext({ starter: 'three' });
        await fireDebounce();
        const saved = idbStore.get(`state_${id}`) as { context: { starter: string } };
        expect(saved.context.starter).toBe('three');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 4 — divergence register (lives in chatSlice)
// ───────────────────────────────────────────────────────────────────────────
describe('divergence register', () => {
    const id = 'camp-div';
    beforeEach(() => {
        useAppStore.setState({
            activeCampaignId: id,
            divergenceRegister: makeRegister([makeEntry('d1'), makeEntry('d2')]),
            messages: [],
            condenser: { condensedUpToIndex: -1 },
            pinnedExcerpts: [],
        });
    });

    it('setDivergenceRegister replaces the register in state', () => {
        const next = makeRegister([makeEntry('x1')]);
        useAppStore.getState().setDivergenceRegister(next);
        expect(useAppStore.getState().divergenceRegister.entries.map(e => e.id)).toEqual(['x1']);
    });

    it('toggleDivergenceFact / pinDivergenceFact mutate the register entries', () => {
        useAppStore.getState().toggleDivergenceFact('d1', false);
        expect(useAppStore.getState().divergenceRegister.entries.find(e => e.id === 'd1')!.enabled).toBe(false);

        useAppStore.getState().pinDivergenceFact('d2');
        expect(useAppStore.getState().divergenceRegister.entries.find(e => e.id === 'd2')!.pinned).toBe(true);
    });

    it('saveDivergenceRegister primitive persists to divergence_<id>', async () => {
        const reg = makeRegister([makeEntry('persisted')]);
        await saveDivergenceRegister(id, reg);
        const stored = idbStore.get(`divergence_${id}`) as DivergenceRegister;
        expect(stored.entries.map(e => e.id)).toEqual(['persisted']);
    });

    /*
     * FIXED IN PHASE 7. The UI-edit divergence actions now also call saveDivergenceRegister
     * (via the chatSlice `saveDivergence` helper), so manual MemoryTab edits persist to
     * `divergence_<id>`. The shared campaign-state debounce is intentionally kept, so
     * `state_<id>` is still written — and still does NOT carry the register (it lives
     * under its own key). This is the inversion of the previously-pinned bug.
     */
    it('FIXED: UI-edit actions persist the register to divergence_<id> (and still write state_<id>)', async () => {
        useAppStore.getState().toggleDivergenceFact('d1', false);
        await fireDebounce();

        // state_<id> is still written by the shared campaign-state debounce...
        const stateSaved = idbStore.get(`state_${id}`) as Record<string, unknown> | undefined;
        expect(stateSaved).toBeDefined();
        // ...and still does NOT carry the divergence register (separate key)
        expect(stateSaved).not.toHaveProperty('divergenceRegister');
        // ...and divergence_<id> is NOW written by the UI-edit action, with the toggle applied
        const divSaved = idbStore.get(`divergence_${id}`) as DivergenceRegister | undefined;
        expect(divSaved).toBeDefined();
        expect(divSaved!.entries.find(e => e.id === 'd1')!.enabled).toBe(false);
    });

    it('Phase 7: other UI-edit divergence actions (pin/edit) also persist to divergence_<id>', async () => {
        useAppStore.getState().pinDivergenceFact('d2');
        await fireDebounce();
        let divSaved = idbStore.get(`divergence_${id}`) as DivergenceRegister;
        expect(divSaved.entries.find(e => e.id === 'd2')!.pinned).toBe(true);

        useAppStore.getState().editDivergenceFact('d1', 'rewritten fact text');
        await fireDebounce();
        divSaved = idbStore.get(`divergence_${id}`) as DivergenceRegister;
        expect(divSaved.entries.find(e => e.id === 'd1')!.text).toBe('rewritten fact text');
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Test 5 — active campaign switch
// ───────────────────────────────────────────────────────────────────────────
describe('active campaign switch', () => {
    it('saves campaign A, loads campaign B, and restores A on switch-back', async () => {
        const A = 'camp-A';
        const B = 'camp-B';
        idbStore.set(`state_${A}`, { context: { starter: 'A-start' }, messages: [{ id: 'a', role: 'user', content: 'in A', timestamp: 1 }], condenser: { condensedUpToIndex: -1 }, pinnedExcerpts: [] });
        idbStore.set(`state_${B}`, { context: { starter: 'B-start' }, messages: [{ id: 'b', role: 'user', content: 'in B', timestamp: 1 }], condenser: { condensedUpToIndex: 5 }, pinnedExcerpts: [] });

        // Load A
        await useAppStore.getState().setActiveCampaign(A);
        await flush();
        expect(useAppStore.getState().context.starter).toBe('A-start');

        // Mutate A and let the save settle
        useAppStore.getState().updateContext({ inventory: 'a sword' });
        await fireDebounce();
        expect((idbStore.get(`state_${A}`) as { context: { inventory: string } }).context.inventory).toBe('a sword');

        // Switch to B
        await useAppStore.getState().setActiveCampaign(B);
        await flush();
        const sB = useAppStore.getState();
        expect(sB.activeCampaignId).toBe(B);
        expect(sB.context.starter).toBe('B-start');
        expect(sB.messages[0].content).toBe('in B');

        // Switch back to A — the mutation survived in storage
        await useAppStore.getState().setActiveCampaign(A);
        await flush();
        const sA = useAppStore.getState();
        expect(sA.context.starter).toBe('A-start');
        expect(sA.context.inventory).toBe('a sword');
    });

    /*
     * CHARACTERIZATION of a latent data-loss risk the Phase 7 doc calls out: there is no
     * flushPendingSaves on switch, and the campaign-state debounce uses a SINGLE shared
     * module-level timer. So if A has an in-flight (un-fired) save and a save is scheduled
     * for B before the timer fires, A's pending save is cancelled (clearTimeout) and lost.
     * Phase 7 (per-slice timers + flushPendingSaves) is expected to FIX this — invert when it lands.
     */
    it('CURRENT BUG: a pending campaign-state save for A is dropped if B schedules one first', async () => {
        const A = 'camp-A2';
        const B = 'camp-B2';
        idbStore.set(`state_${A}`, { context: { starter: 'A-seed' }, messages: [], condenser: { condensedUpToIndex: -1 }, pinnedExcerpts: [] });
        idbStore.set(`state_${B}`, { context: { starter: 'B-seed' }, messages: [], condenser: { condensedUpToIndex: -1 }, pinnedExcerpts: [] });

        await useAppStore.getState().setActiveCampaign(A);
        await flush();

        // Schedule A's save but DO NOT fire the debounce
        useAppStore.getState().updateContext({ inventory: 'A-pending-edit' });

        // Switch to B (does not touch the shared state timer) then edit B,
        // which calls clearTimeout on the shared timer — cancelling A's pending save.
        await useAppStore.getState().setActiveCampaign(B);
        await flush();
        useAppStore.getState().updateContext({ inventory: 'B-edit' });

        await fireDebounce();

        // B's edit persisted...
        expect((idbStore.get(`state_${B}`) as { context: { inventory?: string } }).context.inventory).toBe('B-edit');
        // ...but A's pending edit was dropped: state_A still holds only the seed.
        const stateA = idbStore.get(`state_${A}`) as { context: { inventory?: string; starter: string } };
        expect(stateA.context.starter).toBe('A-seed');
        expect(stateA.context.inventory).toBeUndefined();
    });
});
