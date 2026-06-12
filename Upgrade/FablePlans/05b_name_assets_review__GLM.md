# 05b — Name Bank + Blocklist Review "Wringer" (executor: GLM / mid model)

> Phase 2 of 3 for Plan 05 (see `05_npc_name_uniqueness__DESIGN.md`).
> Input: the `Upgrade/FablePlans/assets/raw/` files from phase 05a.
> Output: cleaned files in `Upgrade/FablePlans/assets/clean/` + a findings
> summary. After this, one final human/strong-model skim of the REMOVED and
> AMBIGUOUS sections, then the assets are frozen for the Opus implementation
> phase.

## How to run

1. Open a chat with the mid model (GLM or similar).
2. **Names**: run PROMPT C once per `names_*.txt` file — paste the whole file
   into the prompt. Save the CLEANED block as `clean/names_{subheader}.txt`;
   collect every REMOVED section into one `clean/names_REMOVED_log.txt`.
3. **Cross-file dedupe**: after all name files are cleaned, run PROMPT D once,
   pasting ALL cleaned name files together (names only — it's small enough).
4. **Blocklist**: run PROMPT E once per `blocklist_*.txt` file.
5. Final human skim: read `names_REMOVED_log.txt` (rescue anything wrongly cut)
   and every `#ambiguous` section (decide block vs allow). Then mark the assets
   FROZEN at the top of each clean file.

---

## PROMPT C — per-file name review (paste-ready)

```
You are reviewing a generated name list for a game engine. Be strict — a bad
entry that ships is expensive, a wrongly removed one costs nothing (we log it).

THE LIST (culture: {SUBHEADER}):
<paste the raw names_*.txt file here>

CHECK EVERY LINE against these rules and remove violations:
1. Format: exactly "Name | g" with g in {m,f,u}. Fix trivially broken lines
   (spacing, casing) instead of removing; remove unfixable ones.
2. Not a real famous person or well-known fictional character.
3. Actually plausible as a given name for the stated culture. Remove vocabulary
   words, surnames, place names, and names that belong to a clearly different
   culture (e.g. "Hanabi" in a #western file).
4. ASCII only, one word, 2-12 chars. Romanize/strip diacritics, don't remove.
5. No duplicates within the file (case-insensitive).
6. Gender tag sanity: fix obviously wrong tags (e.g. "Hanako | m" -> f).
   If genuinely unisex or unknown, use u.
7. Remove anything offensive, scatological, or that reads as a slur in major
   languages.

OUTPUT exactly this structure:
##{SUBHEADER}
<cleaned list, one "Name | g" per line>

#REMOVED
<one per line: "Name -- short reason">

#STATS
kept=<n> removed=<n> fixed=<n>
```

---

## PROMPT D — cross-file duplicate pass (run once, after all PROMPT C runs)

```
Below are cleaned name lists for multiple culture groups, each under a ##header.
Names may legitimately appear in MORE THAN ONE culture (e.g. "Anna" in both
##english and ##russian) — that is ALLOWED and must be kept; the engine handles
multi-culture membership.

Your job is only to find and fix these two problems:

1. EXACT duplicates within the same ##header section (remove the extra).
2. Near-collisions across cultures that are actually the SAME name with
   inconsistent spelling (e.g. "Yuri" / "Yurii" / "Yuriy" all present) — keep
   each culture's most standard romanization, list the variants you dropped.

<paste ALL cleaned name files here>

OUTPUT:
#WITHIN_HEADER_DUPES
<header: name — one per line, these were removed>

#SPELLING_MERGES
<one per line: "kept Yurii (##ukrainian), dropped Yuriy (##ukrainian)">

#CROSS_CULTURE_SHARED (informational only, nothing removed)
<one per line: "Anna: ##english, ##russian">
```

Apply its removals to the clean files by hand (or have it re-emit the corrected
sections if the list is long).

---

## PROMPT E — per-file blocklist review (paste-ready)

```
You are reviewing a detector blocklist for a game engine. The engine uses this
list to decide "this capitalized word in story prose is NOT a character name".

A WRONG ENTRY HERE IS DANGEROUS: if a real given name lands on the blocklist,
the engine will permanently ignore a legitimate character. Bias accordingly:
when in doubt, move the word to #ambiguous rather than keeping it blocked.

THE LIST (category: {CATEGORY}):
<paste the raw blocklist_*.txt file here>

CHECK EVERY LINE:
1. Is this word a plausible given name in ANY major culture or in fantasy
   fiction naming conventions (Hope, Grace, Hunter, Mercy, Dawn, Winter,
   Sage, Rose, Ash...)? -> move to #ambiguous.
2. Is it actually a word the detector could encounter capitalized mid-prose in
   the stated category? Remove entries that are obscure or implausible.
3. Single word, no duplicates, capitalized.
4. Does it fit the stated category? Misfiled but valid -> keep and note it.

OUTPUT exactly this structure:
#blocklist-{CATEGORY}
<cleaned list, one word per line>

#ambiguous
<words moved here or already here — one per line, with a 3-5 word reason>

#REMOVED
<one per line: "Word -- short reason">

#STATS
kept=<n> moved_to_ambiguous=<n> removed=<n>
```

---

## Done criteria for this phase

- `clean/` mirrors `raw/`, all files pass their own format header.
- Cross-file pass (PROMPT D) applied.
- `names_REMOVED_log.txt` exists for the human skim.
- Every blocklist file has its `#ambiguous` section populated and awaiting a
  human verdict — **nothing from #ambiguous ships in the blocklist by default**.
- After the human skim: add `<!-- FROZEN 2026-MM-DD -->` to the top of each
  clean file. The Opus implementation phase consumes only FROZEN files.
