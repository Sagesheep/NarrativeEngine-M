# Phase 8: New Components

## Goal
Create the 3 missing components (BackupModal, ChapterTab, ChapterCard) and update ContextDrawer to include the Chapters tab.

## Files to Create
- `src/components/BackupModal.tsx` (NEW, ~200 lines)
- `src/components/context-drawer/ChapterTab.tsx` (NEW, ~120 lines)
- `src/components/context-drawer/ChapterCard.tsx` (NEW, ~60 lines)

## Files to Modify
- `src/components/ContextDrawer.tsx` (add ChapterTab)

## Reference
Read the corresponding mainApp component files for canonical implementations.

---

## Step 1: Create `src/components/context-drawer/ChapterCard.tsx`

This is a sub-component that renders a single chapter card.

```typescript
import React from 'react';
import type { ArchiveChapter } from '../../types';
import { BookOpen, Lock, AlertTriangle, ChevronRight } from 'lucide-react';

interface ChapterCardProps {
    chapter: ArchiveChapter;
    isSelected: boolean;
    isCollapsed: boolean;
    onClick: () => void;
    onSeal?: () => void;
}

export function ChapterCard({ chapter, isSelected, isCollapsed, onClick, onSeal }: ChapterCardProps) {
    // Render a card with:
    // - Chapter title (chapterId + title)
    // - Scene range badge (e.g., "Scenes 001-014")
    // - Scene count badge
    // - Sealed indicator (Lock icon + timestamp) if sealedAt exists
    // - Invalidated warning (AlertTriangle) if invalidated is true
    // - Keywords as small tags
    // - NPC names as small tags
    // - Summary (truncated to 2 lines when collapsed)
    // - Major events list (when expanded)
    // - Unresolved threads list (when expanded)
    // - Seal button (if not sealed and onSeal provided)
    //
    // Style: use Tailwind, consistent with existing context-drawer cards
    // Selected state: border-l-2 border-amber-400
    // Invalidated state: opacity-60 with warning badge
}
```

Read `../mainApp/src/components/context-drawer/ChapterCard.tsx` for the complete implementation.
Adapt styling to use Tailwind (mobileApp pattern) instead of inline styles (mainApp pattern).

---

## Step 2: Create `src/components/context-drawer/ChapterTab.tsx`

This is the full chapter management tab for the ContextDrawer.

```typescript
import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/apiClient';
import type { ArchiveChapter } from '../../types';
import { ChapterCard } from './ChapterCard';
import { Plus, Combine, Split, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from '../Toast';

export function ChapterTab() {
    const { chapters, setChapters, activeCampaignId } = useAppStore();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isSealing, setIsSealing] = useState(false);
    const [isMerging, setIsMerging] = useState(false);
    const [mergeTarget, setMergeTarget] = useState<string | null>(null);

    // Functions needed:
    // 1. handleCreateChapter - POST create new chapter
    // 2. handleSealChapter - POST seal current chapter
    // 3. handleMergeChapters - POST merge two chapters
    // 4. handleSplitChapter - POST split chapter at scene
    // 5. handleRefresh - reload chapters from server
    // 6. handleClearChapters - DELETE archive + chapters

    // Layout:
    // - Header with title "Chapters" + create/refresh buttons
    // - Seal button (prominent, at top)
    // - Chapter list (scrollable)
    //   - Each chapter rendered as ChapterCard
    //   - Click to expand/collapse details
    // - Merge mode: select two adjacent chapters, then merge button
    // - Split: when a chapter is selected, option to split at a scene boundary

    return (
        <div className="flex flex-col gap-3 p-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold uppercase tracking-wider text-terminal">
                    Chapters ({chapters.length})
                </h3>
                <div className="flex gap-2">
                    <button onClick={handleRefresh} className="touch-btn ...">
                        <RefreshCw size={14} />
                    </button>
                    <button onClick={handleCreateChapter} className="touch-btn ...">
                        <Plus size={14} />
                    </button>
                </div>
            </div>

            {/* Seal button */}
            <button onClick={handleSealChapter} disabled={isSealing} className="...">
                <Lock size={14} /> Seal Current Chapter
            </button>

            {/* Chapter list */}
            <div className="flex flex-col gap-2">
                {chapters.map(ch => (
                    <ChapterCard
                        key={ch.chapterId}
                        chapter={ch}
                        isSelected={selectedId === ch.chapterId}
                        isCollapsed={selectedId !== ch.chapterId}
                        onClick={() => setSelectedId(
                            selectedId === ch.chapterId ? null : ch.chapterId
                        )}
                    />
                ))}
            </div>

            {/* Empty state */}
            {chapters.length === 0 && (
                <p className="text-xs text-center opacity-50 py-4">
                    No chapters yet. Archive scenes to auto-generate chapters.
                </p>
            )}
        </div>
    );
}
```

