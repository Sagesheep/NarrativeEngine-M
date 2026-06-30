# World Lore Prompt Template

Copy and paste the text below and provide it to an AI (like ChatGPT, Claude, DeepSeek) to generate a structured world lore file formatted perfectly for our engine.

---

**PROMPT TO COPY AND SEND TO AI:**

You are an expert worldbuilder for a tabletop RPG engine. I need you to generate a comprehensive world lore document for my new campaign. 

**[INSERT YOUR CAMPAIGN IDEA HERE — e.g. "A cyberpunk city built on the ruins of a magical floating island"]**

You **MUST** format the output exactly according to the structured template below.
Do not deviate from the `### Category — Title` header structure, as it is parsed programmatically by the engine's RegEx.
For characters, you MUST include the expected bolded fields (Aliases, Appearance, Disposition, Goals, Faction, Status, Axes).

Here is the exact structure you must use:

```markdown
# [World Name]

## 1. WORLD OVERVIEW
### OVERVIEW — [Core Premise or Intro]
[Describe the fundamental premise, era, and core conflict of the world. State the genre and tone clearly.]
**Tone:** [e.g. GRIM, NOIR, COMEDIC, EPIC]

## 2. FACTIONS
### FACTION — [Faction Name]
**Type:** [Military Order / Megacorp / Guild / Cult]
**Key Members:** [Leader Name, Notable Member]
**Stance:** [Pro-establishment, Hostile, Neutral]
[Describe the faction's goals, methods, and relationship to the world.]

## 3. LOCATIONS
### LOCATION — [Location Name]
**Type:** [City / Region / Landmark]
**Status:** [Flourishing / Ruined / Contested]
[Describe the key features, atmosphere, and importance of this location.]

## 4. CHARACTERS
### CHARACTER — [Character Name]
**Aliases:** [aka..., The Title]
**Appearance:** [Describe visual features — used by AI for image/description generation.]
**Disposition:** [Stoic, Protective, Ambitious]
**Personality:** [Elaborate on personality traits beyond disposition.]
**Voice:** [How they speak — cadence, vocabulary, verbal tics, speech pattern.]
**Status:** [Alive / Deceased / Missing]
**Faction:** [Faction Name or None]
**Goals:** [Describe what they want to achieve.]
**StoryRelevance:** [Why this character matters to the plot or world.]
**Example Output:** [One line of dialogue that perfectly captures their voice.]
**Affinity:** [0–100] (0 = hostile, 50 = neutral, 100 = devoted)
[Describe their background and relevance to the story.]

### CHARACTER INTRO FLAGS (optional — controls when/where this character appears in play)
**Wandering: true**         ← include this line if the character can appear ANYWHERE in the world
**Location: [Place Name]**  ← include this line if the character is tied to a specific location
**Intro Boost: [keyword1, keyword2]**  ← include this to make the character 3× more likely to appear when these words appear in recent GM narration

> Notes on intro flags:
> - Omit all three lines if the character should only appear when the GM explicitly introduces them.
> - Use Wandering for roaming characters (merchants, wandering knights, etc.).
> - Use Location for place-bound NPCs (innkeepers, guards, local bosses).
> - Use Intro Boost to tie a character to plot themes (e.g. "Intro Boost: poison, assassination" for a spy).
> - Location + Intro Boost = character appears when party is at that place AND the boost keyword is relevant.

## 5. POWER SYSTEM & RULES
### POWER_SYSTEM — [Name of Magic/Tech]
[Explain how magic, technology, or special abilities work. What are the limitations?]

## 6. ECONOMY
### ECONOMY — [Currency / Trade]
[Detail the monetary system, rare resources, and general cost of living.]

## 7. EVENTS
### EVENT — [Significant Event]
[Summarize a major historical or plot event that shapes the current state.]

## ENGINE SEED TAGS (IMPORTANT)
### SYSTEM — Engine Seeds

> The engine has 3 tiers. Read the guidance for each carefully — the tag format matters.

**── TIER 1: SURPRISE ENGINE (mundane world flavor) ──**
> Everyday ambient moments that make the world feel alive. NOT combat, NOT major events.
> Use genre-appropriate mundane situations. The GM AI resolves the specific detail from context.
> Examples: a street argument, someone drops their coin purse, lovers fighting in public, a dog chasing a cart.
**Surprise Types:** [List 5-10 mundane situation archetypes e.g. STREET_DRAMA, FOUND_OBJECT, OVERHEARD_GOSSIP, VENDOR_DISPUTE, ANIMAL_INCIDENT]
**Surprise Tones:** [List 5-10 emotional flavors e.g. AMUSING, AWKWARD, MUNDANE, CURIOUS, HEARTWARMING, TENSE]

**── TIER 2: ENCOUNTER ENGINE (location-agnostic threat situations) ──**
> Threat SITUATIONS, NOT specific enemies. The GM AI determines what the threat actually is
> based on the current in-game location. "TERRITORIAL_THREAT" in a sewer = rats; in a palace = guards.
> DO NOT write enemy names — write the type of danger scenario instead.
**Encounter Types:** [List 5-10 threat situation archetypes e.g. HOSTILE_PRESENCE, TERRITORIAL_THREAT, PATROL_CONFRONTATION, AMBUSH_LAID, SCAVENGING_PREDATOR]
**Encounter Tones:** [List 5-10 tones e.g. TENSE, DESPERATE, SUDDEN, PREDATORY, GRIM]

**── TIER 3: QUEST HOOK ENGINE (world rumours & local hooks) ──**
> Generates a rumour or hook that players hear — NOT a canon world-state change.
> Purpose: create quests and dynamic local news. Bandits spotted, treasure rumoured, person missing.
> Keep scope LOCAL and UNCERTAIN (it's a rumour — may not even be true).
**Quest Hook Who:** [List 5-10 rumour sources e.g. a frightened merchant, a local guard, a travelling hermit]
**Quest Hook What:** [List 5-10 inciting events e.g. spotted raiders near, claims something was found at, says a person went missing from]
**Quest Hook Where:** [List 5-10 local areas e.g. on the northern road, near the old ruins, at the river crossing]
**Quest Hook Why:** [List 5-10 stakes/hooks e.g. and a reward is offered, and locals are too frightened to investigate, hinting at treasure involved]

```

