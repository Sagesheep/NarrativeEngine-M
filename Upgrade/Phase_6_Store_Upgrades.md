# Phase 6: Store Layer Upgrades

## Goal
Add missing state, actions, and campaignStore methods for chapters, semantic facts, backups, and fix stale-closure vulnerability.

## Files to Modify
- `src/store/campaignStore.ts` (ADD ~60 lines)
- `src/store/slices/campaignSlice.ts` (ADD ~50 lines)
- `src/store/slices/chatSlice.ts` (ADD ~5 lines)
- `src/store/slices/uiSlice.ts` (ADD ~5 lines)
- `src/services/apiClient.ts` (ADD ~30 lines)

## Reference
Read the corresponding mainApp files for canonical implementations.

---

## Step 1: Add to `apiClient.ts`

Add these API client methods to the `api` object in `src/services/apiClient.ts`:

### Facts API
```typescript
facts: {
    get: async (campaignId: string): Promise<SemanticFact[]> => {
        const res = await fetch(`/api/campaigns/${campaignId}/facts`);
        if (!res.ok) return [];
        return res.json();
    },
    save: async (campaignId: string, facts: SemanticFact[]): Promise<void> => {
        await fetch(`/api/campaigns/${campaignId}/facts`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(facts),
        });
    },
},
```