Read `../mainApp/src/components/context-drawer/ChapterTab.tsx` for the complete implementation.
Adapt to mobileApp patterns (Tailwind, touch-btn classes, mobile-friendly sizing).

---

## Step 3: Create `src/components/BackupModal.tsx`

Full backup manager modal with create, list, restore, and delete functionality.

```typescript
import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/apiClient';
import type { BackupMeta } from '../types';
import { X, Download, Upload, Trash2, Clock, Shield, Save, AlertTriangle } from 'lucide-react';
import { toast } from './Toast';

interface BackupModalProps {
    // No props needed - reads activeCampaignId from store
}

export function BackupModal({}: BackupModalProps) {
    const { backupModalOpen, toggleBackupModal, activeCampaignId } = useAppStore();
    const [backups, setBackups] = useState<BackupMeta[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isCreating, setIsCreating] = useState(false);

    // Functions:
    // 1. loadBackups() - GET list from server
    // 2. handleCreateBackup() - POST create with label
    // 3. handleRestore(ts) - POST restore
    // 4. handleDelete(ts) - DELETE backup
    // 5. formatDate(ts) - human-readable timestamp

    // Layout (MOBILE-OPTIMIZED):
    // Full-screen overlay on mobile, centered modal on desktop
    // Header: "Campaign Backups" + close button
    // Create section: label input + create button
    // Backup list: cards showing timestamp, label, trigger badge, file count
    // Each card: restore button + delete button
    // Auto-backups shown with "Auto" badge
    // Manual backups shown with "Manual" badge

    if (!backupModalOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-surface border border-border rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col mx-4">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-lg font-bold text-terminal">Campaign Backups</h2>
                    <button onClick={toggleBackupModal} className="touch-btn ...">
                        <X size={20} />
                    </button>
                </div>

                {/* Create section */}
                <div className="p-4 border-b border-border flex gap-2">
                    <input
                        type="text"
                        placeholder="Backup label..."
                        className="flex-1 bg-void border border-border rounded px-3 py-2 text-sm"
                    />
                    <button onClick={handleCreateBackup} disabled={isCreating} className="touch-btn ...">
                        <Save size={16} /> Create
                    </button>
                </div>

                {/* Backup list */}
                <div className="flex-1 overflow-y-auto p-4">
                    {backups.map(b => (
                        <div key={b.timestamp} className="...">
                            {/* Backup card with: timestamp, label, trigger badge, file count */}
                            {/* Restore + Delete buttons */}
                        </div>
                    ))}
                    {backups.length === 0 && (
                        <p className="text-center opacity-50 py-8">No backups yet</p>
                    )}
                </div>
            </div>
        </div>
    );
}
```

Read `../mainApp/src/components/BackupModal.tsx` for the complete implementation.
Adapt to mobileApp patterns (mobile-fullscreen, touch-btn, safe areas).

---

## Step 4: Update `ContextDrawer.tsx`

Add the ChapterTab to the ContextDrawer.

### 4a. Add import
```typescript
import { ChapterTab } from './context-drawer/ChapterTab';
```

### 4b. Add tab to mobile bottom sheet tabs

Find the tab list in the mobile bottom sheet section. Add a new tab:

```typescript
// Add "Chapters" tab between Engines and Save tabs
{ key: 'chapters', label: 'Chapters', icon: BookOpen, shortLabel: 'CH' }
```

### 4c. Add tab to desktop sidebar tabs

Same addition in the desktop tab list.

### 4d. Add render case
In the tab content rendering section, add:

```typescript
{activeTab === 'chapters' && <ChapterTab />}
```

### 4e. Import `BookOpen` from lucide-react

---

## Verification
After completing this phase:
1. `npm run build` should succeed
2. ContextDrawer now has 6 tabs (was 5): System, World, Engines, Save, Chapters, Bookkeep
3. BackupModal renders when `backupModalOpen` is true
4. ChapterTab shows the chapter list from the store
5. All components use mobileApp styling patterns (Tailwind, touch-btn, safe areas)