---

## Example of a Completed Generation (Cyber-Noir Setting)
*(You can use this as reference or upload this directly just to test it out!)*

```markdown
# Neo-Veridya

## 1. WORLD OVERVIEW
### OVERVIEW — Core Premise
Neo-Veridya is a sprawling, rain-slicked metropolis where advanced cybernetics collide with highly illegal blood-magic. The city is controlled by three massive corporatocracies, while the lower levels drown in neon and organized crime. 
**Tone:** GRIM, NOIR, CYBERPUNK.

## 2. FACTIONS
### FACTION — The Crimson Syndicate
**Type:** Organized Crime / Magic Cartel
**Key Members:** Jax "The Bleeder" Vance
**Stance:** Hostile to Corpos, allied with the lower wards.
The syndicate controls the flow of "Sanguine," a magical narcotic that enhances reflexes but slowly crystallizes the user's blood. They operate out of the sunken districts.

## 3. LOCATIONS
### LOCATION — Layer Zero
**Type:** Slums / Black Market
**Status:** Lawless
The lowest level of Neo-Veridya. Constant acid rain and blocked out sun. It is a labyrinth of junk-tech stalls, illegal cyber-docs, and sanctuary for those fleeing the CorpEnforcers.

## 4. CHARACTERS
### CHARACTER — Jax Vance
**Aliases:** The Bleeder, Mr. Vance
**Appearance:** Tall, gaunt. One glowing red biosynthetic eye, pale skin, sharply dressed in a maroon trenchcoat.
**Disposition:** Ruthless, calculating, falsely polite.
**Personality:** Jax is charming in a cold, transactional way. He treats every interaction as a negotiation and every person as a resource. Rarely raises his voice.
**Voice:** Soft, deliberate, never rushed. Uses formal language even with street thugs. Often ends sentences with a quiet question that isn't really a question.
**Status:** Alive
**Faction:** The Crimson Syndicate
**Goals:** To monopolize the Sanguine trade and buy his way into the upper echelons.
**StoryRelevance:** Central antagonist and potential uneasy ally. Controls most of the underworld's information flow.
**Example Output:** "I don't deal in threats, friend. I deal in arrangements. Now — shall we be reasonable?"
**Affinity:** 20
Jax is the undisputed king of Layer Zero. He rarely gets his own hands dirty, preferring to manipulate others through debt and addiction.
**Location: Layer Zero**
**Intro Boost: sanguine, syndicate, drug, debt, underworld**

### CHARACTER — Mira Solenne
**Aliases:** The Ghost, Mira
**Appearance:** Slight build, close-cropped silver hair, a faded CorpSec tattoo on her left wrist she tries to hide. Always wears grey.
**Disposition:** Guarded, perceptive, quietly haunted.
**Personality:** Mira trusts nobody by default but warms slowly. She has a dry sense of humour she rarely lets out. Hates waste — of people, of resources, of potential.
**Voice:** Clipped and efficient. Rarely uses contractions when stressed. Long silences between sentences.
**Status:** Alive
**Faction:** None (ex-CorpSec)
**Goals:** To find evidence that CorpSec knowingly covered up the Layer Zero massacre.
**StoryRelevance:** Key contact for investigation arcs. Knows CorpSec protocols and can get the party into restricted areas.
**Example Output:** "I've seen what they do to loose ends. Don't ask me to trust you. Ask me to work with you. That I can do."
**Affinity:** 50
Former CorpSec investigator who went dark after a case led somewhere she wasn't supposed to look.
**Wandering: true**
**Intro Boost: corpse, massacre, evidence, investigation, CorpSec**

## 5. POWER SYSTEM & RULES
### POWER_SYSTEM — Haemomancy & Chrome
Magic in Neo-Veridya requires blood—either drawn from the caster or a victim. Tech enhancements (Chrome) suppress magical ability. The more machine you become, the less magic you can wield.

## 6. ENGINE SEED TAGS
### SYSTEM — Engine Seeds

**── TIER 1: SURPRISE ENGINE ──**
**Surprise Types:** STREET_BRAWL, FOUND_CREDCHIP, OVERHEARD_DEAL, DRONE_MALFUNCTION, VENDOR_DISPUTE, ADDICT_SCENE, CORP_PROPAGANDA_BROADCAST, RAIN_SURGE, STRANGER_COLLAPSES, URCHIN_PICKPOCKET
**Surprise Tones:** MUNDANE, GRIM, AMUSING, TENSE, NEON_DRENCHED, CHAOTIC, BITTERSWEET, AWKWARD

**── TIER 2: ENCOUNTER ENGINE ──**
**Encounter Types:** HOSTILE_PRESENCE, PATROL_CONFRONTATION, TERRITORIAL_THREAT, AMBUSH_LAID, DESPERATE_ATTACKER, CORNERED_ENTITY, RIVAL_CLAIM, SCAVENGING_PREDATOR, TRAP_TRIGGERED, ENVIRONMENTAL_THREAT
**Encounter Tones:** TENSE, DESPERATE, SUDDEN, GRIM, CALCULATED, PREDATORY, CHAOTIC, CLINICAL

**── TIER 3: QUEST HOOK ENGINE ──**
**Quest Hook Who:** a bruised dockworker, a nervous street medic, a Syndicate runner gone quiet, a CorpSec deserter, a Sanguine addict with a clear head, an old archivist
**Quest Hook What:** spotted armed strangers near, claims something was buried at, says someone they know vanished from, found a partial data-shard pointing to, overheard a deal involving, is offering a bounty for information about
**Quest Hook Where:** the lower processing vaults, a flooded sub-district, the old transit hub, a decommissioned med-facility, a rooftop black market, the Syndicate's neutral ground
**Quest Hook Why:** and nobody official will touch it, suggesting a payout for the right people, and the trail goes cold at CorpSec's door, hinting the target is still alive somewhere, and someone powerful wants it buried
```
