# Merge Prompt — World Lore + Design Pillars

You are merging two existing documents into a single modernized world-lore file. This is a careful integration task, not a creative rewrite. Preserve every piece of existing lore content; impose new structure and fold in a new magic system.

## Files

**Read all three before writing anything:**

1. `D:\Games\AI DM Project\Fantasy\world_lore_rag_deterministic_full.md` — the source lore. Four-zone geopolitics, NPCs, settlements, economy, religion, F–S ranks. Currently RAG-chunked with escaped `\##` headers and compressed prose. All content here must survive the merge.

2. `D:\Games\AI DM Project\Fantasy\design_pillars_v2.md` — the source-of-truth for the magic/power system. Mana paradigms, peak matrix, Thunder framing, Argent tech floor, forbidden line. Fold this *into* the world lore so zones, factions, and NPCs carry the system's tags and implications.

3. `D:\Games\AI DM Project\Pure Magic\arkanus_world.md` — schema reference *only*. Match its field-style structure (`**Type:**`, `**Leader:**`, `**Population:**`, `**Surprise Types:**`, `**Encounter Types:**`, `**scan_depth:**`, etc.). Do NOT copy its content; its setting is a different world. It is the *format* template.

## Output

Single file: `D:\Games\AI DM Project\Fantasy\world_lore_v2.md`

Target length: 12,000–18,000 words. Comprehensive but not padded. Every line should carry information.

## Hard Constraints (do not violate)

1. **Placeholder names retained.** The old file uses AI-default names (Valdris, Argent Confederacy, Eastern Dominion, Border Marches, Valerian, Blackwood, Templar, Long, Murong, etc.). The pillars doc uses placeholders (`[HEARTLANDS]`, `[EAST]`, `[ARGENT]`, `[MARCHES]`, `[PERIPHERY-DWARVES]`, `[PERIPHERY-ELVES]`). **Replace the old AI-default zone names with the bracketed placeholders.** Do NOT invent new names. Keep faction/NPC/god names from the old file as-is (they will be renamed in a separate later pass). The user will do the naming pass separately.

2. **No birth-affinity for elements.** Anyone can train any element-school. Drop any inherited element framing if it appears.

3. **No electricity in Argent.** Argent is mechanical+magical steampunk. No batteries, no telegraph, no radio, no electric light, no motors. See `MAG-ARGENT-TECH-FLOOR` in the pillars doc.

4. **Peaks are rare.** Most A-rank NPCs are powerful generalists, not peak-walkers. Across the entire roster, **assign no more than 5–8 peak-path holders or aspirants.** Most existing NPCs in the old file are B-rank — leave them as elite specialists without peak claims.

5. **Cult cap rule applies.** Cults practicing off-zone elements top out at B-rank. The Umbral Mirror, Coinlit Covenant, etc. do not produce peak-walkers.

6. **Preserve every existing NPC, settlement, faction, and economy detail from the old file.** Do not delete content. Reformat and augment.

7. **Use real markdown headers** (`#`, `##`, `###`). The old file has escaped `\##` garbage from PDF conversion. Clean it up.

## Required Actions

### Per zone (each of: [HEARTLANDS], [EAST], [ARGENT], [MARCHES], [PERIPHERY-DWARVES], [PERIPHERY-ELVES])

