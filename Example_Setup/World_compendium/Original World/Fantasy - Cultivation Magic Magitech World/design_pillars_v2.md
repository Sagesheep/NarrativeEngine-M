# Design Pillars — Magic, Power, and Paradigms

**File purpose:** Source-of-truth for the world's magic system. Anchors the modernization of `world_lore_rag_deterministic_full.md`. RAG-chunkable; anchor IDs in brackets are stable retrieval keys.

**Naming convention:** Zone names are final (Round 1 locked). NPC and faction names updated in Round 2. God names, cult names, and sub-location names pending later rounds.

---

## 1. MANA — THE UNIVERSAL SUBSTANCE

### MAG-MANA-CORE

**Type:** Universal magical substance
**Source:** Ambient in the world at varying densities. Bodies generate a small internal supply naturally; the rest is drawn from the environment.
**Density:** Varies wildly by region. Deep forests of Aelynost are mana-saturated and creatures grow large. The badlands of Spurlands host mana-storms and atmospheric anomalies. Civilized cities are mana-thin, drained by centuries of casting and inscription work. The Korval [Prismline] is the densest non-wild concentration on the continent.
**Flavor:** Mana itself is neutral. It takes on flavor — what people call *element* — through technique. The same mana becomes Fire when shaped by a Fire-school caster, Water when shaped by a Water-school caster. Element is a *grammar*, not an *essence*.
**Affinity:** No one is born with an element. Anyone can train any school. Some people have natural inclinations — they learn one school faster, deepen mana more easily in its flavor — but nothing is locked. The Solthean-style "born under Light" doctrine is religious metaphor, not metaphysical fact. (Some sects believe it literally. They are wrong, but politically influential.)

### MAG-MANA-AXES

Mana use is measured on two trainable axes:

- **Rank (Tier, F–S):** Output ceiling. How much mana a practitioner can move in a single act, and how complex a pattern they can hold.
- **Depth:** Endurance. How long a practitioner can sustain casting before exhaustion. Trained through consistent practice, like muscle.

The two axes train independently. A B-rank with E-rank Depth burns out in three exchanges and is dangerous only in opening salvos. A D-rank with A-rank Depth outlasts armies and wins through attrition.

---

## 2. THE THREE PARADIGMS

### MAG-PARADIGM-CORE

One substance, three interfaces. Each paradigm relates to mana differently — and the relationship determines what the practitioner can do, what they look like in combat, and what kills them on the climb.

### MAG-PARADIGM-CULTIVATION

**Zone:** Daqian
**Core principle:** Pull ambient mana inward. The body becomes the vessel. Internal mana is *refined* through breakthroughs until the body itself can hold reservoirs that should not fit inside flesh.
**Practitioner profile:** Tanky. Slow to deplete. Manifests physical transformations at high tier — skin like stone, breath like fog, presence that distorts air.
**Casting medium:** The body is the circle. No external traces, no inscribed gear. Forms are *internal* — qi-channels mapped onto anatomy, breath-patterns, ancestor-resonance.
**Cultural aesthetic:** Meditation halls, mountain hermitages, lineage academies, ancestor shrines. Cultivation rank is social rank — outer disciple, inner disciple, elder, ancestor. The clans treat cultivation as an inherited duty more than a vocation.
**Breakthrough cost:** Death. The body must survive higher mana throughput at each rank-up. Catalysts, preparation, and master-supervision improve odds but never eliminate them. Most cultivators plateau between D and C. The high ranks are rare not because of talent gates but because most aspirants die climbing.

### MAG-PARADIGM-MAGIC

**Zone:** Mercia primarily; practiced in lesser forms everywhere except Daqian
**Core principle:** Internal mana is the *command signal*. External ambient mana does the work. The mage is a conductor, not a battery — they orchestrate flow, they do not contain it.
**Practitioner profile:** Glass cannon relative to cultivators of equal rank. High output, fast depletion. Strong in opening exchanges, weak in attrition. Compensates through preparation, layered defenses, and ritual.
**Casting medium:** Circles. Geometry inscribed in three speed-tiers:
- **Drawn** — chalk, ink, or scratched into a surface. Slow but precise. Used for rituals, enchantments, siege magic. Preserved and reusable.
- **Air-traced** — drawn with finger or staff. Medium speed. Standard combat casting. The circle glows briefly, then dissipates.
- **Visualized** — projected entirely within the mind. Instantaneous. Master-level only. Thousands of repetitions required. No visible circle — the spell simply manifests.
**Faith-magic subtype:** Relics are pre-inscribed external reservoirs. A saint is a practitioner whose internal signal resonates with a god's mana-signature, allowing them to draw on that god's pool. Faith-magic is magic-paradigm with a borrowed reservoir. The catch: the borrower does not own what they spend. Every major miracle is a debt on the faith's ledger, paid later in tithes, inquisitions, territory, or metaphysical backlash. (See `MAG-LEDGER`.)
**Breakthrough cost:** Madness. The mind must hold more complex patterns at each rank-up. Failed breakthroughs survive but lose something — clarity, identity, the ability to cast cleanly. "Circle-shock" leaves the victim able to trace patterns they no longer understand. The asylums of Mercia hold more failed mages than failed soldiers.

