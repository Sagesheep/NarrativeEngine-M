# Phase 7: Condenser & Turn Orchestrator Upgrades

## Goal
Add AbortSignal support to condenser, upgrade turnOrchestrator with chapter funnel, semantic facts, abort detection, and error handling improvements.

## Files to Modify
- `src/services/condenser.ts` (minor change)
- `src/services/turnOrchestrator.ts` (MAJOR changes, ~120 lines)
- `src/services/payloadBuilder.ts` (minor changes)

## Reference
Read the corresponding mainApp files for canonical implementations.

---

## Step 1: Add AbortSignal to `condenser.ts`

### 1a. Update `condenseHistory` signature
Add `signal?: AbortSignal` as the last parameter:

```typescript
export async function condenseHistory(
    messages: ChatMessage[],
    contextLimit: number,
    endpoint: { endpoint: string; apiKey: string; modelName: string },
    existingSummary?: string,
    canonState?: string,
    headerIndex?: string,
    signal?: AbortSignal
): Promise<CondenserState>
```

### 1b. Pass signal to fetch calls
In both the meta-summary `fetch()` call and the main condensation `fetch()` call, add:

```typescript
const response = await fetch(endpoint.endpoint + '/chat/completions', {
    method: 'POST',
    headers: { ... },
    body: JSON.stringify(payload),
    signal,  // ADD THIS
});
```

This allows condensation to be cancelled from the UI.

---

## Step 2: Upgrade `payloadBuilder.ts`

### 2a. Add Core Memory Slot rendering

In the `buildPayload` function, replace the simple `context.canonState` push with structured rendering:

Find where `stableParts.push(context.canonState)` happens. Replace with:

```typescript
if (context.coreMemorySlots && context.coreMemorySlots.length > 0) {
    const sorted = [...context.coreMemorySlots].sort((a, b) => b.priority - a.priority);
    const lines = sorted.map(s => `${s.key} [p${s.priority}]: ${s.value}`);
    stableParts.push(
        `[CORE MEMORY -- ALWAYS ACCURATE]\n` +
        lines.join('\n') +
        `\n[END CORE MEMORY]`
    );
} else if (context.canonState) {
    // Legacy fallback for old text-format canon state
    stableParts.push(context.canonState);
}
```

### 2b. Add Semantic Memory Facts injection

Add a new parameter `semanticFactText?: string` to `buildPayload`:

```typescript
export function buildPayload(
    // ... existing params ...
    semanticFactText?: string
): { messages: OpenAIMessage[]; trace: PayloadTrace }
```

In the world context section, add after the lore block:

```typescript
if (semanticFactText) {
    worldParts.push(semanticFactText);
}
```

---

## Step 3: Upgrade `turnOrchestrator.ts`

This is the biggest change. Open `src/services/turnOrchestrator.ts` and make these modifications:

### 3a. Add new imports

```typescript
import { extractContextActivations, expandActivationsWithFacts } from './archiveMemory';
import { shouldAutoSeal, sealChapter, recallWithChapterFunnel } from './archiveChapterEngine';
import { fetchFacts, queryFacts, extractContextEntities, formatFactsForContext } from './semanticMemory';
import { useAppStore } from '../store/useAppStore';
```

### 3b. Add chapters and semantic facts to TurnCallbacks

```typescript
export type TurnCallbacks = {
    // ... existing callbacks ...
    setSemanticFacts?: (facts: SemanticFact[]) => void;
    setChapters?: (chapters: ArchiveChapter[]) => void;
};
```

### 3c. Add chapter-aware archive retrieval

Find the archive retrieval section in `runTurn` (where `recallArchiveScenes` is called).

Replace the simple call with chapter funnel logic:

