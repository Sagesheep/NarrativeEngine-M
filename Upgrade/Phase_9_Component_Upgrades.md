# Phase 9: Existing Component Upgrades

## Goal
Upgrade existing components to use the new features: chapter sealing, condensed memory panel, backup integration, semantic facts loading, and performance optimization.

## Files to Modify
- `src/components/ChatArea.tsx` (MAJOR additions)
- `src/components/CampaignHub.tsx` (minor additions)
- `src/components/Header.tsx` (minor additions)
- `src/components/NPCLedgerModal.tsx` (moderate additions)
- `src/components/App.tsx` (minor additions)
- `src/components/TokenGauge.tsx` (minor optimization)

## Reference
Read the corresponding mainApp component files for canonical implementations.

---

## Step 1: Upgrade `ChatArea.tsx`

### 1a. Add new imports
```typescript
import { shouldAutoSeal, sealChapter } from '../services/archiveChapterEngine';
import { generateChapterSummary } from '../services/saveFileEngine';
import type { ArchiveChapter } from '../types';
import { FileText, ChevronDown, ChevronUp, RotateCw } from 'lucide-react';
```

### 1b. Add condense cancellation support
Add a ref for AbortController:
```typescript
const condenseAbortRef = React.useRef<AbortController | null>(null);
```

When starting condensation:
```typescript
condenseAbortRef.current = new AbortController();
// Pass condenseAbortRef.current.signal to condenseHistory
```

Change the condense button to show "Stop" when condensing:
```typescript
{isCondensing ? (
    <button onClick={() => condenseAbortRef.current?.abort()} className="...">
        <Square size={14} /> STOP
    </button>
) : (
    <button onClick={handleCondense} className="...">
        <Zap size={14} /> CONDENSE
    </button>
)}
```

### 1c. Add Condensed Memory Panel
Add a collapsible panel below the message list that shows the current condensed summary:

```typescript
const [showCondensedPanel, setShowCondensedPanel] = React.useState(false);
const [editingSummary, setEditingSummary] = React.useState(false);
const [summaryDraft, setSummaryDraft] = React.useState('');
```

The panel should have:
- Toggle button in macro bar: "MEMORY" with ChevronDown/Up icon
- When open, shows the condensed summary text
- Edit button to enter edit mode (textarea)
- Save button to apply edits (calls `setCondensed`)
- "Retcon" button to delete all messages and keep only the summary as a system message
- "Reset" button to clear the condenser state entirely
- Close button

Position: Between message list and macro bar, or as an overlay.

### 1d. Add Chapter Seal button to macro bar
Add a "Seal" button that:
1. Calls `sealChapter(activeCampaignId)`
2. Optionally generates a chapter summary via `generateChapterSummary()`
3. Refreshes chapters from server
4. Shows success toast

```typescript
const handleSealChapter = async () => {
    if (!activeCampaignId) return;
    try {
        await sealChapter(activeCampaignId);
        const updated = await api.chapters.list(activeCampaignId);
        setChapters(updated);
        toast.success('Chapter sealed');
    } catch (err) {
        toast.error('Failed to seal chapter');
    }
};
```

### 1e. Add auto-seal check after turns
After each successful turn (in the turn completion handler), check:

```typescript
if (chapters.length > 0 && shouldAutoSeal(chapters)) {
    handleSealChapter(); // fire-and-forget
}
```

### 1f. Add semantic facts refresh
After condensation and archive operations, refresh semantic facts:

```typescript
if (activeCampaignId && setSemanticFacts) {
    const freshFacts = await api.facts.get(activeCampaignId).catch(() => []);
    setSemanticFacts(freshFacts);
}
```

### 1g. Add pre-rollback backup
Before any archive rollback operation:

```typescript
await api.backup.create(activeCampaignId, {
    trigger: 'pre-rollback',
    isAuto: true,
});
```

### 1h. Add chapter repair on rollback
After rollback, refresh chapters:

```typescript
const updated = await api.chapters.list(activeCampaignId).catch(() => []);
setChapters(updated);
```

### 1i. Progressive pagination (optional optimization)
Replace the flat `visibleCount += 20` with progressive batch sizes:

```typescript
const [loadStep, setLoadStep] = React.useState(0);
const BATCH_SIZES = [10, 20, 40, 80];
const handleLoadMore = () => setLoadStep(s => Math.min(s + 1, BATCH_SIZES.length - 1));
// visibleCount = BATCH_SIZES.slice(0, loadStep + 1).reduce((a, b) => a + b, 0);
```

### 1j. Add `useShallow` optimization (optional)
If performance is an issue, split the store subscription:

```typescript
import { useShallow } from 'zustand/react/shallow';

const stableData = useAppStore(useShallow(s => ({
    messages: s.messages,
    context: s.context,
    condenser: s.condenser,
    chapters: s.chapters,
    semanticFacts: s.semanticFacts,
})));

const actions = useAppStore(useShallow(s => ({
    // ... all action functions ...
})));
```

---

## Step 2: Upgrade `CampaignHub.tsx`

### 2a. Add engine seed extraction on lore upload
When a lore file is uploaded and chunked, extract engine seeds:

```typescript
import { extractEngineSeeds } from '../services/loreEngineSeeder';
import { parseNPCsFromLore } from '../services/loreNPCParser';
```