### MAG-PARADIGM-MAGITECH

**Zone:** Korval
**Core principle:** Equipment is the conduit. Mana flows through *gear* and enhances the wielder. The artificer designed the device; the user merely powers it. The skill is in the inscription, not the casting.
**Practitioner profile:** Rank is gear-dependent. Strip the gear, drop the rank. A B-rank artificer in full kit is a B-rank threat. The same person disarmed and stripped is a C at best. This is structural, not stigma — magitech makes power *transferable* and *patentable*, which is why Korval society organizes around it.
**Casting medium:** Mana-crystal reservoirs, inscribed metalwork, clockwork mechanisms with rune-etched components, alchemical reagents. The crystal stores mana; the inscriptions shape its flow; the mechanism delivers the effect.
**Cultural aesthetic:** Workshops, patent courts, industrial espionage, apprentice-master legal contracts that read like indenture. Gear is wealth. Wealth is rank.
**Breakthrough cost:** Economic. Climbing requires upgraded gear — better crystals, finer inscriptions, rarer reagents. The climb destroys you through debt, patent theft, or the espionage that finds you at the wrong moment. Many Korval artificers die in alleys, not battlefields, killed for the prototype in their pocket.

### MAG-PARADIGM-RUNECRAFT

**Zone:** Eikinholt
**Core principle:** Slow-permanent variant of magitech. Inscription into stone and metal, built to last centuries. No wearer required — the rune is structural, embedded in walls, weapons, contracts, the bones of holds.
**Practitioner profile:** Individual dwarves are not exceptionally powerful. The *hold* is. A dwarven city is a layered runework spanning generations of inscription. Attacking it means attacking accumulated magical infrastructure, not a garrison.
**Casting medium:** Stone, basalt, iron, alloyed metals. Carved by hand over months or years. A master rune-smith inscribes perhaps three major works in a lifetime.
**Breakthrough cost:** Despair. Apprenticeship to journeyman to master is multi-decade. Ambition kills not the body but the will — most who set out to become rune-masters quit, drink themselves into early retirement, or become bitter teachers of those who will surpass them.

### MAG-PARADIGM-RESONANCE

**Zone:** Aelynost
**Core principle:** The collective is the practitioner. Elves are nodes in the forest's field — the grove itself is the cultivator, and elves are participants and conduits. Individual elven power is modest. The *grove's* power is geological.
**Practitioner profile:** A lone elf is roughly D-rank. The same elf rooted in their home forest fights as an A. Strip them from the grove and they decay quickly — exile-sickness within months.
**Casting medium:** Song, dance, communion-rituals. The forest "answers" through ambient mana shifts. No discrete spell-acts; the field changes around the elf and persists for as long as the song is sung.
**Breakthrough cost:** The grove must agree. Individual ascent is impossible. An elf who rises does so because the choir lifts them. An elf the choir rejects becomes an exile and dies.

### MAG-PARADIGM-COMPARISON

| Paradigm | Substrate | Profile | Breakthrough Cost | Climb Mortality |
|---|---|---|---|---|
| Cultivation | Body | Tanky, deep, slow-burst | Body fails throughput | Highest (death) |
| Magic | Circles | Burst, fragile, ritual-dependent | Mind fragments | High (madness > death) |
| Magitech | Gear | Gear-rank-tied, transferable | Economic ruin / theft | Indirect (assassination) |
| Runecraft | Stone | Structural, civilization-scale | Generational patience | Lowest (despair, not death) |
| Resonance | Collective field | Geographic, place-locked | Choir consensus | N/A (exile = death) |

---

## 3. RANK AND BREAKTHROUGH

### MAG-RANK-F-S

Rank is universal output. A B-rank cultivator, mage, and magitech artificer all move comparable volumes of mana. They differ in *shape*, not *volume*.

- **F (Novice):** Civilian-adjacent. Wins through numbers or surprise.
- **E (Trained):** Guards, militia, fresh academy graduates, basic adventurers.
- **D (Competent):** Professional fighters, veteran scouts, ranking apprentices.
- **C (Professional+):** Named specialists. Can handle multiple E/D opposition.
- **B (Elite):** Captain-tier. Elite agents. Monster hunters. The ceiling most career practitioners ever reach.
- **A (Superhuman):** Breaks human limits. Single-handed battlefield impact. Rare enough that each one is named regionally.
- **S (Legendary):** Region-shaping. Story-gated. Often peak-walkers (see `MAG-PEAK-MATRIX`).

