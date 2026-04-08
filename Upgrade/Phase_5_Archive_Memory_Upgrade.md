# Phase 5: Archive Memory Upgrade

## Goal
Upgrade `archiveMemory.ts` to use 3D scoring (recency + importance + activation), NPC/semantic fact awareness, scene range filtering, and partial truncation.

## Files to Modify
- `src/services/archiveMemory.ts` (MAJOR rewrite, ~130 lines added)

## Reference
Read `../mainApp/src/services/archiveMemory.ts` (263 lines) for the canonical implementation.

---

## Step 1: Add `extractContextActivations()` Function

Add this function that computes graded activation weights for entities in the current context:

```typescript
export function extractContextActivations(
    recentMessages: ChatMessage[],
    npcLedger: NPCEntry[]
): Record<string, number> {
    const activations: Record<string, number> = {};

    // 1. NPC names + aliases get 1.0 activation
    for (const npc of npcLedger) {
        activations[npc.name.toLowerCase()] = 1.0;
        if (npc.aliases) {
            for (const alias of npc.aliases) {
                activations[alias.toLowerCase()] = 1.0;
            }
        }
    }

    // 2. Last user message: scan for proper nouns, assign 1.0
    const lastUserMsg = [...recentMessages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
        const words = lastUserMsg.content.match(/[A-Z][a-z]{2,}/g) || [];
        for (const w of words) {
            if (!activations[w.toLowerCase()]) {
                activations[w.toLowerCase()] = 1.0;
            }
        }
    }

    // 3. Last 3 assistant messages: proper nouns get 0.7
    const recentAssistant = recentMessages.filter(m => m.role === 'assistant').slice(-3);
    for (const msg of recentAssistant) {
        const words = msg.content.match(/[A-Z][a-z]{2,}/g) || [];
        for (const w of words) {
            if (!activations[w.toLowerCase()]) {
                activations[w.toLowerCase()] = 0.7;
            }
        }
    }

    // 4. Last 10 messages: proper nouns get 0.3
    const older = recentMessages.slice(-10);
    for (const msg of older) {
        const words = msg.content.match(/[A-Z][a-z]{2,}/g) || [];
        for (const w of words) {
            if (!activations[w.toLowerCase()]) {
                activations[w.toLowerCase()] = 0.3;
            }
        }
    }

    return activations;
}
```

---

## Step 2: Add `expandActivationsWithFacts()` Function

Expand activations by cross-referencing semantic facts:

```typescript
export function expandActivationsWithFacts(
    activations: Record<string, number>,
    facts: SemanticFact[]
): Record<string, number> {
    const expanded = { ...activations };

    for (const fact of facts) {
        const subjectLower = fact.subject.toLowerCase();
        const objectLower = fact.object.toLowerCase();

        // If subject is active, activate object at 0.5x weight
        if (expanded[subjectLower] && !expanded[objectLower]) {
            expanded[objectLower] = expanded[subjectLower] * 0.5;
        }
        // If object is active, activate subject at 0.5x weight
        if (expanded[objectLower] && !expanded[subjectLower]) {
            expanded[subjectLower] = expanded[objectLower] * 0.5;
        }
    }

    return expanded;
}
```

---

## Step 3: Rewrite `scoreEntry()` to 3D Scoring

Replace the existing simple keyword-counting `scoreEntry` with 3D scoring:

```typescript
function scoreEntry(
    entry: ArchiveIndexEntry,
    contextText: string,
    contextActivations: Record<string, number>,
    totalScenes: number
): number {
    // D1: Recency (weight 0.5)
    const sceneNum = parseInt(entry.sceneId, 10) || 0;
    const turnsSince = Math.max(0, totalScenes - sceneNum);
    const recency = 1 / (1 + Math.log(1 + turnsSince));

    // D2: Importance (weight 1.0)
    const importance = entry.importance || 5;

    // D3: Activation (weight 2.0)
    let activation = 0;

    // 3a. Keyword strengths dot product with activations
    if (entry.keywordStrengths) {
        for (const [keyword, strength] of Object.entries(entry.keywordStrengths)) {
            if (contextActivations[keyword.toLowerCase()]) {
                activation += strength * contextActivations[keyword.toLowerCase()];
            }
        }
    } else {
        // Legacy fallback: simple keyword match
        for (const keyword of entry.keywords) {
            if (contextActivations[keyword.toLowerCase()]) {
                activation += 0.5;
            }
        }
    }

    // 3b. NPC strengths dot product with activations
    if (entry.npcStrengths) {
        for (const [npc, strength] of Object.entries(entry.npcStrengths)) {
            if (contextActivations[npc.toLowerCase()]) {
                activation += strength * contextActivations[npc.toLowerCase()];
            }
        }
    }

    // Combined score
    return (0.5 * recency) + (1.0 * (importance / 10)) + (2.0 * Math.min(activation, 5));
}
```

---

## Step 4: Upgrade `retrieveArchiveMemory()` Signature and Logic

Change the function signature to accept additional parameters:

```typescript
export function retrieveArchiveMemory(
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    maxScenes?: number,
    semanticFacts?: SemanticFact[],
    sceneRanges?: [string, string][]
): { entries: ArchiveIndexEntry[]; maxScenes: number }
```

New logic:
1. Build `contextActivations` from `extractContextActivations()`
2. If `semanticFacts` provided, expand with `expandActivationsWithFacts()`
3. If `sceneRanges` provided, filter index entries to only those within ranges
4. Score each filtered entry with the new 3D `scoreEntry()`
5. Sort by score descending
6. Dynamic maxScenes: if top score > 15 -> 5 scenes, > 8 -> 4, else 3
7. Return top entries

---

## Step 5: Upgrade `fetchArchiveScenes()` with Partial Truncation

Replace the hard `break` when budget exceeded with partial truncation:

```typescript
// When a scene exceeds remaining budget but remaining > 150 tokens:
if (usedTokens + sceneTokens > budget && usedTokens > 0) {
    if (budget - usedTokens > 150) {
        // Partially include this scene
        const partialContent = scene.content.slice(0, Math.floor((budget - usedTokens) * 3.5));
        result += `\n--- SCENE ${scene.sceneId} ---\n${partialContent}\n[...scene truncated for context budget...]\n`;
        usedTokens = budget;
    }
    break;
}
```

---

## Step 6: Upgrade `recallArchiveScenes()` Signature

Add `npcLedger` and `semanticFacts` parameters:

```typescript
export async function recallArchiveScenes(
    campaignId: string,
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    tokenBudget?: number,
    npcLedger?: NPCEntry[],
    semanticFacts?: SemanticFact[],
    sceneRanges?: [string, string][]
): Promise<{ scenes: string; usedTokens: number }>
```

Pass all new parameters through to `retrieveArchiveMemory()` and `fetchArchiveScenes()`.

---

## Step 7: Update Exports

Ensure all new functions are properly exported:
- `extractContextActivations` (exported)
- `expandActivationsWithFacts` (exported)
- `retrieveArchiveMemory` (existing, updated)
- `fetchArchiveScenes` (existing, updated)
- `recallArchiveScenes` (existing, updated)

---

## Verification
After completing this phase:
1. `npm run build` should succeed
2. The archive system now uses 3D scoring but is backward compatible (old index entries without `keywordStrengths`/`npcStrengths` will use legacy fallback scoring)
3. New archive appends (from Phase 1 server upgrade) will include strength data

## CRITICAL: Update imports
Add these imports at the top of `archiveMemory.ts`:
```typescript
import type { NPCEntry, SemanticFact } from '../types';
```