After `chunkLoreFile()` succeeds:
```typescript
const seeds = extractEngineSeeds(chunks);
if (seeds) {
    // Update context with extracted surpriseConfig, encounterConfig, worldEventConfig tags
    updateContext({
        ...context,
        surpriseConfig: { ...context.surpriseConfig, types: seeds.surpriseTypes || context.surpriseConfig.types, tones: seeds.surpriseTones || context.surpriseConfig.tones },
        encounterConfig: { ...context.encounterConfig, types: seeds.encounterTypes || context.encounterConfig.types, tones: seeds.encounterTones || context.encounterConfig.tones },
        worldEventConfig: { ...context.worldEventConfig, who: seeds.worldWho || context.worldEventConfig.who, where: seeds.worldWhere || context.worldEventConfig.where, why: seeds.worldWhy || context.worldEventConfig.why, what: seeds.worldWhat || context.worldEventConfig.what },
    });
}
```

### 2b. Add NPC dedup from lore
After parsing NPCs from lore:

```typescript
const loreNPCs = parseNPCsFromLore(chunks);
if (loreNPCs.length > 0) {
    const merged = dedupeNPCLedger([...npcLedger, ...loreNPCs]);
    setNPCLedger(merged);
    await saveNPCLedger(campaignId, merged);
}
```

### 2c. Load semantic facts and chapters on campaign select
In `handleSelectCampaign`:

```typescript
const [facts, chaps] = await Promise.all([
    api.facts.get(campaign.id).catch(() => []),
    api.chapters.list(campaign.id).catch(() => []),
]);
setSemanticFacts(facts);
setChapters(chaps);
```

### 2d. Add pre-delete backup
Before deleting a campaign:

```typescript
await api.backup.create(campaignId, { trigger: 'pre-delete', isAuto: true });
```

---

## Step 3: Upgrade `Header.tsx`

### 3a. Add backup buttons (desktop only)
Add two buttons visible only on desktop:

```typescript
{/* Manual backup button */}
<button onClick={handleManualBackup} className="hidden md:inline-flex touch-btn ..." title="Create Backup">
    <Save size={16} />
</button>

{/* Backup manager button */}
<button onClick={toggleBackupModal} className="hidden md:inline-flex touch-btn ..." title="Manage Backups">
    <Archive size={16} />
</button>
```

### 3b. Add pre-clear backup
Before clearing chat:

```typescript
const handleClearChat = async () => {
    if (activeCampaignId) {
        await api.backup.create(activeCampaignId, { trigger: 'pre-clear', isAuto: true }).catch(() => {});
    }
    clearChat();
};
```

---

## Step 4: Upgrade `NPCLedgerModal.tsx`

### 4a. Add bulk select mode
```typescript
const [selectMode, setSelectMode] = React.useState(false);
const [checkedIds, setCheckedIds] = React.useState<Set<string>>(new Set());
```

Add select/deselect all, bulk delete functionality.

### 4b. Add seed from lore
```typescript
import { parseNPCsFromLore } from '../services/loreNPCParser';

const handleSeedFromLore = async () => {
    const chunks = useAppStore.getState().loreChunks;
    const loreNPCs = parseNPCsFromLore(chunks);
    // Merge visual profiles with existing NPCs
    const merged = dedupeNPCLedger([...npcLedger, ...loreNPCs]);
    setNPCLedger(merged);
    toast.success(`Seeded ${loreNPCs.length} NPCs from lore`);
};
```

### 4c. Fix import handler
Replace the empty `onChange={() => {}}` with functional JSON import:

```typescript
const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target?.result as string);
            if (Array.isArray(data)) {
                const imported = data.map(mapImportFields);
                const merged = dedupeNPCLedger([...npcLedger, ...imported]);
                setNPCLedger(merged);
                toast.success(`Imported ${imported.length} NPCs`);
            }
        } catch {
            toast.error('Invalid JSON file');
        }
    };
    reader.readAsText(file);
};
```

### 4d. Add pre-op backup before bulk delete
```typescript
await api.backup.create(activeCampaignId, { trigger: 'pre-npc-bulk-delete', isAuto: true });
```

---

## Step 5: Upgrade `App.tsx`

### 5a. Import and render BackupModal
```typescript
import { BackupModal } from './BackupModal';
```

Add in the render tree (both campaign hub and game views):
```typescript
<BackupModal />
```

### 5b. Load chapters and semantic facts on campaign select
Where campaign hydration happens, add:

```typescript
import { loadChapters } from './store/campaignStore';
```

In the campaign hydration effect:
```typescript
const chapters = await loadChapters(activeCampaignId).catch(() => []);
const facts = await loadSemanticFacts(activeCampaignId).catch(() => []);
setChapters(chapters);
setSemanticFacts(facts);
```

### 5c. Force `isCondensing: false` on hydration
When loading campaign state, ensure condenser is not stuck:
```typescript
setCondenser({ ...loadedState.condenser, isCondensing: false });
```

---

## Step 6: Upgrade `TokenGauge.tsx` (optional performance)

Add `useMemo` for token count computations:

```typescript
const systemText = React.useMemo(() =>
    [context.canonState, context.headerIndex, context.rulesRaw, /* etc */]
        .filter(Boolean).join('\n'),
    [context.canonState, context.headerIndex, context.rulesRaw, /* etc */]
);

const historyText = React.useMemo(() =>
    messages.slice(-20).map(m => m.content).join('\n'),
    [messages]
);
```

---

## Verification
After completing this phase:
1. `npm run build` should succeed
2. ChatArea has: condensed memory panel, chapter seal button, condense cancellation, auto-seal check
3. CampaignHub loads chapters/facts on select, extracts engine seeds from lore, deduplicates NPCs from lore
4. Header has backup buttons on desktop
5. NPCLedgerModal has bulk select, seed from lore, functional import
6. App loads chapters/facts during hydration
7. All new features use mobileApp patterns (touch-btn, Tailwind, mobile navigation)