### MAG-RANK-GAP-RULE

A two-tier gap dominates unless modified by ambush, terrain, numbers, preparation, or hard counters. A B beats a D every time in fair exchange. A B caught in an unfavorable element matchup or stripped of preparation loses to a D.

### MAG-RANK-DEPTH

Mana Depth is the second axis, trained independently. Notation: Rank/Depth (e.g., B/D = B-rank output, D-rank endurance — a glass cannon).

Cross-paradigm depth varies:
- Cultivators tend to develop deep depth as a byproduct of body-refinement. B/B is typical.
- Mages must train depth deliberately. B/D is common; lazy mages get B/E.
- Magitech depth is *gear depth*, not personal. The mana-crystal's reservoir is the depth stat. Strip the gear, depth drops to civilian.
- Rune-smiths don't fight; depth is irrelevant.
- Elven resonance depth scales with grove size and age.

### MAG-RANK-CONTRACTS

Contract tiers from the old economy layer remain valid:
- Tier 0: F–E
- Tier 1: D–C
- Tier 2: B–A
- Tier 3: A–S, region-shaping stakes

---

## 4. ELEMENTS AS SCHOOLS

### MAG-ELEMENTS-CORE

Eight elements: Fire, Water, Wind, Thunder, Earth, Light, Dark, Spirit. Each is a *school* — a trained discipline — not an inborn category. A "Fire mage" studied Fire-school. A "Water cultivator" cultivates along the Water-path. Switching schools is possible but rare; lifetime specialization is the norm because mana-depth in one flavor doesn't transfer.

Brief on each:

- **Fire:** Combat, forging, illumination, cauterization. At high tier: thermokinesis, plasma, magma. Roughly a quarter of all practitioners study Fire — the most common school.
- **Water:** Flesh-healing (the body is mostly water), naval control, irrigation, ice. Blood manipulation at high tier (the line between healing and atrocity is intent).
- **Wind:** Speed, flight at high tier, ranged attacks, enhanced senses, communication relays. Suffocation at high tier. The standard scout's school.
- **Thunder:** Lightning, paralysis, magnetic effects, ward-breaking. **Un-theorized.** See `MAG-THUNDER-CORE` — this element is treated separately because nobody understands it.
- **Earth:** Fortification, construction, agriculture, terrain manipulation. Mineral-poultice healing. At high tier: petrification, metal extraction, geological-scale effects.
- **Light:** Disease-healing, purification, truth-detection, illumination. Memory manipulation at high tier. Sacred in Mercian faith traditions; treated as foreign or suspicious in Daqian.
- **Dark:** Shadow, concealment, fear, mana-absorption. Stigmatized in Mercia; respected in Daqian (ancestor-shadow traditions); neutral in Korval. The element is morally neutral. The reputation is not.
- **Spirit:** Beast-bonding, empathy, ancestral communion, nature-resonance. Dominion (mind control) at high tier. Watched everywhere because of the dominion risk.

### MAG-ELEMENTS-OPEN-APPLICATIONS

No element is locked to one role. Fire can heal (cauterize, kill infection). Earth can heal (mineral absorption). Water can kill (blood-freezing, drowning). Light can corrupt (erase memories). The circle pattern (or cultivation form, or magitech inscription) and the intent behind it determine effect. The element is the medium, not the message.

### MAG-ELEMENTS-RECEPTION

How each element is received in each zone:

|  | Mercia | Daqian | Korval | Spurlands | DWARVES | ELVES |
|---|---|---|---|---|---|---|
| Fire | revered (forge-saints, Iron Sovereign) | common | industrial backbone | weapon | revered (deep-forge) | wary (forest-fire) |
| Water | common (healing trades) | revered (clan-lineage element) | utilitarian (naval) | trade good | utilitarian | sacred (rivers, springs) |
| Wind | common (scouts, couriers) | common | strategic (airships) | normal | rare | sacred (whisper-rites) |
| Thunder | feared, no school | feared, no school | curiosity, no school | tolerated, no school | unknown | unknown |
| Earth | common (siege, agriculture) | revered (Mountain traditions) | industrial (mining, crystal) | weapon | sacred (the holds themselves) | utilitarian |
| Light | revered (faith institutions) | rare, suspect (foreign-religion stigma) | utilitarian | hidden | utilitarian | revered (dawn-rites) |
| Dark | feared, often forbidden | respected (ancestor-shadow traditions) | neutral, patentable | normalized | uncomfortable | abomination |
| Spirit | suspect (dominion fear) | restricted (clan-controlled) | failed paradigm (see `MAG-PEAK-IMPOSSIBLE`) | trade (beast-handlers) | indifferent | the elven element itself |

