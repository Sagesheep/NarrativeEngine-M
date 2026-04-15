# Phase 13: Vector Storage + Cosine Search

## Goal
Implement client-side vector storage and cosine similarity search over archived scene and lore embeddings stored in IndexedDB.

## Dependencies
- Phase 12 (Embedding Service) — must be completed first

## Background

mainApp uses `better-sqlite3` + `sqlite-vec` (native C++ extensions) for vector search. Neither runs in a Capacitor WebView.

mobileApp's approach:
- Embeddings stored in IndexedDB via `offlineStorage.embeddings` (added in Phase 12)
- **Brute-force cosine similarity** in pure JavaScript
- For typical campaign sizes (50-500 scenes, 20-100 lore chunks), brute-force is <50ms — no need for ANN/HNSW
- Results integrated into the existing 3D scoring system as a score boost

## Files to Create

### 1. `src/services/vectorSearch.ts` (~100 lines)

Pure JS vector search over IndexedDB-stored embeddings.

```ts
import { offlineStorage } from './offlineStorage';
import { embedText, isEmbedderReady } from './embedder';

type SearchHit = {
    id: string;
    score: number;
};

/**
 * Compute cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number;

/**
 * Search for the most similar vectors to a query.
 * Returns ranked IDs (best first), up to topK results.
 * Returns empty array if embedder is not ready or no embeddings exist.
 */
export async function searchVectors(
    campaignId: string,
    queryVector: number[],
    type: 'scene' | 'lore',
    topK?: number
): Promise<SearchHit[]>;

/**
 * Convenience: embed a query string and search in one call.
 * Returns just the ranked IDs (no scores).
 * Returns undefined if embedder is not ready (signals keyword fallback).
 */
export async function semanticSearch(
    campaignId: string,
    query: string,
    type: 'scene' | 'lore',
    topK?: number
): Promise<string[] | undefined>;
```

Implementation details:

**`cosineSimilarity(a, b)`:**
```ts
let dot = 0, normA = 0, normB = 0;
for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
}
return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
```

**`searchVectors(campaignId, queryVector, type, topK = 20)`:**
1. Load all embeddings for campaign+type from `offlineStorage.embeddings.getAll(campaignId, type)`
2. For each stored embedding, compute `cosineSimilarity(queryVector, embedding.vector)`
3. Sort by score descending
4. Return top K results as `[{ id, score }]`

**`semanticSearch(campaignId, query, type, topK)`:**
1. Check `isEmbedderReady()` — if false, return `undefined` (signals caller to use keyword fallback)
2. Call `embedText(query)` — if null, return `undefined`
3. Call `searchVectors(campaignId, vector, type, topK)`
4. Return just the IDs array

### 2. `src/services/offlineStorage.ts` — Embedding migration helper

Add a migration utility to the `embeddings` namespace:

```ts
embeddings: {
    // ... existing methods from Phase 12 ...

    /**
     * Ensure all indexed scenes have embeddings.
     * Embeds any missing scenes in the background.
     * Returns count of newly embedded scenes.
     */
    async backfillSceneEmbeddings(
        campaignId: string,
        archiveIndex: ArchiveIndexEntry[],
        sceneContents: Array<{ sceneId: string; content: string }>
    ): Promise<number>;
}
```

This handles the lazy migration case — when a user first gets the embedding feature, existing scenes don't have embeddings yet. Called once on campaign activation if the number of stored embeddings is less than the archive index size.

## Files to Modify

### 3. `src/services/archiveMemory.ts`

**Add `semanticCandidateIds` parameter to existing functions:**

`retrieveArchiveMemory()` — add optional parameter:
```ts
export function retrieveArchiveMemory(
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    maxScenes?: number,
    semanticFacts?: SemanticFact[],
    sceneRanges?: [string, string][],
    semanticCandidateIds?: string[]  // NEW
): string[]
```

**Inside the scoring loop**, after computing the base score, boost entries that appear in `semanticCandidateIds`:

```ts
const baseScore = scoreEntry(entry, contextText, contextActivations, totalScenes);

// Boost scenes found by semantic search
let semanticBoost = 0;
if (semanticCandidateIds && semanticCandidateIds.includes(entry.sceneId)) {
    semanticBoost = baseScore * 0.5; // 50% boost on top of keyword score
}

return baseScore + semanticBoost;
```

This is additive — a scene that matches both keyword AND semantic search gets a significantly higher score. A scene that only matches semantic search still appears (gets base recency + importance), while a scene that only matches keywords still works (current behavior).

`recallArchiveScenes()` — add optional parameter:
```ts
export async function recallArchiveScenes(
    campaignId: string,
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    tokenBudget = 3000,
    npcLedger?: NPCEntry[],
    semanticFacts?: SemanticFact[],
    semanticCandidateIds?: string[]  // NEW
): Promise<ArchiveScene[]>
```

Pass `semanticCandidateIds` through to `retrieveArchiveMemory()`.

### 4. `src/services/loreRetriever.ts`

**Add `semanticLoreIds` parameter:**

```ts
export function retrieveRelevantLore(
    chunks: LoreChunk[],
    _canonState: string,
    _headerIndex: string,
    userMessage: string,
    tokenBudget = 1200,
    recentMessages?: ChatMessage[],
    semanticLoreIds?: string[]  // NEW
): LoreChunk[]
```

In the ranking logic, boost chunks whose IDs appear in `semanticLoreIds`:
- Add a semantic relevance score component alongside the existing keyword hit count
- Chunks matching semantic search get sorted higher within their token budget tier

---

## Verification

### Build
```bash
cd mobileApp
npm run build
```

### Unit verification
- [ ] `cosineSimilarity([1,0,0], [1,0,0])` returns ~1.0
- [ ] `cosineSimilarity([1,0,0], [0,1,0])` returns ~0.0
- [ ] `searchVectors()` returns empty array when no embeddings stored
- [ ] `semanticSearch()` returns `undefined` when embedder not ready
- [ ] `backfillSceneEmbeddings()` correctly skips already-embedded scenes

### Integration verification
- [ ] Archive scenes with embeddings score higher than without (given similar keyword scores)
- [ ] Lore chunks with semantic matches get boosted in retrieval
- [ ] Functions work correctly when `semanticCandidateIds` / `semanticLoreIds` is `undefined` (keyword-only mode)
- [ ] Adding `semanticCandidateIds` parameter doesn't break existing callers (all optional)

### Performance
- [ ] `searchVectors` over 500 embeddings completes in < 50ms
- [ ] No UI jank during search (runs in the same tick as context gathering, which is already async)
