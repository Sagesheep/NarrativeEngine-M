# Phase 4: Save File Engine Upgrade

## Goal
Upgrade `saveFileEngine.ts` to use JSON-slot Canon State format, add batch processing, and add Chapter Summary generation.

## Files to Modify
- `src/services/saveFileEngine.ts` (MAJOR rewrite, ~250 lines added)

## Reference
Read `../mainApp/src/services/saveFileEngine.ts` (553 lines) for the canonical implementation.

---

## WARNING: This is a BREAKING CHANGE
The Canon State format changes from structured text (3-section markdown) to JSON array of memory slots.
Existing campaigns will need their canon state regenerated. The app should handle this gracefully.

---

## Step 1: Add New Private Helper Functions

Add these functions at the top of `saveFileEngine.ts` (after imports):

### `chunkMessagesByTokenBudget()`
```typescript
function chunkMessagesByTokenBudget(
    messages: ChatMessage[],
    budget: number,
    countTokens: (text: string) => number
): ChatMessage[][] {
    // Split messages into batches where each batch's total tokens <= budget
    // Process from newest to oldest
    // Each batch is a contiguous chunk of messages
    // Budget default: 100000 tokens
}
```
Read mainApp `saveFileEngine.ts` lines 6-23 for the implementation.

### `normalizeForComparison()`
```typescript
function normalizeForComparison(s: string): string {
    return s.normalize('NFKD').replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
}
```

### `containsNormalized()`
```typescript
function containsNormalized(haystack: string, needle: string): boolean {
    return normalizeForComparison(haystack).includes(normalizeForComparison(needle));
}
```

---

## Step 2: Change Canon State Format

### Remove old constants
Remove `CANON_STATE_SECTIONS` and `CANON_STATE_REQUIRED_FIELDS` constants.

### Rewrite `validateCanonState()`
Change from checking for text section headers to validating a JSON array of `CoreMemorySlot` objects:

```typescript
export function validateCanonState(output: string): {
    valid: boolean;
    missing: string[];
    slots?: CoreMemorySlot[];
} {
    try {
        const arr = JSON.parse(output);
        if (!Array.isArray(arr)) return { valid: false, missing: ['JSON array'] };
        const REQUIRED_KEYS = ['PLAYER_STATUS', 'LOCATION', 'TIME_DATE'];
        const present = new Set(arr.map((s: any) => s.key));
        const missing = REQUIRED_KEYS.filter(k => !present.has(k));
        return { valid: missing.length === 0, missing, slots: arr };
    } catch {
        return { valid: false, missing: ['JSON parse'] };
    }
}
```

### Rewrite `buildCanonStatePrompt()`
Change the prompt to instruct the LLM to output a JSON array of memory slot objects:

```typescript
function buildCanonStatePrompt(messages: ChatMessage[], existingSlots?: CoreMemorySlot[]): string {
    // Prompt should request:
    // - JSON array of objects: { key, value, priority, sceneId }
    // - Required keys: PLAYER_STATUS, LOCATION, TIME_DATE
    // - Maximum 15 slots
    // - priority: 1-10 (10 = most important)
    // - sceneId: the scene number this info was learned in
    // - Include existing slots as context for updates
    // Read mainApp for the exact prompt text
}
```

Read `../mainApp/src/services/saveFileEngine.ts` for the complete prompt.

---

## Step 3: Upgrade `generateCanonState()` to Batch Processing

Replace single-pass with batched processing:

```typescript
export async function generateCanonState(
    messages: ChatMessage[],
    endpoint: { endpoint: string; apiKey: string; modelName: string },
    existingSlots?: CoreMemorySlot[],
    countTokens?: (text: string) => number
): Promise<{ canonState: string; slots?: CoreMemorySlot[]; success: boolean }> {
    // 1. If countTokens provided, chunk messages into batches of 100K tokens
    // 2. Process each batch sequentially
    // 3. Each batch gets the running canon state as context
    // 4. Parse JSON output from each batch
    // 5. Merge/accumulate slots (later batch overrides earlier for same keys)
    // 6. Return final JSON stringified canon state + slots array
    // 7. Fallback: if no countTokens, do single-pass (backward compat)
}
```

Read mainApp for the full implementation.

---

## Step 4: Upgrade `validateHeaderIndex()` to Use Normalized Comparison

Replace `output.includes()` with `containsNormalized()` for Unicode-robust dash matching.

---

## Step 5: Upgrade `splitHeaderIndexSections()` 

Replace `text.indexOf('SECTION 2 -- PENDING LOOPS')` with a regex that handles Unicode dash variants:
```typescript
const splitIdx = normalizeForComparison(text).indexOf(normalizeForComparison('SECTION 2 -- PENDING LOOPS'));
```

---

## Step 6: Upgrade `mergeHeaderIndex()` Scene Block Parsing

Replace the selective line matching (only HEADER/THREADS/DELTA) with an `inBlock` flag approach:

```typescript
// For each scene block starting with "SCENE_ID:", collect ALL lines
// until the next "SCENE_ID:" or end of section
// This preserves multi-line descriptions, notes, etc.
```

Add fallback: if existing section1 is empty, use new section1 entirely.

Read mainApp `saveFileEngine.ts` for the complete `mergeHeaderIndex` implementation.

---

## Step 7: Upgrade `generateHeaderIndex()` to Batch Processing

Same pattern as `generateCanonState`:
1. Chunk messages into batches
2. Process each batch sequentially with running index as context
3. Validate merged result before accepting
4. Return final header index string

---

## Step 8: Upgrade `runSaveFilePipeline()` to Parallel + Core Memory Slots

```typescript
export async function runSaveFilePipeline(
    messages: ChatMessage[],
    endpoint: { endpoint: string; apiKey: string; modelName: string },
    existingSlots?: CoreMemorySlot[],
    countTokens?: (text: string) => number
): Promise<{
    canonState: string;
    headerIndex: string;
    canonSuccess: boolean;
    indexSuccess: boolean;
    coreMemorySlots?: CoreMemorySlot[];
}> {
    // Run canonState and headerIndex in PARALLEL via Promise.all
    // (NOT sequential like current mobileApp)
    // Return coreMemorySlots from canonState result
}
```

---

## Step 9: Add Chapter Summary Generator Module

Add these new functions at the end of the file:

### `ChapterSummaryOutput` type (inline)
```typescript
type ChapterSummaryOutput = {
    title: string;
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
};
```

### `truncateScenesToBudget(scenes, budget, countTokens)`
- Keep 20% oldest scenes + 60% newest scenes when over budget
- Return trimmed array

### `buildChapterSummaryPrompt(scenes, chapterTitle?)`
- Prompt asking LLM to summarize scenes into a structured JSON output
- Include all ChapterSummaryOutput fields

### `parseChapterSummaryOutput(raw)`
- JSON parser with field validation and defaults
- Returns ChapterSummaryOutput

### `generateChapterSummary(campaignId, chapterTitle?, endpoint, countTokens)`
- Fetch scenes from server API
- Truncate to budget if needed
- Build prompt, call LLM, parse output
- Retry once on parse failure
- Return ChapterSummaryOutput

Read `../mainApp/src/services/saveFileEngine.ts` lines 412-551 for all implementations.

---

## Verification
After completing this phase:
1. `npm run build` should succeed
2. The new Canon State format will be used for NEW generations
3. Old campaigns with text-format canon state will still display (it's just a string in context)
4. They will be upgraded on next save file pipeline run

## CRITICAL: Update imports
Make sure `CoreMemorySlot` is imported from `../types` at the top of the file.