### MAG-ELEMENTS-COUNTERS

Rock-paper-scissors framing for combat planning:

- Water dampens Fire (and vice versa weakly).
- Earth blocks Wind, Fire, and physical projectiles.
- Light disintegrates Dark; Dark consumes/conceals from Light.
- Spirit resists Spirit (mutual mind-defense).
- Thunder disrupts *everything* — wards, barriers, enchantments, nervous systems. The element has no clean counter; that is part of why it terrifies.

No matchup is unwinnable through preparation, terrain, or rank advantage. Counter-element is a planning consideration, not a deterministic outcome.

---

## 5. THE PEAK MATRIX

### MAG-PEAK-CORE

**Rule:** A peak exists in the world only where **paradigm × element × institutional concentration** align.

Most A-ranks are powerful generalists in their school. **Peaks are S-tier or named-legend territory** — one to three living practitioners per peak path globally, often vacant. Walking a peak path is the difference between "regional power" and "world-historical figure."

This is the rarity that makes peaks dramatic. A campaign can be built around a single peak-walker's emergence.

### MAG-PEAK-FILLED — Active Peak Paths

**Mercia — magic + faith paradigm**

- **Light → Paladin-Ascendant** [`MAG-PEAK-PALADIN`]
  Warrior-priest whose faith-bond with [the Eternal Flame] deepens until divine-flavored mana saturates them. At peak: manifest wings of mana, halo-judgment that compels truth, partial metaphysical presence — they walk through fire that does not touch them. Still magic-paradigm: they channel a god's reservoir, they do not transform into light. Heavy miracle-ledger debt; their kingdom pays for every miracle in tithes, conscriptions, or territorial concessions. Currently held by 1–2 living knights; the title is fought over in tribunal succession when one dies.

- **Light → Inquisitor-Saint** [`MAG-PEAK-INQUISITOR`]
  Truth-Seer and Memory-Writer peaks fused. Cannot be lied to in their presence. Can rewrite a confessed sinner's memory of their sin, leaving them functional but altered. Operates the Ash Inquisition. The Arch-Deacon Ser Odrik Abstergo in the old roster is climbing this path (B→A via relics). Less battlefield than Paladin-Ascendant; more institutional dread.

- **Light → Pope-Conduit** [`MAG-PEAK-POPE`]
  One living person at a time. Holds the largest single faith-bond with [the Eternal Flame]. Channels catastrophic-tier miracles at city-scale — purges, sanctifications, mass healing or mass burning. Does not fight; does not need to. Story-gated; a Pope's death triggers continental political realignment.

- **Earth → Wall-Lord** [`MAG-PEAK-WALL-LORD`]
  Commands stone at city-scale. Fortifies provinces against siege through inscribed living walls. Animates *banner-knights* — empty armor moved by Earth-mana, organized into regiments. A Wall-Lord on the defense is functionally a fortress with personality. Cannot project offensive power far from worked stone. The Godwin war-house produces these; Lord Marshal Brannoc would aspire if he had the patience, which he doesn't.

- **Fire → Forge-Saint** [`MAG-PEAK-FORGE-SAINT`]
  Iron Sovereign clergy. Bridges magic and runecraft — they hand-forge relic-weapons whose flames burn with faith-tier mana, lasting centuries. A Forge-Saint's blade in the hands of a D-rank knight punches above weight. The Mercian arms industry depends on these clergy; their disappearance would collapse the Abstergo war economy in a generation.

**Daqian — cultivation paradigm**

- **Dark → Shadow Sovereign** [`MAG-PEAK-SHADOW-SOVEREIGN`]
  The iconic Eastern Dark peak. Body becomes shadow; binds defeated foes as shadow-soldiers; commands a personal shadow-army that scales with the holder's kill-count; can step between any two shadows in line-of-sight. Rare-per-generation. **May or may not currently exist** — a worldbuilding hook. If currently vacant, the world is one cultivator's breakthrough away from upheaval. If currently held, the holder is the most feared individual in the known world and probably knows it.

- **Water → Tide-Ancestor** [`MAG-PEAK-TIDE-ANCESTOR`]
  Oceanic-scale cultivation. Calms or drowns fleets. Reads memory from rivers — every flow a Tide-Ancestor touches reveals what passed it. At peak the body is partially water, dispersing and re-forming. Long-lived; many Tide-Ancestors retire into the sea rather than die on land.

- **Earth → Mountain-Saint** [`MAG-PEAK-MOUNTAIN-SAINT`]
  Body becomes living stone. Immovable. Geological patience. A Mountain-Saint walks through siege engines without registering the impact. They cannot pursue, cannot strike fast, cannot retreat — but you cannot move them, and what they stand on becomes theirs. Often retire into actual mountains, becoming geological features that occasionally speak.