```typescript
// --- ARCHIVE RECALL ---
setLoadingStatus('[3/5] Recalling Archive Memory...');

let archiveResult = { scenes: '', usedTokens: 0 };
const chapters = useAppStore.getState().chapters;
const semanticFacts = useAppStore.getState().semanticFacts;
const npcLedger = useAppStore.getState().npcLedger;

if (chapters.length > 0) {
    // Use chapter-aware retrieval
    try {
        const funnelPromise = recallWithChapterFunnel(
            activeCampaignId,
            chapters,
            archiveIndex,
            userText,
            recentMessages,
            npcLedger,
            semanticFacts,
            3000, // token budget for archive
            utilityEndpoint, // for LLM chapter validation
            countTokens
        );
        const fallbackPromise = new Promise(resolve => setTimeout(resolve, 5000)).then(() => null);

        archiveResult = await Promise.race([funnelPromise, fallbackPromise]) || archiveResult;
    } catch {
        // Fallback to flat retrieval
        archiveResult = await recallArchiveScenes(activeCampaignId, archiveIndex, userText, recentMessages, 3000);
    }
} else {
    // No chapters, use flat retrieval with upgraded scoring
    archiveResult = await recallArchiveScenes(
        activeCampaignId, archiveIndex, userText, recentMessages, 3000,
        npcLedger, semanticFacts
    );
}
```

### 3d. Add semantic facts injection

After archive recall, add semantic fact processing:

```typescript
// --- SEMANTIC FACTS ---
let semanticFactText = '';
try {
    const entities = extractContextEntities(recentMessages, npcLedger);
    semanticFactText = formatFactsForContext(
        queryFacts(semanticFacts, entities, 500, countTokens)
    );
} catch {
    // Non-critical, continue without facts
}
```

### 3e. Pass semanticFactText to buildPayload

Where `buildPayload` is called, add the new parameter:

```typescript
const result = buildPayload(
    // ... existing args ...
    semanticFactText  // NEW parameter
);
```

### 3f. Add abort detection in error handler

In the main catch block of `runTurn`, add abort detection at the top:

```typescript
} catch (err: any) {
    if (err === 'AbortError' || err?.name === 'AbortError' || err === 'The user aborted a request.') {
        return; // User cancelled, silently exit
    }
    // ... existing error handling ...
}
```

### 3g. Add `.catch()` to NPC generation

Where `generateNPCProfile` is called, add `.catch()`:

```typescript
generateNPCProfile(name, messages, getActiveStoryEndpoint()).catch(() => {});
```

### 3h. Add save pipeline error isolation

Wrap the save pipeline in its own try/catch:

```typescript
try {
    const saveResult = await runSaveFilePipeline(messages, endpoint, coreMemorySlots, countTokens);
    if (saveResult.coreMemorySlots) {
        // Update coreMemorySlots in context
        updateContext({ ...context, coreMemorySlots: saveResult.coreMemorySlots });
    }
} catch (err) {
    // Non-fatal, just warn
    toast.warning('Save pipeline failed', 'State not updated');
}
```

### 3i. Add semantic facts refresh after archive

After archive append, refresh semantic facts:

```typescript
if (callbacks.setSemanticFacts && activeCampaignId) {
    const freshFacts = await fetchFacts(activeCampaignId).catch(() => []);
    callbacks.setSemanticFacts(freshFacts);
}
```

### 3j. Add chapter auto-seal check

After archiving, check if chapter should be auto-sealed:

```typescript
if (chapters.length > 0 && shouldAutoSeal(chapters)) {
    try {
        const sealed = await sealChapter(activeCampaignId);
        if (sealed && callbacks.setChapters) {
            const updatedChapters = await loadChapters(activeCampaignId);
            callbacks.setChapters(updatedChapters);
        }
    } catch {
        // Non-critical
    }
}
```

---

## Verification
After completing this phase:
1. `npm run build` should succeed
2. The turn orchestrator now:
   - Uses 3D archive scoring with NPC/semantic fact awareness
   - Injects semantic facts into the LLM payload
   - Detects user-initiated aborts silently
   - Isolates save pipeline errors
   - Auto-seals chapters when threshold reached
   - Refreshes semantic facts after archiving
3. The condenser can be cancelled via AbortSignal
4. Core memory slots are rendered with priority sorting