### Chapters API
```typescript
chapters: {
    list: async (campaignId: string): Promise<ArchiveChapter[]> => {
        const res = await fetch(`/api/campaigns/${campaignId}/archive/chapters`);
        if (!res.ok) return [];
        return res.json();
    },
    create: async (campaignId: string, title?: string): Promise<ArchiveChapter> => {
        const res = await fetch(`/api/campaigns/${campaignId}/archive/chapters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title || 'New Chapter' }),
        });
        return res.json();
    },
    update: async (campaignId: string, chapterId: string, patch: Partial<ArchiveChapter>): Promise<void> => {
        await fetch(`/api/campaigns/${campaignId}/archive/chapters/${chapterId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
    },
    seal: async (campaignId: string): Promise<any> => {
        const res = await fetch(`/api/campaigns/${campaignId}/archive/chapters/seal`, { method: 'POST' });
        return res.json();
    },
    merge: async (campaignId: string, chapterA: string, chapterB: string): Promise<any> => {
        const res = await fetch(`/api/campaigns/${campaignId}/archive/chapters/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chapterA, chapterB }),
        });
        return res.json();
    },
    split: async (campaignId: string, chapterId: string, atSceneId: string): Promise<any> => {
        const res = await fetch(`/api/campaigns/${campaignId}/archive/chapters/${chapterId}/split`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ atSceneId }),
        });
        return res.json();
    },
},
```

### Backup API
```typescript
backup: {
    create: async (campaignId: string, opts: { label?: string; trigger?: string; isAuto?: boolean }): Promise<any> => {
        const res = await fetch(`/api/campaigns/${campaignId}/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts),
        });
        return res.json();
    },
    list: async (campaignId: string): Promise<BackupMeta[]> => {
        const res = await fetch(`/api/campaigns/${campaignId}/backups`);
        if (!res.ok) return [];
        return res.json();
    },
    read: async (campaignId: string, timestamp: number): Promise<any> => {
        const res = await fetch(`/api/campaigns/${campaignId}/backups/${timestamp}`);
        return res.json();
    },
    restore: async (campaignId: string, timestamp: number): Promise<any> => {
        const res = await fetch(`/api/campaigns/${campaignId}/backups/${timestamp}/restore`, { method: 'POST' });
        return res.json();
    },
    delete: async (campaignId: string, timestamp: number): Promise<void> => {
        await fetch(`/api/campaigns/${campaignId}/backups/${timestamp}`, { method: 'DELETE' });
    },
},
```

Add the necessary type imports at the top: `ArchiveChapter`, `SemanticFact`, `BackupMeta`.

---

## Step 2: Add to `campaignStore.ts`

Add these async functions:

```typescript
export async function loadSemanticFacts(campaignId: string): Promise<SemanticFact[]> {
    return api.facts.get(campaignId);
}

export async function loadChapters(campaignId: string): Promise<ArchiveChapter[]> {
    return api.chapters.list(campaignId);
}
```

Import them from `./apiClient` or use direct `fetch`.

---

## Step 3: Add to `campaignSlice.ts`

### 3a. Import new types
```typescript
import type { ArchiveChapter, SemanticFact } from '../../types';
```

### 3b. Add new state fields
Add to the `CampaignSlice` type:
```typescript
chapters: ArchiveChapter[];
semanticFacts: SemanticFact[];
```

### 3c. Add initial values in `createCampaignSlice`
```typescript
chapters: [],
semanticFacts: [],
```

### 3d. Add new actions
```typescript
setChapters: (chapters: ArchiveChapter[]) => void;
setSemanticFacts: (facts: SemanticFact[]) => void;
```

Implementation:
```typescript
setChapters: (chapters) => set({ chapters }),
setSemanticFacts: (facts) => set({ semanticFacts: facts }),
```

### 3e. Add `coreMemorySlots` to `defaultContext`
```typescript
coreMemorySlots: [],
```

### 3f. Load chapters and facts on campaign select
In the `setActiveCampaign` action (or wherever campaigns are loaded), add:
```typescript
// Load chapters and semantic facts
const { loadChapters, loadSemanticFacts } = await import('../campaignStore');
const chapters = await loadChapters(id);
const facts = await loadSemanticFacts(id);
set({ chapters, semanticFacts: facts });
```

### 3g. Add `_registerCampaignStateGetter` pattern (optional but recommended)
This fixes the stale-closure vulnerability in `debouncedSaveCampaignState`:

```typescript
let _getStateForSave: (() => { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }) | null = null;

// In createCampaignSlice:
_registerCampaignStateGetter: (getter: () => any) => {
    _getStateForSave = getter;
},
```

Then update `debouncedSaveCampaignState` to use `_getStateForSave()` instead of passed arguments.

### 3h. Add `debouncedSaveLoreChunks`
```typescript
let loreTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveLoreChunks(campaignId: string, chunks: LoreChunk[]) {
    if (loreTimer) clearTimeout(loreTimer);
    loreTimer = setTimeout(async () => {
        const { saveLoreChunks } = await import('../campaignStore');
        await saveLoreChunks(campaignId, chunks);
    }, 1000);
}
```

### 3i. Add `preOpBackup` action
```typescript
preOpBackup: async (campaignId: string, trigger: string) => {
    const { api } = await import('../services/apiClient');
    await api.backup.create(campaignId, { trigger, isAuto: true });
},
```

Call this before destructive NPC operations (removeNPC, etc.).

---

## Step 4: Add to `chatSlice.ts`

### 4a. Add `setCondenser` action
```typescript
setCondenser: (state: CondenserState) => void;
```

Implementation:
```typescript
setCondenser: (newState) => set({ condenser: newState }),
```

### 4b. Add guard to `setCondensed`
```typescript
setCondensed: (summary) => set(s => {
    const safeSummary = summary || s.condenser.condensedSummary;
    return {
        condenser: { ...s.condenser, condensedSummary: safeSummary },
    };
}),
```

---

## Step 5: Add to `uiSlice.ts`

Add backup modal state:
```typescript
backupModalOpen: boolean;
toggleBackupModal: () => void;
```

Implementation:
```typescript
backupModalOpen: false,
toggleBackupModal: () => set(s => ({ backupModalOpen: !s.backupModalOpen })),
```

---

## Verification
After completing this phase:
1. `npm run build` should succeed
2. The store now has `chapters`, `semanticFacts`, `backupModalOpen` state
3. New actions `setChapters`, `setSemanticFacts`, `setCondenser`, `toggleBackupModal` are available
4. `debouncedSaveCampaignState` has the stale-closure fix (if implemented)