**Korval — magitech paradigm**

- **Fire → Plasma-Lance Master** [`MAG-PEAK-PLASMA-LANCE`]
  Artificer who builds light-of-the-forge weapons at industrial scale. Their workshops produce siege-lances that compress fire to plasma before discharge. A Plasma-Lance Master's signature weapon is worth a small fleet. Their personal combat power is gear-dependent — strip the suit and you have a clever engineer; armed, they peer with B-rank front-line cultivators.

- **Earth → Crystal-Prismatic Engineer** [`MAG-PEAK-PRISMATIC`]
  Mana-conducting crystal architecture. The [Prismline] is their substrate. Can build self-powering city districts where ambient crystal-arrays handle lighting, climate, signaling, and defense without active casters. A Prismatic Engineer's home city operates while they sleep, which is convenient because they rarely sleep.

- **Wind → Skywright** [`MAG-PEAK-SKYWRIGHT`]
  Airship dominance, sound-cannons, weather-control gear. Designs the keels and wind-circles that lift Korval navies above water and across continents. Without Skywright peaks Korval would be a maritime power, not an aerial one. There are perhaps three living Skywrights; their patent disputes shape Coin Council politics.

**Eikinholt — runecraft**

- **Earth → Stone-Witness** [`MAG-PEAK-STONE-WITNESS`]
  Contracts carved in basalt that endure for centuries. Walls that remember every oath sworn against them. Legal-magical fusion: a Stone-Witness inscription is *evidence* in any court that knows dwarven law. Their work outlasts kingdoms.

- **Fire → Deep-Forger** [`MAG-PEAK-DEEP-FORGER`]
  Alloys impossible elsewhere — spirit-steel that holds enchantment without inscription, metals that ignore certain physical laws under load. Occasional forge-wraith incidents (already in the old lore): a Deep-Forger who pours too much of themselves into a piece may leave a residue that becomes ambulatory. The Embervault hold treats this as an occupational hazard.

**Aelynost — collective resonance**

- **Spirit → Forest-Choir** [`MAG-PEAK-FOREST-CHOIR`]
  Elves as nodes in the forest's will. Defending elven territory is not defending elves — it is fighting the forest itself, with centuries of accumulated mana and territorial memory. Caer Idmir and Oldwood Deep are this peak's expression. An attacking army does not face soldiers; it faces terrain that decides to be hostile.

- **Wind → Whisper-Council** [`MAG-PEAK-WHISPER-COUNCIL`]
  Cross-continent message networks. Eavesdrop on conversations a thousand miles away. Send signals between groves faster than any horse, ship, or Korval semaphore-line. Strategic monopoly on long-range communication. **No competing technology exists** — see `MAG-KORVAL-TECH-FLOOR`. Wars are won or lost on whether you have a Whisper-Council message-line. Elves rent their use sparingly and at high price.

**Spurlands — anomaly zone, no institutional peaks**
See `MAG-THUNDER-MARCHES`. Outlaw practitioners only; no peak path is institutionally supported.

### MAG-PEAK-THEORETICAL — Unachieved Cells

These are peak paths that *could* exist if the right (paradigm × element × concentration) intersection occurred. None currently does. Each is a story-hook.

- **Photon-Logia** [`MAG-PEAK-PHOTON-LOGIA`] (cultivation × Light)
  Body becomes light. Light-speed movement, laser-discharge, blinding-flash dispersal. Requires Eastern cultivation paradigm + Light affinity + survival of the climb. Light is barely practiced in Daqian (suspect, foreign-religion stigma); no school cultivates it. **Theoretical, vacant.** If someone walked this path it would terrify every kingdom — there is no defense against an opponent moving at light-speed, and no Mercian Light institution can match the cultivation-paradigm body-shift.

- **Storm-Sovereign** [`MAG-PEAK-STORM-SOVEREIGN`] (cultivation × Thunder)
  Eastern body-transformation peak for Thunder. Blocked by Thunder being un-theorized — nobody has lived long enough on the climb to systematize the path. If achieved, the holder would combine the Shadow Sovereign's iconic command-of-element with Thunder's universal disruption. Currently impossible because the foundational theory does not exist.

- **Spirit-Magitech (any)** [`MAG-PEAK-IMPOSSIBLE-SPIRIT`]
  Korval attempted Spirit-magitech once at [Gleamworks]. Prototype catastrophically failed and is sealed. Spirit requires a living interface; inert gear rejects it — the mana-crystal cracks, the alchemical reagents combust, or the device acquires a fragmentary will of its own and turns on the user. Treated by Korval artificers as a structural impossibility. Some heretics disagree and quietly try anyway.

