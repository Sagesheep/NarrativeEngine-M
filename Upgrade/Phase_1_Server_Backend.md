# Phase 1: Server Backend Upgrades

## Goal
Upgrade `server.js` to add 13 missing API endpoints, atomic file writes, chapter lifecycle, semantic facts, and backup system.

## Files to Modify
- `server.js` (MAJOR changes - add ~660 lines)

## Reference
Read `../mainApp/server.js` (1091 lines) for the canonical implementation.

---

## Step 1: Add `crypto` Import

At the top of `server.js`, add `crypto` to the Node.js imports:

```javascript
import crypto from 'crypto';
```

---

## Step 2: Add BACKUPS_DIR Constant

Find where `SETTINGS_FILE` is defined. Add after it:

```javascript
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
```

Find the `ensureDirs()` function. Add to its body:

```javascript
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
```

---

## Step 3: Upgrade `writeJson()` to Atomic Writes

Replace the existing `writeJson` function with:

```javascript
function writeJson(filePath, data) {
    try {
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, filePath);
    } catch (err) {
        console.error(`[writeJson] Failed to write ${filePath}:`, err);
        throw err;
    }
}
```

This prevents data corruption by writing to a temp file first, then atomically renaming.

---

## Step 4: Add Helper Functions

Add these functions after `stripApiKeys()`. Copy them exactly from `../mainApp/server.js`:

### 4a. `computeCampaignHash(id)`
Computes MD5 hash over all campaign files. Used for backup deduplication.
Read mainApp server.js and copy the implementation.

### 4b. `campaignFiles(id)`
Returns array of filenames that exist for a campaign (up to 8 files).
Read mainApp server.js and copy the implementation.

### 4c. `createBackup(id, opts)`
Full backup lifecycle: dedup check, file copy, metadata write, auto-pruning.
Read mainApp server.js and copy the implementation.

### 4d. `pruneAutoBackups(id, keep)`
Removes oldest auto-backups beyond threshold (default 10).
Read mainApp server.js and copy the implementation.

### 4e. `chaptersPath(id)`
Returns path to `{id}.archive.chapters.json`.

```javascript
function chaptersPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.chapters.json`);
}
```

### 4f. `factsPath(id)`
Returns path to `{id}.facts.json`.

```javascript
function factsPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.facts.json`);
}
```

### 4g. `estimateImportance(text)`
Heuristic 1-10 scoring based on death/combat/royalty/treasure/quest keywords.
Read mainApp server.js and copy the implementation.

### 4h. `extractKeywordStrengths(text, keywords)`
Grades keyword relevance 0-1 based on frequency, position, and memorable-tag proximity.
Read mainApp server.js and copy the implementation.

### 4i. `extractNPCStrengths(text, npcNames)`
Grades NPC relevance 0-1 based on death proximity, dialogue, and mention frequency.
Read mainApp server.js and copy the implementation.

### 4j. `extractNPCFacts(npcNames, text)`
Extracts semantic triples (subject-predicate-object). Returns array of objects.
Read mainApp server.js and copy the implementation.

---

## Step 5: Upgrade `POST /api/campaigns/:id/archive`

The existing archive append endpoint needs these additions:

1. Wrap the handler body in `try/catch` returning 500 on failure
2. Add `keywordStrengths` to the index entry by calling `extractKeywordStrengths()`
3. Add `npcStrengths` to the index entry by calling `extractNPCStrengths()`
4. Add `importance` to the index entry by calling `estimateImportance()`
5. After saving the archive/index, call `extractNPCFacts()` and append results to `.facts.json`
6. After saving, handle chapter auto-lifecycle:
   - Load `.archive.chapters.json` (or initialize empty array)
   - Find the last chapter where `sealedAt` is undefined (the "open" chapter)
   - If no open chapter exists, create one
   - Update the open chapter's scene range, increment sceneCount, merge keywords/npcs
   - Save the chapters file

Read `../mainApp/server.js` lines ~370-470 for the complete implementation.

---

## Step 6: Upgrade `DELETE /api/campaigns/:id`

Add deletion of `.facts.json` file alongside the other files:

```javascript
const fp = factsPath(id);
if (fs.existsSync(fp)) fs.unlinkSync(fp);
```

Also add `chaptersPath` deletion:
```javascript
const cp = chaptersPath(id);
if (fs.existsSync(cp)) fs.unlinkSync(cp);
```

---

## Step 7: Upgrade `DELETE /api/campaigns/:id/archive`

Add chapters file cleanup:
```javascript
const cp = chaptersPath(req.params.id);
if (fs.existsSync(cp)) fs.unlinkSync(cp);
```

Update response to include `{ ok: true, chaptersCleared: true }`.

---

## Step 8: Upgrade `DELETE /api/campaigns/:id/archive/scenes-from/:sceneId`

Add three missing features:

1. **Facts pruning**: Load `.facts.json`, filter out facts with `sceneId >= rollbackSceneId`, save
2. **Chapter rollback cascade**: Load chapters, remove chapters fully ahead of rollback, repair spanning chapters, ensure an open chapter exists, set `invalidated: true` on repaired chapters
3. **Response**: Include `{ ok, removedFrom, chaptersRepaired, condenserResetRecommended: true }`

Read `../mainApp/server.js` for the complete scene rollback implementation.

---

## Step 9: Add Semantic Facts Endpoints (2 endpoints)

```javascript
// GET /api/campaigns/:id/facts
app.get('/api/campaigns/:id/facts', (req, res) => {
    const fp = factsPath(req.params.id);
    if (!fs.existsSync(fp)) return res.json([]);
    res.json(readJson(fp));
});

// PUT /api/campaigns/:id/facts
app.put('/api/campaigns/:id/facts', (req, res) => {
    writeJson(factsPath(req.params.id), req.body);
    res.json({ ok: true });
});
```

---

## Step 10: Add Chapter Management Endpoints (6 endpoints)

Copy all 6 chapter endpoints from `../mainApp/server.js`:

1. `GET /api/campaigns/:id/archive/chapters` - List chapters
2. `POST /api/campaigns/:id/archive/chapters` - Create chapter
3. `PATCH /api/campaigns/:id/archive/chapters/:chapterId` - Update chapter title
4. `POST /api/campaigns/:id/archive/chapters/seal` - Seal current chapter
5. `POST /api/campaigns/:id/archive/chapters/merge` - Merge two adjacent chapters
6. `POST /api/campaigns/:id/archive/chapters/:chapterId/split` - Split chapter at scene

Read mainApp server.js and copy each endpoint verbatim. They use `chaptersPath()` and `writeJson()`.

---

## Step 11: Add Campaign Backup Endpoints (5 endpoints)

Copy all 5 backup endpoints from `../mainApp/server.js`:

1. `POST /api/campaigns/:id/backup` - Create backup
2. `GET /api/campaigns/:id/backups` - List backups
3. `GET /api/campaigns/:id/backups/:ts` - Read backup metadata
4. `POST /api/campaigns/:id/backups/:ts/restore` - Restore backup
5. `DELETE /api/campaigns/:id/backups/:ts` - Delete backup

Read mainApp server.js and copy each endpoint. They use `BACKUPS_DIR`, `computeCampaignHash()`, `createBackup()`, `pruneAutoBackups()`.

---

## Verification
After completing this phase:
1. Start the server: `node server.js`
2. Verify it starts on port 3001
3. Test a new endpoint: `curl http://localhost:3001/api/campaigns/test-id/facts` should return `[]`
4. Run `npm run build` to ensure no errors
