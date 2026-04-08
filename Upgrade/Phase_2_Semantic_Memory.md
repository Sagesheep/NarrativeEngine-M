# Phase 2: Semantic Memory Service

## Goal
Create a new `semanticMemory.ts` service for querying semantic facts extracted by the server.

## Files to Create
- `src/services/semanticMemory.ts` (NEW file, ~120 lines)

## Reference
Read `../mainApp/src/services/semanticMemory.ts` for the canonical implementation.

---

## Overview
The server now extracts semantic facts (subject-predicate-object triples) from archived scenes. This service:
1. Fetches facts from the server API
2. Extracts entity names from the current context (NPC names, proper nouns)
3. Matches facts against active entities with importance scoring
4. Formats matched facts into a context block for LLM injection

---

## Step 1: Create `src/services/semanticMemory.ts`

Create the file with the following structure. Copy the COMPLETE implementation from `../mainApp/src/services/semanticMemory.ts`:

```typescript
import type { SemanticFact } from '../types';

// Fetch facts from server
export async function fetchFacts(campaignId: string): Promise<SemanticFact[]> {
    // GET /api/campaigns/:id/facts
    // Returns empty array on error
}

// Query facts matching entities in the current context
export function queryFacts(
    facts: SemanticFact[],
    entities: string[],
    tokenBudget: number,
    countTokens: (text: string) => number
): SemanticFact[] {
    // For each fact, check if subject or object matches any entity
    // Score by importance field
    // Sort by importance descending
    // Accumulate within token budget
    // Return matched facts
}

// Extract entity names from recent messages
export function extractContextEntities(
    recentMessages: Array<{ role: string; content: string }>,
    npcLedger: Array<{ name: string; aliases?: string[] }>
): string[] {
    // Get all NPC names + aliases from ledger
    // Scan last 5 messages for proper nouns (capitalized words 3+ chars)
    // Merge and deduplicate
    // Return unique entity list
}

// Format matched facts into context string
export function formatFactsForContext(facts: SemanticFact[]): string {
    // Format each fact as: "subject --predicate-> object [importance:N]"
    // Join with newlines
    // Wrap in [SEMANTIC MEMORY] / [END SEMANTIC MEMORY] tags
    // Return empty string if no facts
}
```

---

## Key Implementation Details

### `fetchFacts()`
- Use `fetch('/api/campaigns/' + campaignId + '/facts')`
- Return `[]` on any error (network, parse, 404)
- This is a non-critical call - never block the turn on it

### `queryFacts()`
- Match logic: a fact matches if `entities` contains `fact.subject` OR `fact.object` (case-insensitive)
- Score: use `fact.importance` (0-10 from server)
- Token budget: accumulate formatted facts until adding the next would exceed the budget
- Sort by importance DESC before accumulating

### `extractContextEntities()`
- NPC names + aliases get added first (highest priority)
- Then scan last 5 messages for words matching `/[A-Z][a-z]{2,}/g` (proper nouns)
- Filter out common words: `const STOP = new Set(['The', 'This', 'That', 'And', 'But', 'When', 'Where', 'What', 'How', 'Why', 'You', 'Your', 'They', 'Their', 'There', 'Then', 'Just', 'Not', 'Now', 'Can', 'Will', 'Was', 'Were', 'Has', 'Had', 'His', 'Her', 'She', 'His', 'Its'])`
- Deduplicate case-insensitively

### `formatFactsForContext()`
- Each fact: `${f.subject} --${f.predicate}-> ${f.object} [importance:${f.importance}]`
- Header: `[SEMANTIC MEMORY - ${count} verified facts]\n`
- Footer: `[END SEMANTIC MEMORY]`
- Empty return if no facts matched

---

## Verification
After creating the file:
1. `npm run build` should succeed
2. The service is not yet wired into anything - that happens in Phase 7

## Reference
Read `../mainApp/src/services/semanticMemory.ts` completely. Port the functions to mobileApp's patterns. The mainApp version uses `countTokens` from `../services/tokenizer` - mobileApp has the same tokenizer at `src/services/tokenizer.ts`.
