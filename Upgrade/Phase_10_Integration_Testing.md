# Phase 10: Integration & Final Testing

## Goal
Wire everything together, verify all features work, fix any issues.

## Files to Verify
- All files modified in Phases 0-9
- Import chains are correct
- No orphan references

---

## Step 1: Verify Import Chains

Check that every new import resolves correctly:

```
types/index.ts exports:
  - CoreMemorySlot, SemanticFact, ArchiveChapter, BackupMeta

services/semanticMemory.ts imports:
  - SemanticFact from types ✓
  - sendMessage from llmService ✓

services/archiveChapterEngine.ts imports:
  - ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, SemanticFact from types ✓
  - sendMessage from llmService ✓
  - extractJson from payloadBuilder ✓
  - recallArchiveScenes from archiveMemory ✓

services/saveFileEngine.ts imports:
  - CoreMemorySlot from types (NEW) ✓

services/archiveMemory.ts imports:
  - NPCEntry, SemanticFact from types (NEW) ✓

store/slices/campaignSlice.ts imports:
  - ArchiveChapter, SemanticFact from types ✓

services/apiClient.ts imports:
  - ArchiveChapter, SemanticFact, BackupMeta from types ✓
```

---

## Step 2: Build Test

```bash
cd mobileApp
npm run build
```

Fix any TypeScript errors. Common issues:
- Missing type imports
- Wrong function signatures after parameter additions
- Barrel file (chatEngine.ts) missing new re-exports

---

## Step 3: Runtime Smoke Test

Start the server:
```bash
node server.js
```

Verify these endpoints respond correctly:
```bash
curl http://localhost:3001/api/campaigns/test/facts
# Should return: []

curl http://localhost:3001/api/campaigns/test/archive/chapters
# Should return: []

curl http://localhost:3001/api/campaigns/test/backups
# Should return: []
```

---

## Step 4: Feature Checklist

Test each new feature in the running app:

### Server
- [ ] `/api/campaigns/:id/facts` GET/PUT works
- [ ] `/api/campaigns/:id/archive/chapters` GET/POST works
- [ ] `/api/campaigns/:id/archive/chapters/seal` POST works
- [ ] `/api/campaigns/:id/backup` POST creates backup
- [ ] `/api/campaigns/:id/backups` GET lists backups
- [ ] Archive append includes keywordStrengths, npcStrengths, importance
- [ ] Archive append extracts semantic facts to .facts.json
- [ ] Archive append manages chapter lifecycle
- [ ] Scene rollback cascades to chapters and facts
- [ ] Campaign deletion cleans up .facts.json and .chapters.json
- [ ] Atomic file writes (writeJson uses .tmp + rename)

### Services
- [ ] `semanticMemory.ts` - fetchFacts, queryFacts, extractContextEntities, formatFactsForContext
- [ ] `archiveChapterEngine.ts` - shouldAutoSeal, sealChapter, rankChapters, validateChapterRelevance
- [ ] `saveFileEngine.ts` - JSON-slot Canon State, batch processing, Chapter Summary Generator
- [ ] `archiveMemory.ts` - 3D scoring, NPC/semantic awareness, partial truncation
- [ ] `condenser.ts` - AbortSignal support

### Store
- [ ] `chapters` state in campaignSlice
- [ ] `semanticFacts` state in campaignSlice
- [ ] `backupModalOpen` state in uiSlice
- [ ] `setCondenser` action in chatSlice
- [ ] Chapters/facts loaded on campaign select
- [ ] Auto-backup timer (if implemented)

### Components
- [ ] BackupModal renders and can create/list/restore/delete backups
- [ ] ChapterTab renders in ContextDrawer
- [ ] ChapterCard displays chapter info correctly
- [ ] ChatArea condensed memory panel works
- [ ] ChatArea chapter seal button works
- [ ] ChatArea condense cancellation works
- [ ] CampaignHub loads chapters/facts on select
- [ ] Header backup buttons visible on desktop

### Mobile-Specific
- [ ] All touch targets remain >= 48px
- [ ] Bottom sheet still works for ContextDrawer
- [ ] MobileNavBar still navigates correctly
- [ ] UI Scale slider still works
- [ ] AI Player toggles still work
- [ ] No iOS auto-zoom on inputs

---

## Step 5: Known Mobile-Only Features to PRESERVE

These features exist in mobileApp but NOT in mainApp. DO NOT remove them:

1. **AI Players** (enemy/neutral/ally) - toggle chips, color-coded messages, role badges, forced interventions
2. **MobileNavBar** - bottom tab navigation
3. **Bottom sheet** ContextDrawer with swipe-to-dismiss
4. **UI Scale** slider in settings
5. **Touch targets** (48px minimum)
6. **iOS zoom prevention** (16px input font)
7. **Grid card layout** in CampaignHub (vs mainApp's coverflow)
8. **Auto-enter** after campaign creation
9. **Sequential loading status** messages (vs mainApp's generic messages)
10. **Content chip rendering** (`renderContentWithChips`)
11. **idb-keyval** persistence for campaign store

---

## Step 6: Performance Notes

After all changes, mobileApp may be slightly slower due to:
- Semantic fact queries on every turn
- Chapter funnel validation (LLM calls)

These are acceptable trade-offs. Future optimizations:
- Cache semantic facts client-side with TTL
- Skip chapter funnel when no chapters exist
- Use Web Workers for heavy scoring computations

---

## Completion

Once all items in Step 4 pass, mobileApp is feature-equal to mainApp.

Remaining differences are **intentional** mobile adaptations:
- idb-keyval instead of pure server API (offline support)
- Sequential context gathering (simpler, works on mobile)
- Tailwind styling (lighter than mainApp's inline styles)
- Touch-optimized UI patterns
- Mobile navigation model (bottom nav + page slides)
