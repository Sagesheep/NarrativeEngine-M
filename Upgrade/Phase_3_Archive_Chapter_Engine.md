# Phase 3: Archive Chapter Engine

## Goal
Create a new `archiveChapterEngine.ts` service for chapter lifecycle management and 3D chapter-aware archive retrieval.

## Files to Create
- `src/services/archiveChapterEngine.ts` (NEW file, ~250 lines)

## Reference
Read `../mainApp/src/services/archiveChapterEngine.ts` for the canonical implementation.

---

## Overview
This service manages the chapter lifecycle:
- **Auto-seal**: Detects when a chapter should be sealed (scene count > threshold)
- **Seal**: Closes an open chapter, sets `sealedAt` timestamp
- **3D Scoring**: Scores chapters on recency + importance + activation
- **LLM Validation**: Asks utility AI to validate chapter relevance (YES/NO per chapter)
- **Chapter Funnel**: Two-stage retrieval (score + validate) for archive context injection

---

## Step 1: Create `src/services/archiveChapterEngine.ts`

Create the file with the following exports. Copy the COMPLETE implementation from `../mainApp/src/services/archiveChapterEngine.ts`:

```typescript
import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, SemanticFact } from '../types';
import { sendMessage } from './llmService';
import { extractJson } from './payloadBuilder';

// Check if the open chapter should be auto-sealed
export function shouldAutoSeal(chapters: ArchiveChapter[]): boolean

// Seal the currently open chapter
export async function sealChapter(campaignId: string): Promise<ArchiveChapter | null>

// Update the _lastSeenSessionId on the open chapter
export function updateChapterSessionId(chapters: ArchiveChapter[]): ArchiveChapter[]

// Score a single chapter (0-100) using 3D scoring
export function scoreChapter(
    chapter: ArchiveChapter,
    contextText: string,
    contextActivations: Record<string, number>,
    totalScenes: number
): number

// Rank all chapters by score, return sorted descending
export function rankChapters(
    chapters: ArchiveChapter[],
    contextText: string,
    contextActivations: Record<string, number>,
    totalScenes: number
): Array<{ chapter: ArchiveChapter; score: number }>

// Validate a single chapter's relevance via LLM (returns true/false)
export async function validateChapterRelevance(
    chapter: ArchiveChapter,
    userMessage: string,
    recentSummary: string,
    endpoint: { endpoint: string; apiKey: string; modelName: string }
): Promise<boolean>

// Iteratively validate top chapters, returning confirmed relevant ones
export async function iterativeChapterFilter(
    ranked: Array<{ chapter: ArchiveChapter; score: number }>,
    userMessage: string,
    recentSummary: string,
    endpoint: { endpoint: string; apiKey: string; modelName: string },
    maxIterations?: number,
    maxConfirmed?: number
): Promise<ArchiveChapter[]>

// Full chapter-aware retrieval funnel
export async function recallWithChapterFunnel(
    campaignId: string,
    chapters: ArchiveChapter[],
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger: NPCEntry[],
    semanticFacts: SemanticFact[],
    tokenBudget: number,
    endpoint: { endpoint: string; apiKey: string; modelName: string },
    countTokens: (text: string) => number
): Promise<{ scenes: string; usedTokens: number }>
```

---

## Key Implementation Details

### `shouldAutoSeal()`
- Find the open chapter (no `sealedAt`)
- If no open chapter, return false
- If open chapter has >= 15 scenes, return true
- If open chapter's summary length > 4000 chars, return true
- Otherwise return false

### `scoreChapter()` - 3D Scoring
- **D1 Recency** (weight 0.5): `1 / (1 + log(1 + turnsSinceLastScene))`
  - Calculate turnsSince from the chapter's last scene number vs total scenes
- **D2 Importance** (weight 1.0): Average of `importance` fields in index entries within the chapter's scene range
- **D3 Activation** (weight 2.0): Dot product of `keywordStrengths`/`npcStrengths` in index entries with `contextActivations`
- Final: `(0.5 * recency) + (1.0 * importance) + (2.0 * activation)`

### `validateChapterRelevance()`
- Send a non-streaming LLM request asking "Is this chapter relevant to the user's current message?"
- Parse YES/NO from response
- 3-second timeout (use AbortController)
- Default to true on timeout (inclusive, not exclusive)

### `iterativeChapterFilter()`
- Take top 5 ranked chapters
- Validate each one via LLM
- Stop when 3 confirmed OR all 5 checked
- 3-second overall timeout (use Promise.race with setTimeout)

### `recallWithChapterFunnel()` - The Complete Funnel
1. Call `rankChapters()` with context activations
2. Call `iterativeChapterFilter()` to validate top chapters
3. From confirmed chapters, collect scene ranges
4. Call `recallArchiveScenes()` from `archiveMemory.ts` with scene ranges
5. Fallback: if funnel returns empty, use flat `recallArchiveScenes()` without ranges
6. Return the assembled scene text and token count

---

## Step 2: Export from chatEngine barrel

In `src/services/chatEngine.ts`, add the re-export:

```typescript
export { shouldAutoSeal, sealChapter, recallWithChapterFunnel } from './archiveChapterEngine';
```

---

## Verification
After creating the file:
1. `npm run build` should succeed
2. The service is not yet wired - that happens in Phase 7

## Reference
Read `../mainApp/src/services/archiveChapterEngine.ts` completely for all function bodies.
The mainApp version imports from `./llmService`, `./payloadBuilder`, `./archiveMemory` - all of which exist in mobileApp.