- **Mercia Dark peak** [`MAG-PEAK-IMPOSSIBLE-DARK-MERCIA`]
  No peak path exists because Dark is institutionally forbidden. The cult-cap rule applies (see below): Mercian Dark practitioners cap at B. If a Mercian somehow achieved a true Dark peak it would be a *new* path (likely a heretical hybrid of magic-paradigm Dark — Memory-Thief, Stealth-God, or Fear-Tyrant). The Inquisition response would be immediate and total. This has been attempted three times in recorded history. Three times the Inquisition won, with help from Daqian envoys who do not want a foreign Dark peak destabilizing their own monopoly.

### MAG-PEAK-CULT-CAP — Hard Rule

Cults *can* practice off-zone elements but **cannot reach the peak**. Their ceiling is B-rank.

- The Umbral Mirror Cabal practices Dark in Mercia. They cap at B. No Shadow Sovereign emerges from cult ranks.
- The Coinlit Covenant practices Spirit-aligned bargain-magic in Korval. They cap at B. No Forest-Choir analog emerges.
- The Indexers practice Light-via-knowledge-binding in Daqian. They cap at B. No Pope-Conduit emerges.

**Why:** Peak paths require institutional concentration — masters to teach, traditions to refine across generations, regional mana-density to support extreme practice, cultural license to attempt the climb publicly. Cults have none of these. They practice in shadow, with stolen fragments of doctrine, under threat. They produce dangerous practitioners. They do not produce world-historical figures.

**Implication:** Cults are *threatening but containable*. Until someone smuggles a true peak-walker across borders. A real Eastern Shadow Sovereign appearing in Mercia under cult protection is an existential crisis — the entire continent's strategic balance pivots on that one person.

---

## 6. THUNDER — THE UN-THEORIZED ELEMENT

### MAG-THUNDER-CORE

Thunder is not rare because of bloodline. Thunder is rare because **nobody understands it well.**

It is the magical equivalent of pre-electricity natural philosophy. Witnessed in storms. Mythologized as the wrath of skies. Feared as omen. No academic theory of how it works. No school willing to teach it openly. No senior practitioners to mentor the next generation, because senior practitioners are almost always dead.

Thunder practitioners are self-taught. They miscast frequently. They kill themselves on the climb — internal nerve-burns, cardiac arrest from feedback, slow neurological decay. Survivors are erratic because their own art is erratic to them. They do not know why their casting works; they have rituals and habits they cannot explain.

A Thunder practitioner is, in modern terms, an 18th-century natural philosopher rubbing amber on cloth and recording the spark. There is a phenomenon. There is no theory.

### MAG-THUNDER-COROLLARIES

- **Magnetism is also un-theorized.** Lodestones are magical curiosities sold in Korval novelty shops. Sailors use compasses without understanding them — empirical practice with no foundation. The Iron Sovereign cult may weaponize magnetism (relic-blades that draw armor toward them, ritual sites that pull iron from the bones of the slain) without ever knowing what they're doing.
- **Mana-storms** in deep Spurlands wilderness and over the Skyteeth Range are likely atmospheric electromagnetic events. Nobody has connected them to Thunder practitioners. Locals call them divine omens or beast-tides. They occasionally fry caravans.
- **No institutional Thunder peak exists.** The closest are outlaw Thunder users in Spurlands — the anomaly zone naturally attracting the anomaly element. Even those are not true peaks; they are powerful, unstable, and short-lived.

### MAG-THUNDER-MARCHES

Spurlands tolerates Thunder because Spurlands tolerates everything. Outlaw Thunder users — sometimes called "stormbringers" or "iron-stained ones" by the warlord camps — hire on as battlefield disruptors. Their value:

- One Thunder caster on a battlefield disrupts enemy wards, scrambles enchanted gear, paralyzes mounts.
- Their unreliability is priced in. Half of them miscast at least once per major engagement, sometimes killing themselves and nearby allies.
- No warlord employs more than one at a time, because two Thunder casters in proximity tend to *resonate* in ways neither controls.

The closest thing to a Thunder peak in the world is a Spurlands stormbringer who has survived twenty engagements. There may currently be one such person alive. They are not S-rank — they are a high B with anomalous output, and they will die before reaching A unless something fundamental changes.

### MAG-THUNDER-ISEKAI-HOOK

**Latent world-feature, not enforced premise.**

A modern-world arrival carries the missing theory. Ohm's law, electromagnetic fields, capacitance, induction, the relationship between magnetism and current. They do not need chosen-one mechanics. They are simply *literate in something nobody else is*.

What this enables:

