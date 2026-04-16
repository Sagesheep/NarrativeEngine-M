# Wave 4 — Decompose `offlineStorage.ts`

> **Scope:** Split the 496-line storage monolith into domain modules behind an identical facade.
> **Risk:** Low — the public API shape does not change.
> **Depends on:** Wave 1 (clean types).
> **Verify:** `tsc -b && vite build` + manual test (load campaign, play a turn, check archive persistence)

## Why

`offlineStorage.ts` mixes 7 storage domains (archive, chapters, facts, timeline, entities, backup, embeddings) plus shared helpers into a single 496-line file. Each domain has its own logic and could be reasoned about independently.

## Target Structure

```
src/services/storage/
  index.ts                 ← Assembles and re-exports `offlineStorage` (facade)
  _helpers.ts              ← Shared: getList, setList, k(), computeHash(), SceneRecord type
  archiveStorage.ts        ← Archive domain
  chapterStorage.ts        ← Chapter domain
  factStorage.ts           ← Facts domain
  timelineStorage.ts       ← Timeline domain
  entityStorage.ts         ← Entity domain
  backupStorage.ts         ← Backup domain
  embeddingStorage.ts      ← Embedding domain
```

## Tasks

### 4.1 — Create `src/services/storage/` directory

Create the directory.

### 4.2 — Extract `_helpers.ts`

Move from `offlineStorage.ts`:
- `getList<T>()` function
- `setList<T>()` function
- `k()` function
- `computeHash()` function
- `SceneRecord` type

All other modules import from `./_helpers`.

### 4.3 — Extract each domain file

For each domain, extract the corresponding methods from the `offlineStorage` object into a standalone exported object with the same method signatures:

| Domain | Source methods | Target file |
|--------|---------------|-------------|
| Archive | `getNextSceneNumber`, `append`, `getIndex`, `getScenes`, `deleteFrom`, `clear` | `archiveStorage.ts` |
| Chapters | `list`, `create`, `update`, `seal`, `merge`, `split` | `chapterStorage.ts` |
| Facts | `get`, `save` | `factStorage.ts` |
| Timeline | `get`, `add`, `remove` | `timelineStorage.ts` |
| Entities | `get`, `merge` | `entityStorage.ts` |
| Backup | `create`, `list`, `read`, `restore`, `delete` | `backupStorage.ts` |
| Embeddings | `store`, `get`, `getAll`, `delete`, `deleteAll` | `embeddingStorage.ts` |

Each file imports helpers from `./_helpers` and types from `../../types` (or uses relative paths as appropriate).

### 4.4 — Create `index.ts` facade

```ts
import { archiveStorage } from './archiveStorage';
import { chapterStorage } from './chapterStorage';
import { factStorage } from './factStorage';
import { timelineStorage } from './timelineStorage';
import { entityStorage } from './entityStorage';
import { backupStorage } from './backupStorage';
import { embeddingStorage } from './embeddingStorage';

export const offlineStorage = {
    archive: archiveStorage,
    chapters: chapterStorage,
    facts: factStorage,
    timeline: timelineStorage,
    entities: entityStorage,
    backup: backupStorage,
    embeddings: embeddingStorage,
};
```

### 4.5 — Delete old `offlineStorage.ts`

Remove `src/services/offlineStorage.ts`.

### 4.6 — Fix import paths

All consumers currently do:
```ts
import { offlineStorage } from './offlineStorage';
```

This needs to become:
```ts
import { offlineStorage } from './storage';
```

Files to update (grep for `from './offlineStorage'` or `from '../services/offlineStorage'`):
- `src/services/apiClient.ts`
- `src/services/archiveMemory.ts`
- `src/services/archiveChapterEngine.ts`
- `src/services/semanticMemory.ts`
- `src/services/vectorSearch.ts`
- `src/store/campaignStore.ts`
- `src/store/slices/campaignSlice.ts`
- Any other consumer found by grep

## Verification

```powershell
npx tsc -b && npx vite build
```

Then confirm:
- `src/services/storage/index.ts` exports `offlineStorage` with identical shape
- All consumers compile without errors
- No file in `src/services/storage/` exceeds 150 lines
- The old `offlineStorage.ts` is deleted