Write an overview entry with these fields:
- `**Type:**` (e.g., "Feudal continental power", "Cultivation imperial magocracy")
- `**Paradigm:**` (cultivation / magic+faith / magitech / runecraft / collective resonance / anomaly zone)
- `**Peak Elements:**` (the 2–3 elements where this zone holds institutional peaks — pull from `MAG-PEAK-FILLED`)
- `**Capital:**` and `**Ruler:**` from old file
- `**Population:**` (estimate; the old file doesn't have these — invent reasonable numbers)
- `**Magic Level:**` (one sentence on how mana flows in this zone)
- `**Attitude Toward Magic:**` (one paragraph — the zone's cultural lens)
- `**Surprise Types:**` (5–10 ALL_CAPS labels — borrow Arkanus format: `SUCCESSION_CRISIS`, `PEAK_AWAKENING`, `CULT_INFILTRATION`, etc.)
- `**Encounter Types:**` (5–10 ALL_CAPS labels: `INQUISITION_AUDIT`, `BANDIT_AMBUSH`, `DUEL_CHALLENGE`, etc.)
- `**World Event Who/Where/Why/What:**` (Arkanus pattern — see arkanus_world.md examples)
- `**Current State:**` (one paragraph — what's tense right now)
- `**scan_depth:**` 4 or 5

### Per faction (Valdris court, Eastern clans, Argent council, Marches warlords, etc.)

- Keep all fields from old file (Structure, Great Houses/Clans, Logic, Attitude, etc.)
- Add: `**Paradigm:**`, `**Peak Affiliations:**`, `**Surprise Types:**`, `**Encounter Types:**`, `**Key Tensions:**`
- Add `scan_depth: 3` or 4

### Per NPC (preserve every one from old file)

Old format has Base/Axes/Hooks. Keep that. Augment with:
- `**Paradigm:**` (usually inherits from zone; foreign-trained NPCs carry their training paradigm — note exceptions)
- `**Element-school primary:**` and **secondary** if relevant
- `**Rank:**` (already there, preserve) — add `**Depth:**` (estimate; cultivators tend high, mages variable, magitech gear-dependent)
- `**Peak Path:**` — only for the 5–8 you select as peak-walkers or close aspirants. Examples:
  - Arch-Deacon Ser Odrik Templar → climbing Inquisitor-Saint (B→A via relics, already noted)
  - Lord Marshal Brannoc Blackwood → Wall-Lord aspirant who lacks patience and political support; will probably never reach it
  - Artificer Kairo "Prism" Vexel → climbing Plasma-Lance Master OR Crystal-Prismatic Engineer (pick one; the gear-dependent rank notation in old file fits this perfectly)
  - Lady Long Qianru → Tide-Ancestor or Mountain-Saint aspirant (pick one based on her vibe; she's icy/elegant — could go either way)
  - Pick 1–2 more from the existing roster
  - Leave the rest as elite generalists
- `**Forbidden Risk:**` for NPCs with shady hooks — note which forbidden-line transgressions they might be sliding toward
- `scan_depth: 2` or 3

### Per location/settlement

Keep all entries. Add minimal fields:
- `**Type:**` (city / town / fort-city / hamlet / landmark)
- `**Significance:**` (one line)
- `**Magic Note:**` if the location has paradigm-relevant features (Prismline density, mana-storm proximity, relic-presence)
- `scan_depth: 2` (most) or 3 (capitals and key sites)

### Sections to ADD (new content informed by the pillars doc)

After the existing zone/faction/NPC/settlement content, add these new sections at the end:

1. **POWER & MAGIC SYSTEM** — abbreviated 1500-word version of the pillars doc. The full pillars doc lives separately as the reference; this section is the in-lore summary. Cover: mana-as-substance, the three paradigms + 2 Periphery variants, F–S + Depth + breakthrough cost, elements-as-schools, peak rarity rule, cult cap rule, forbidden line + zone-specific enforcement.

2. **THUNDER & THE UN-THEORIZED** — 400-word section on Thunder as natural-force-no-theory, magnetism corollary, Marches stormbringers. Briefly note the isekai hook as a *latent world-feature* (one paragraph max — not a featured campaign premise, just a flagged possibility).

3. **CROSS-ZONE TENSIONS** — 500-word section on the structural conflicts the peak matrix creates:
   - Earth-on-Earth (Heartlands Wall-Lord vs Eastern Mountain-Saint vs Argent Crystal-Engineer vs Dwarven Stone-Witness)
   - Fire-on-Fire (Heartlands Forge-Saint relic-economy vs Argent Plasma-Lance secular industry; the Eternal Flame church frames Argent fire as heretical)
   - Heartlands Light monopoly + East having no Light peak path
   - Eastern Shadow Sovereign monopoly + Heartlands having no Dark peer
   - Elven Whisper-Council comm monopoly + Argent's inability to compete because no electricity
   - Use these as campaign-engine framing.

4. **RAG RETRIEVAL HINTS** — match the old file's WL-RAG-HINTS section style. Document the new anchor ID conventions for both the original lore (WL-) and the magic system (MAG-).

## Anchor IDs

- Preserve existing `WL-` anchors from old file where content is preserved.
- New magic-system content uses `MAG-` anchors (already defined in pillars doc).
- Add `WL-` anchors for new sections per old-file convention.
- Every `###` header should have an anchor ID either in the heading or immediately after.

## Verification Checklist (self-check before finishing)

- [ ] All zone names replaced with bracketed placeholders ([HEARTLANDS] etc.)
- [ ] No new fancy names invented for renamed-later entities (Valdris/Argent/Dominion/Valerian/Blackwood remain as-is for the user to rename later)
- [ ] Every old-file NPC appears in the new file (do not drop anyone)
- [ ] Every old-file settlement appears in the new file
- [ ] Every old-file faction appears in the new file
- [ ] Field schema matches Arkanus style (Type / Paradigm / Population / Surprise Types / Encounter Types / scan_depth)
- [ ] Peak paths assigned to 5–8 NPCs only (not more)
- [ ] No NPC born with their element; element-as-school enforced
- [ ] Argent tech inventory makes no reference to electricity/batteries/telegraph
- [ ] Thunder framed as un-theorized natural force, not bloodline-rare
- [ ] Cult cap rule documented in POWER & MAGIC section
- [ ] Cross-zone tensions section included
- [ ] Real markdown headers (no `\##` escapes)
- [ ] Word count between 12,000 and 18,000

## Tone & Style

- World-internal voice. Not "the game models X" but "X is true in this world."
- Tight prose. No padding. Every sentence carries fact, vibe, or hook.
- Tables for: peak matrix references, element reception, breakthrough costs, Argent tech-floor inventory.
- Field-style schema with bolded labels for everything else.
- Preserve the old file's lore-flavor (gritty, faction-political, miracle-ledger religion, contract-driven economy). Do not soften.

## Out of Scope (do NOT do)

- Do not rename Valdris, Argent, Dominion, Valerian, Blackwood, etc. The user is doing this in a separate pass with care toward avoiding LLM-default fantasy naming patterns.
- Do not invent new NPCs or settlements. Only what's in the old file plus the magic-system content from pillars.
- Do not write the full pillars doc content into the new file — that lives separately. The new file gets the *abbreviated* magic system section only.
- Do not add isekai as a featured campaign premise. It's a latent hook, one paragraph, easily ignored if the user doesn't want it.

When done, write the file to `D:\Games\AI DM Project\Fantasy\world_lore_v2.md` and report back with a one-paragraph summary of major changes and the verification checklist results.