- **First true Thunder academic in history.** The peak nobody achieved is locked not by power but by *conceptual model*. The arrival has one.
- **Cross-pollination with Korval steampunk** triggers the world's industrial revolution. Electrical components grafted onto mana-crystal substrates. Electric motors. Telegraphy. The strategic monopolies of Aelynost (long-range comms) and Korval (industrial output) both crack open.
- **The only faction-neutral counter to a Shadow Sovereign.** Thunder ward-breaking already disrupts everything; a *trained* Thunder user disrupts at peak-vs-peak scale. The Inquisition would court them. The clans would hunt them. The Coin Council would patent them.

Every major faction has reason to capture, control, or kill the arrival. The Spurlands are the only place they can hide. This is *convergent* with the Spurlands' existing role as refuge for failed-peak attempts and forbidden practitioners.

The world does not *need* an isekai protagonist. It has a Thunder-shaped hole that one could fill. Native practitioners can also fill it — a Spurlands stormbringer who survives long enough to actually theorize, an Korval artificer who steals enough modern-world fragments from a captured arrival, an Daqian heretic who reads forbidden star-texts that contain electromagnetic principles. The plot is the same. The odds are harder.

---

## 7. Korval — STEAMPUNK TECH FLOOR

### MAG-KORVAL-TECH-FLOOR

Korval magitech is **mechanical + magical**. It is **not electrical**. This is a hard worldbuilding rule that shapes the strategic balance.

### MAG-KORVAL-EXISTS

- Clockwork mechanisms — gears, escapements, automatons capable of pre-programmed motion sequences.
- Steam engines — limited; pressure vessels are dangerous without modern metallurgy. Used in fixed installations, rarely vehicles.
- Pneumatics and hydraulics — compressed air, water, and oil pressure systems for power transmission.
- Mana-crystal reservoirs — store mana, not chemical-electrical potential. Different physics from batteries. A crystal can be drained, recharged (slowly, from ambient), or shattered (releasing stored mana in dangerous bursts).
- Alchemical reagents — luminescence compounds (for lighting), propellants (for projectile weapons), reactive compounds (for medicine and warfare).
- Inscribed metalwork — mana-conductive runes etched on brass, iron, and alloyed substrates. The basis of all magitech device-shaping.
- Optical systems — lenses, mirrors, telescopes, semaphore-flag networks for line-of-sight communication.
- Printing press equivalent — movable type with mana-cured ink for durability.
- Alchemical photography — light-sensitive plates capture images; slow exposure required.

### MAG-KORVAL-DOES-NOT-EXIST

- **Electricity in any controlled form.** Static discharge is observed (cat fur, amber rubbing) and considered a minor Thunder anomaly. Nobody has connected it to a workable energy system.
- **Batteries.** Chemical-electrical cells do not exist. Mana-crystals are not batteries — different mechanism.
- **Telegraph, telephone, radio.** No long-range electrical communication.
- **Electric lighting.** Cities use crystal-glow lamps, alchemical luminescence, oil lamps, and (in Mercia) candles.
- **Electric motors.** All powered motion uses steam, pneumatics, clockwork, or direct mana-channel.
- **Magnetic compasses are empirical curiosities.** Sailors use them. Nobody knows why they work. There is no theory of magnetism.
- **Computers, recording media, electromagnetic anything.**

### MAG-KORVAL-WHY-MATTERS

- Aelynost Whisper-Council long-range comms is a *real* strategic monopoly. Wars are won or lost on whether you have an elven message-line. No competing technology exists. The elves know this and price accordingly.
- Korval industrial output is impressive but *capped* at a pre-electrical ceiling. They cannot scale beyond what mana-crystal density and clockwork complexity allow.
- An isekai-style unlock of electricity would *break* the strategic balance. This is why the Thunder-shaped hole is load-bearing for any campaign that wants to introduce that kind of disruption.

---

## 8. FORBIDDEN LINE

### MAG-FORBIDDEN-CORE

Universal because the substance is universal. Every paradigm, every zone, every element-school agrees on two prohibitions:

- **Soul violation.** Using mana to tear at the soul rather than the body. Permanent spiritual damage that no healing can undo. Practitioners develop a signature mana-taint that other casters can sense — they smell wrong, their mana feels greasy. The faithful track them by this residue.
- **Death exploitation.** Animating corpses, binding spirits against their will, harvesting death for power. Necromancy is the canonical example but not the only one. The Pale Architect perfected the worst variants during the Necromancer Wars; the world has not forgotten.

The line is **intent**, and intent is hard to prove. A Water-healer's hand on a wound is sacred. The same hand crushing blood vessels is execution-worthy. The technique is identical. Most prosecutions of suspected forbidden practitioners are guilty of *appearance*, not actual violation.

### MAG-FORBIDDEN-ENFORCEMENT

Each zone enforces differently:

