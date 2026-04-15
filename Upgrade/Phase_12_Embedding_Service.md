# Phase 12: Lightweight Embedding Service

## Goal
Add a client-side embedding model that runs in the Capacitor WebView using WASM/WebGPU, enabling vector-based semantic search over archive scenes and lore chunks.

## Dependencies
- Phase 11 (LLM Queue) — should be completed first
- New npm dependency: `@huggingface/transformers`

## Background

mainApp runs embedding server-side via `server/lib/embedder.js` using `mixedbread-ai/mxbai-embed-large-v1` (~350-500MB, 1024-dim). This is too heavy for mobile.

mobileApp's approach:
- **Model:** `all-MiniLM-L6-v2` (~25MB, 384-dim) — small, fast, good enough for campaign-scale retrieval
- **Runtime:** `@huggingface/transformers` with WebGPU (auto-fallback to WASM)
- **Storage:** Embeddings stored in IndexedDB alongside scene data
- **Search:** Pure JS brute-force cosine similarity (campaigns have 50-500 scenes, not millions)
- **Degradation:** If embedder fails or hasn't loaded, search stays keyword-only (current behavior)

## New Dependency

```bash
npm install @huggingface/transformers
```

Bundle impact:
- Library code: ~1-2MB added to JS bundle
- Model file: ~25MB, downloaded on first use via browser Cache API, cached persistently
- Not stored in IndexedDB — handled by the transformers.js caching layer

## Files to Create

### 1. `src/services/embedder.ts` (~120 lines)

Lazy singleton embedding service.

```ts
import { pipeline, type Pipeline } from '@huggingface/transformers';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;

let embedder: Pipeline | null = null;
let loading: Promise<Pipeline> | null = null;
let ready = false;

/**
 * Initialize the embedding model. Safe to call multiple times.
 * First call downloads the model (~25MB), subsequent calls are instant.
 */
export async function warmupEmbedder(): Promise<void>;

/**
 * Embed a single text string. Returns null if model is unavailable.
 */
export async function embedText(text: string): Promise<Float32Array | null>;

/**
 * Embed multiple texts. Returns parallel array, null for failures.
 */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]>;

/**
 * Check if the embedder has been loaded and is ready.
 */
export function isEmbedderReady(): boolean;

/**
 * Returns the embedding dimensionality (384 for all-MiniLM-L6-v2).
 */
export function getEmbedDims(): number;
```

Implementation notes:
- `warmupEmbedder()` creates the pipeline: `pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })`
- `embedText(text)` calls `embedder(text, { pooling: 'mean', normalize: true })` → returns `Float32Array` of 384 floats
- Text is capped at 500 characters (matching mainApp's `buildArchiveText` pattern)
- All errors caught and logged, never throws — returns `null` on failure
- `loading` promise prevents double-initialization race

## Files to Modify

### 2. `src/components/CampaignHub.tsx` (or `campaignSlice.ts`)

**Inside `setActiveCampaign` or campaign load flow:**

Add a non-blocking warmup call after campaign data is loaded:

```ts
// Background: warm up embedding model for semantic search
warmupEmbedder().then(() => {
    console.log('[Embedder] Model warmed up and ready');
}).catch(e => {
    console.warn('[Embedder] Warmup failed, semantic search will use keyword fallback:', e);
});
```

This triggers the model download on first campaign activation. It does NOT block campaign loading. By the time the user starts chatting, the model should be ready.

### 3. `src/services/offlineStorage.ts`

Add an `embeddings` namespace to the `offlineStorage` object:

```ts
embeddings: {
    async store(campaignId: string, id: string, vector: number[], type: 'scene' | 'lore'): Promise<void>;
    async get(campaignId: string, id: string): Promise<number[] | null>;
    async getAll(campaignId: string, type?: 'scene' | 'lore'): Promise<Array<{ id: string; vector: number[] }>>;
    async delete(campaignId: string, id: string): Promise<void>;
    async deleteAll(campaignId: string): Promise<void>;
}
```

Storage key pattern: `nn_embed_${campaignId}_${type}_${id}` → stores `{ vector: number[] }` via `idbSet`.

**Inside `archive.append()`** — after `buildArchiveIndexEntry()`, add background embedding (fire-and-forget):

```ts
// Background: embed scene text for semantic search
embedText(combinedText).then(vec => {
    if (vec) offlineStorage.embeddings.store(campaignId, sceneId, Array.from(vec), 'scene');
}).catch(() => {});
```

This does NOT block the append operation. The embedding is computed asynchronously and stored when ready.

### 4. `src/services/offlineStorage.ts` — Lore embedding on save

**Inside lore chunk save path** (when lore is PUT/updated):

```ts
// Background: embed lore chunks
for (const chunk of loreChunks) {
    embedText(chunk.content.slice(0, 500)).then(vec => {
        if (vec) offlineStorage.embeddings.store(campaignId, chunk.id, Array.from(vec), 'lore');
    }).catch(() => {});
}
```

---

## Embedding Strategy

| Event | Action |
|-------|--------|
| New scene archived | Embed scene text in background, store in IndexedDB |
| Lore chunks updated | Re-embed all chunks in background |
| Campaign activated | Warm up model (non-blocking) |
| First semantic search | If model not ready, fall back to keyword-only |
| Existing scenes without embeddings | Lazy: embed on first search miss, cache result |

## Storage Estimates

| Data | Count | Size |
|------|-------|------|
| Scene embeddings | 500 scenes × 384 floats × 4 bytes | ~768 KB |
| Lore embeddings | 100 chunks × 384 floats × 4 bytes | ~150 KB |
| Model cache (browser) | 1 model file | ~25 MB |
| **Total IndexedDB** | | **< 1 MB** |

## Verification

### Build
```bash
cd mobileApp
npm install @huggingface/transformers
npm run build
```

### Runtime checks
- [ ] First campaign activation triggers model download (check network tab for ~25MB download)
- [ ] Subsequent activations reuse cached model (no download)
- [ ] `isEmbedderReady()` returns true after warmup
- [ ] `embedText("test query")` returns Float32Array of length 384
- [ ] Archive append stores embedding in IndexedDB (check `nn_embed_*` keys)
- [ ] Lore save stores embeddings for each chunk
- [ ] App works normally if model download fails (keyword fallback)
- [ ] No UI blocking during model load or embedding

### Performance
- [ ] Single `embedText()` call completes in < 200ms on mid-range phone
- [ ] Background embedding during archive append doesn't cause noticeable lag
- [ ] Memory usage stays reasonable (model ~100MB RAM while loaded)
