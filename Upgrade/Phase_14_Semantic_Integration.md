# Phase 14: Semantic Candidates Integration

## Goal
Wire the embedding service and vector search into the turn orchestrator's context gathering pipeline, completing the semantic search feature.

## Dependencies
- Phase 12 (Embedding Service) — must be completed
- Phase 13 (Vector Search) — must be completed

## Background

In mainApp, `contextGatherer.ts` makes two server calls:
- `POST /api/campaigns/:id/archive/semantic-candidates` → `{ sceneIds: string[] }`
- `POST /api/campaigns/:id/lore/semantic-candidates` → `{ loreIds: string[] }`

These are server-side vector searches. The results (`semanticArchiveIds`, `semanticLoreIds`) are then passed into archive recall and lore retrieval as boost signals.

In mobileApp, there is no server running on the phone. The equivalent is:
- Call `semanticSearch()` locally (embed query → cosine search over IndexedDB embeddings)
- Pass the resulting IDs into the existing `recallArchiveScenes()` and `retrieveRelevantLore()` calls

## Files to Modify

### 1. `src/services/turnOrchestrator.ts`

**Insertion point: after the recommender block (~line 258), before `buildPayload()` (~line 263).**

Add semantic candidate search:

```ts
// ── Semantic candidate search (vector-based) ──
let semanticArchiveIds: string[] | undefined;
let semanticLoreIds: string[] | undefined;

if (isEmbedderReady() && activeCampaignId) {
    try {
        const [sceneIds, loreIds] = await Promise.all([
            semanticSearch(activeCampaignId, finalInput, 'scene', 20),
            semanticSearch(activeCampaignId, finalInput, 'lore', 15),
        ]);
        semanticArchiveIds = sceneIds;
        semanticLoreIds = loreIds;

        if (semanticArchiveIds?.length) {
            console.log(`[Semantic] Found ${semanticArchiveIds.length} scene candidates: [${semanticArchiveIds.join(', ')}]`);
        }
        if (semanticLoreIds?.length) {
            console.log(`[Semantic] Found ${semanticLoreIds.length} lore candidates: [${semanticLoreIds.join(', ')}]`);
        }
    } catch (e) {
        console.warn('[Semantic] Candidate search failed, using keyword fallback:', e);
    }
}
```

**Then update the existing calls to pass the semantic IDs:**

The existing archive recall calls (around lines 169 and 199/205) need the new parameter. Find the calls to `recallWithChapterFunnel()` and `recallArchiveScenes()` and append `semanticArchiveIds`:

```ts
// Chapter-aware path:
const archiveRecall = await recallWithChapterFunnel(
    chapters, archiveIndex, finalInput, allMsgs,
    npcLedger, semanticFacts, utilityEndpoint,
    activeCampaignId, 3000, semanticArchiveIds  // NEW param
);

// Flat fallback path:
const archiveRecall = await recallArchiveScenes(
    activeCampaignId, archiveIndex, finalInput, allMsgs,
    3000, npcLedger, semanticFacts, semanticArchiveIds  // NEW param
);
```

The existing lore retrieval call needs `semanticLoreIds`:

```ts
const relevantLore = retrieveRelevantLore(
    loreChunks, canonState, headerIndex, finalInput,
    1200, allMsgs, semanticLoreIds  // NEW param
);
```

### 2. `src/services/archiveChapterEngine.ts`

The `recallWithChapterFunnel()` function calls `retrieveArchiveMemory()` internally. Add `semanticCandidateIds` as an optional final parameter and pass it through:

```ts
export async function recallWithChapterFunnel(
    chapters: ArchiveChapter[],
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    semanticFacts?: SemanticFact[],
    utilityProvider?: EndpointConfig | ProviderConfig,
    campaignId?: string,
    tokenBudget?: number,
    semanticCandidateIds?: string[]  // NEW
): Promise<ArchiveScene[]>
```

Inside, pass `semanticCandidateIds` to the internal `retrieveArchiveMemory()` call.

### 3. `src/services/archiveMemory.ts`

Already modified in Phase 13 to accept `semanticCandidateIds`. No additional changes needed.

### 4. `src/services/loreRetriever.ts`

Already modified in Phase 13 to accept `semanticLoreIds`. No additional changes needed.

## Data Flow (Complete)

```
User types message
  │
  ▼
turnOrchestrator.runTurn()
  │
  ├─ 1. Lore retrieval (keyword-based)
  │     retrieveRelevantLore(..., semanticLoreIds)
  │
  ├─ 2. Semantic candidate search (NEW)
  │     semanticSearch(campaignId, input, 'scene', 20)  →  semanticArchiveIds
  │     semanticSearch(campaignId, input, 'lore', 15)   →  semanticLoreIds
  │
  ├─ 3. Archive recall (with semantic boost)
  │     recallWithChapterFunnel(..., semanticArchiveIds)
  │       └─ retrieveArchiveMemory(..., semanticCandidateIds)
  │            └─ scoreEntry() + semanticBoost for matched IDs
  │
  ├─ 4. Semantic facts
  │     queryFacts() + formatFactsForContext()
  │
  ├─ 5. Context recommender (UtilityAI)
  │     recommendContext(...)
  │
  └─ 6. Payload assembly
        buildPayload(lore, archive, facts, recommender, ...)
```

## Import Changes for `turnOrchestrator.ts`

Add to imports:
```ts
import { isEmbedderReady } from './embedder';
import { semanticSearch } from './vectorSearch';
```

## Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| Model not loaded yet | `isEmbedderReady()` returns false → skip semantic search entirely |
| Model load failed | Same — keyword-only, no error shown to user |
| No embeddings for campaign | `semanticSearch()` returns empty array → no boost applied |
| Partial embeddings (migration in progress) | Only embedded scenes get semantic boost; others work via keywords |
| Search throws error | Caught and logged, turn continues with keyword-only context |

## Verification

### Build
```bash
cd mobileApp
npm run build
```

### Runtime smoke test
1. Open a campaign with 5+ archived scenes
2. Ensure embedder is warmed up (check console for `[Embedder] Model warmed up and ready`)
3. Type a message referencing a past event
4. Check console for:
   - `[Semantic] Found N scene candidates: [...]` — confirms vector search ran
   - `[Archive Retrieval] 3D scored N entries. M matched.` — confirms semantic boost applied

### Functional checks
- [ ] Semantic search finds relevant scenes even without exact keyword matches
- [ ] Lore chunks are retrieved semantically (e.g., "sword" matches "blade" lore)
- [ ] When embedder is not ready, turns still work with keyword-only context
- [ ] No performance regression — semantic search adds < 100ms to turn time
- [ ] Backfill works: new campaign → play 10 turns → semantic search finds earlier scenes
- [ ] Existing campaigns: after loading, scenes gradually get embedded and search improves

### Edge cases
- [ ] Empty campaign (no scenes) — semantic search returns nothing, no errors
- [ ] Very long campaign (200+ scenes) — semantic search still fast (< 100ms)
- [ ] Campaign switch — semantic search uses correct campaign's embeddings
- [ ] Offline mode — semantic search works fully (all data is local)
