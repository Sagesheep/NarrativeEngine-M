# 05a — Name Bank + Blocklist Generation (executor: FLASH / any cheap model)

> Phase 1 of 3 for Plan 05 (see `05_npc_name_uniqueness__DESIGN.md`).
> Output of this phase: raw text files. They are NOT used by the engine yet —
> they go through GLM review (05b) and a final human/strong-model skim before
> Opus wires them in (the implementation phase).

## How to run

1. Open a chat with the cheap model (Gemini Flash or similar).
2. **Name bank**: run PROMPT A once per row of the taxonomy table below,
   replacing `{SUBHEADER}`, `{CULTURE_DESCRIPTION}`, and `{COUNT}`.
   Ask for at most **250 names per reply** — if `{COUNT}` is larger, say
   "continue" until the count is reached. Quality drops when a single reply
   gets too long.
3. Save each subheader's output as `Upgrade/FablePlans/assets/raw/names_{subheader}.txt`.
4. **Blocklist**: run PROMPT B once per category listed under it.
   Save as `Upgrade/FablePlans/assets/raw/blocklist_{category}.txt`.
5. Hand the `raw/` folder to phase 05b.

## Taxonomy (target ~7,800 names total)

| Header | Subheader | Count | Culture description to paste |
|---|---|---|---|
| #western | ##english | 500 | English/British given names, medieval through modern |
| #western | ##wild-west | 300 | American frontier / Old West era given names and nicknames |
| #western | ##french | 300 | French given names |
| #western | ##german | 300 | German given names |
| #western | ##italian | 300 | Italian given names |
| #western | ##spanish | 300 | Spanish/Hispanic given names |
| #oriental | ##japan | 500 | Japanese given names, romanized (Hepburn) |
| #oriental | ##chinese | 500 | Chinese given names, pinyin romanization without tone marks |
| #oriental | ##korean | 300 | Korean given names, romanized |
| #slavic | ##russian | 400 | Russian given names |
| #slavic | ##ukrainian | 300 | Ukrainian given names |
| #slavic | ##polish | 300 | Polish given names |
| #norse | ##norse | 400 | Old Norse / Scandinavian given names |
| #arabic | ##arabic | 400 | Arabic given names, romanized |
| #indian | ##indian | 400 | Indian subcontinent given names |
| #african | ##african | 400 | Sub-Saharan African given names from major language groups |
| #greek | ##greek | 300 | Greek given names, ancient and modern |
| #fantasy | ##fantasy-neutral | 1200 | Invented fantasy names with no real-world cultural anchor; pronounceable, genre-typical for fantasy fiction. This is the engine's fallback pool — variety matters most here |

---

## PROMPT A — name bank batch (paste-ready)

```
You are generating a name asset file for a text game engine. Output data only —
no commentary, no numbering, no markdown formatting other than specified.

TASK: Generate {COUNT} distinct GIVEN NAMES (first names) for this culture group:
{CULTURE_DESCRIPTION}

OUTPUT FORMAT — exactly one name per line:
Name | g

where g is one of: m (typically masculine), f (typically feminine), u (unisex/unclear).
First line of your output must be the header line: ##{SUBHEADER}

RULES:
1. Real, plausible given names for the culture (for fantasy-neutral: invented but
   pronounceable). ASCII letters only — romanize, strip diacritics (José -> Jose).
2. NO famous real people (no Hitler, Napoleon, Beyonce-as-name).
3. NO famous fictional characters (no Frodo, Naruto, Aragorn, Daenerys, Pikachu).
4. NO surnames, no titles, no honorifics, no "the X" epithets.
5. One word per name, 2-12 characters, capitalized first letter only.
6. No duplicates within your output.
7. Aim for a rough gender balance (~40% m, ~40% f, ~20% u where the culture has
   unisex names; otherwise 50/50).
8. Spread across common AND less-common names — a game needs variety, not a
   top-100 baby-name list.

Output at most 250 names per reply. If {COUNT} is higher, stop at 250 and wait
for "continue".
```

---

## PROMPT B — detector blocklist (paste-ready)

Run once per category: `titles-ranks`, `kinship-address`, `places-geography`,
`organizations`, `abstract-fantasy-nouns`, `time-calendar`, `common-capitalized`.

```
You are generating a BLOCKLIST for a text game engine. The engine scans story
prose for capitalized words that might be character names. Your job: list
capitalized words that are NOT personal names so the engine can ignore them.

CATEGORY for this run: {CATEGORY}

Category guide:
- titles-ranks: Sergeant, Captain, Lord, Lady, Elder, Master, Doctor, Sensei...
- kinship-address: Mother, Father, Auntie, Brother, Granny, Miss, Sir...
- places-geography: North, Harbor, Vale, Ridge, Crossroads, Downtown...
- organizations: Guild, Order, Legion, Council, Syndicate, Church...
- abstract-fantasy-nouns: Shadow, Oath, Doom, Fate, Void, Prophecy, Bloodline...
- time-calendar: Winter, Tuesday, Dawn, Solstice, Harvest...
- common-capitalized: sentence-start words and proper-noun-ish common words that
  prose capitalizes: God, Hell, Heaven, King (as title), Empire...

OUTPUT FORMAT — one word per line, capitalized, no commentary. First line:
#blocklist-{CATEGORY}

RULES:
1. 150-300 entries for the category.
2. Single words only (the engine matches tokens).
3. CRITICAL: if a word is ALSO a plausible given name in any culture
   (Hope, Grace, Faith, Hunter, Mercy, Winter-as-name, Dawn-as-name), do NOT
   put it in the main list. Put it at the end under a separate line that says:
   #ambiguous
   followed by those words. A human will decide on these.
4. English only for now.
5. No duplicates.
```

---

## Done criteria for this phase

- One `names_*.txt` per taxonomy row, header line intact, `Name | g` format.
- Seven `blocklist_*.txt` files, each with its `#blocklist-*` header and an
  `#ambiguous` section (possibly empty).
- Don't worry about cross-file duplicates or quality stragglers — that is
  exactly what phase 05b (GLM review) is for.
