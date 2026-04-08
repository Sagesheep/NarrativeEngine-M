# Phase 0: Types & Dependencies

## Goal
Add missing TypeScript types and ensure all required packages are installed.

## Files to Modify
- `src/types/index.ts` (ADD types and fields)

## No New Dependencies Needed
mobileApp already has `js-tiktoken`, `idb-keyval`, `zustand`, etc.

---

## Step 1: Add 4 New Types to `src/types/index.ts`

Open `src/types/index.ts` and ADD the following types AFTER the existing `PayloadTrace` type (at the end of the file, before the last line):

### Type 1: CoreMemorySlot
```typescript
export type CoreMemorySlot = {
    key: string;
    value: string;
    priority: number;
    sceneId: string;
};
```

### Type 2: SemanticFact
```typescript
export type SemanticFact = {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    importance: number;
    sceneId: string;
    timestamp: number;
};
```

### Type 3: ArchiveChapter
```typescript
export type ArchiveChapter = {
    chapterId: string;
    title: string;
    sceneRange: [string, string];
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
    sceneCount: number;
    sealedAt?: number;
    invalidated?: boolean;
    _lastSeenSessionId?: string;
};
```

### Type 4: BackupMeta
```typescript
export type BackupMeta = {
    timestamp: number;
    label: string;
    trigger: string;
    hash: string;
    fileCount: number;
    isAuto: boolean;
    campaignName: string;
};
```

---

## Step 2: Add Missing Fields to Existing Types

### Add to `GameContext` type:
Find the `GameContext` type in `types/index.ts`. Add this field alongside the other optional fields:

```typescript
    coreMemorySlots?: CoreMemorySlot[];
```

Put it after `canonState` or near the other context fields.

### Add to `ArchiveIndexEntry` type:
Find the `ArchiveIndexEntry` type. Add these 3 fields:

```typescript
    keywordStrengths?: Record<string, number>;
    npcStrengths?: Record<string, number>;
    importance?: number;
```

Put them after the existing `userSnippet` field.

---

## Verification
After completing this phase, run:
```bash
npm run build
```
It should compile with no type errors. The new types are not yet used anywhere, so they won't affect runtime behavior.

## Reference
Read `../mainApp/src/types/index.ts` lines 127, 163-165, 287-329 to see the canonical definitions.