- **Mercia:** Public burning, tribunal trial, Inquisition seizure of property. Theatrical. The Ash Inquisition prefers fire for visible deterrence; the Abstergo order prefers tribunal for political precedent.
- **Daqian:** **Core Severing.** Ritual that permanently burns out a practitioner's mana core. The condemned remains alive but magically dead — unable to cultivate, feel ambient mana, or sense their own former power. Most cultivators consider it worse than death. Severing is performed publicly within the clan; the severed are then exiled to live as civilians, a constant reminder.
- **Korval:** Patent revocation, asset seizure, exile from all city-states. Economic execution. The condemned cannot work, cannot purchase magitech, cannot enter Korval ports. Many die in Spurlands within a year. The Coin Council considers this both more humane and more profitable than physical execution.
- **Spurlands:** Killed on the spot by whoever notices first. No process, no trial. Bounty paid by neighboring zones for the body.
- **Eikinholt:** Buried in stone. Literally. The hold cuts a niche into a deep wall, places the condemned inside, and seals it with a Stone-Witness inscription that documents the crime. The niche remains visible. The dwarven holds are dotted with these.
- **Aelynost:** The forest rejects them. The grove withdraws its resonance. Exile-sickness sets in within weeks. The condemned typically dies within months. The elves consider this not punishment but *natural consequence* — the forest knows; the choir does not need to vote.

### MAG-FORBIDDEN-GREY

- Not all Dark practitioners are necromancers. Not all Spirit practitioners are dominators. Element stigma is real but is not the same as guilt.
- Ancestor-binding in Daqian is *not* necromancy by Eastern standards — the ancestor consents in advance through pre-death oath. By Mercian standards it is heresy regardless. Border provinces with mixed populations have constant theological-legal collisions over this.
- Dominion (mind control) is universally forbidden but Spirit-empathy is universally accepted. The line between is contested and shifts with every high-profile prosecution.
- Memory manipulation by Light is *sanctioned* in Mercia when performed by Inquisitor-Saints for "purification" purposes. The Schismatic faction considers this a soul-violation in fancy dress. The argument has killed thousands.

---

## 9. RAG RETRIEVAL HINTS

### MAG-RAG-HINTS

Anchor queries for retrieval:

- **System overview:** `MAG-MANA-CORE`, `MAG-PARADIGM-CORE`, `MAG-RANK-F-S`
- **Specific paradigm:** `MAG-PARADIGM-CULTIVATION`, `MAG-PARADIGM-MAGIC`, `MAG-PARADIGM-MAGITECH`, `MAG-PARADIGM-RUNECRAFT`, `MAG-PARADIGM-RESONANCE`
- **Peak path lookup:** `MAG-PEAK-SHADOW-SOVEREIGN`, `MAG-PEAK-PALADIN`, `MAG-PEAK-WHISPER-COUNCIL`, etc.
- **Peak vacancy / story-hook:** `MAG-PEAK-PHOTON-LOGIA`, `MAG-PEAK-STORM-SOVEREIGN`, `MAG-PEAK-IMPOSSIBLE-SPIRIT`
- **Cult containment:** `MAG-PEAK-CULT-CAP`
- **Thunder + isekai:** `MAG-THUNDER-CORE`, `MAG-THUNDER-MARCHES`, `MAG-THUNDER-ISEKAI-HOOK`
- **Korval tech limits:** `MAG-KORVAL-TECH-FLOOR`, `MAG-KORVAL-DOES-NOT-EXIST`
- **Forbidden practices:** `MAG-FORBIDDEN-CORE`, `MAG-FORBIDDEN-ENFORCEMENT`

For scene planning that involves a magical conflict, retrieve:
1. The paradigm anchor(s) for the practitioners involved
2. The relevant element schools from `MAG-ELEMENTS-CORE`
3. Any peak paths that apply (`MAG-PEAK-FILLED` or `MAG-PEAK-THEORETICAL`)
4. The cultural reception line for the elements involved (`MAG-ELEMENTS-RECEPTION`)
5. The forbidden line if the conflict pushes near it (`MAG-FORBIDDEN-GREY`)

### MAG-RAG-INTEGRATION

When integrating with the wider world lore (after the modernization pass), each zone's faction entries should carry:
- A paradigm tag
- Their 2–4 peak-element commitments
- Their peak-path holders (named NPCs from the existing roster, assigned)
- Their cult-cap concerns (which forbidden practices are active in their territory)
- Their position on the cross-zone tensions documented in `MAG-PEAK-FILLED` (Earth-on-Earth, Fire-on-Fire, etc.)

Each named NPC in the existing roster should carry:
- Rank (F–S) and Depth (F–S), already mostly present
- Element-school primary (and secondary if applicable)
- Peak path if any (most will not — peaks are rare)
- Paradigm (usually inherited from zone but exceptions exist — a foreign-trained NPC carries their training paradigm)

---

**End of document.** Round 2 rename pass applied. God names, cult names, sub-location names pending later rounds.
