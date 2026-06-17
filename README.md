# Narrative Engine — Mobile

The mobile companion to [Narrative Engine](https://github.com/Sagesheep/NarrativeEngine-P). Same AI Dungeon Master, built as a native Android app with Capacitor.

Run extended, multi-session TTRPG campaigns with persistent memory, living NPCs, and automated world management — powered by any OpenAI-compatible LLM or Ollama endpoint — from your phone.

No cloud. No subscription. Your campaigns stay on your device.

---

## Core Engine & Capabilities

All core features from the desktop app are available on mobile, with optimizations for native devices:

### 🧠 High-Scale Memory & Smart Recall (Tested up to 1000+ Scenes)
Built to support massive, long-running campaigns without memory degradation:
* **Tested at Scale:** Successfully manages campaigns running **1,000+ scenes** (complete back-and-forth interactions between GM and player) with no loss in performance.
* **Deep Archive & Historical Recall:** Seamlessly queries and calls earlier scenes from deep within the campaign history at any time.
* **Context Preservation:** Employs multi-phase LLM searches and semantic search over the full campaign log to pull exact history and lore back into the active context.
* **Smart Auto-Condensation:** Automatically compresses older turns into running summaries while preserving critical facts, HP/MP counters, proper names, and memorable quotes.

### 🔌 Local On-Device Vector Embeddings (100% Offline)
Powered by a local, on-device transformer model (`all-MiniLM-L6-v2` via Hugging Face Transformers) running completely offline on your device:
* **Private & Cost-Free Semantic Search:** Generates embeddings for campaign rules, world lore, and chapter summaries locally.
* **Instant Keyword & Vector Matching:** Searches and matches lore chunks instantly against your active conversation turns without hitting external API endpoints.

### 🎚️ Customizable AI Call Budget (Lite / Pro / Max)
Tailor how many LLM calls fire per turn to control API costs or accommodate local/weaker LLM endpoints:
* **Lite (~1 call/turn):** Runs only the main Storyteller LLM. Memory recall, NPC tracking, and state management are handled by the built-in local engine and on-device vector search. (Skips AI chapter summarization and NPC profiling).
* **Pro (~4–6 calls/turn):** Adds high-impact context systems (search planners, chapter recall funnels, NPC/lore recommenders) and maintains summaries.
* **Max (~9–10 calls/turn):** Runs all systems including query expansion, reranking, per-turn importance rating, NPC intros, and full profile scans.

### 🧠 NPC Agency System (Phases 1-4)
Allows off-screen NPCs to act, evolve, and affect the world dynamically:
* **Off-Screen Tick Engine:** A proximity-based heartbeat system simulates NPC activity off-screen based on regional locations, factions, and relationships.
* **Wants & Goals Lifecycle:** Draws short-term and medium-term wants, upgrading them to long-term goals.
* **Dynamic Personality Hex Drift:** Actions/outcomes nudge personality axes (boldness, composure, etc.) by $\pm 1$ (clamped to $[-3, +3]$), displaying drift alerts in the chat.
* **Power Rung & Tier-Crossing:** Tracks NPC skill progression (from *Unskilled* up to *Legend*) through goals and justified world events.

### 🧙‍♂️ Guided PC Creation Wizard
An interactive character creation suite to build your protagonist:
* **Point-Buy Attribute Allocator:** Configure stats using standard 27-point or overpowered 37-point budgets.
* **Archetype Drafting:** Select classes and roles, automatically applying engine-level combat overrides.
* **Lore Integration:** Interactive lore browsing during the creation steps to ground your character in the world.

### ⚡ Performance & Caching Upgrades
* **Stable Prefix Architecture:** Restructures prompt construction (system prompt, pinned lore) to maximize LLM prompt cache hit rates.
* **EngineTraceView:** Inline visualization of cache boundaries (Cached Prefix vs. History vs. Current Turn) to audit token efficiency.
* **Zustand & Render Optimization:** Highly optimized component memoization to ensure smooth rendering on low-spec mobile devices.

### ⚙️ Decoupled LLM Providers & Presets
* **Unified Provider Panel:** Configure your API keys, endpoints, and settings once, then map them to presets.
* **Flexible Preset Configs:** Define up to 6 custom endpoints/roles per preset (Story AI, Summarizer AI, Utility AI, Image AI, Co-DM roles).

### ⚔️ Optional: Engine-Governed Combat Mode (v1.1)
*An optional, experimental local ruleset that can be enabled to govern battles (D&D 5e RAW rules, Focus (FOC) system, and deterministic enemy AI turn resolution).*

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Android Studio](https://developer.android.com/studio) with Android SDK installed
- Java 17+

### Install & Run (dev)

```bash
git clone https://github.com/Sagesheep/NarrativeEngine-M.git
cd NarrativeEngine-M
npm install
npm run dev
```

### Build APK

Building the APK requires compiling the native project with Gradle:

1. **Sync web files to the native Android project:**
   ```bash
   npm run build:apk
   ```
2. **Compile the APK via Gradle:**
   - **On Windows (PowerShell/CMD):**
     ```cmd
     cd android
     .\gradlew.bat assembleDebug
     ```
   - **On macOS/Linux:**
     ```bash
     cd android
     ./gradlew assembleDebug
     ```

The compiled debug APK will be output to `android/app/build/outputs/apk/debug/` (e.g. `NE v1.6.13.apk`).

*Alternatively, you can open the `android` folder in Android Studio and select **Build > Build Bundle(s) / APK(s) > Build APK(s)**.*

### Install on device

Enable **Install unknown apps** on your Android device, then sideload the compiled APK — or run it directly from Android Studio onto your connected device.

---

## Connecting to Your LLM

The mobile app connects to LLM providers over the network:

- **Remote API** — OpenAI, DeepSeek, or any OpenAI-compatible cloud endpoint. Add your API key in the **Providers** tab.
- **Local Ollama** — Run Ollama on your PC and point the app at your machine's local IP (e.g., `http://192.168.1.x:11434`). Ensure Ollama listens on all interfaces: `OLLAMA_HOST=0.0.0.0 ollama serve`.

---

## Core Features (RAG & Memory)

### Your Campaign, Your World
- Multiple campaigns with independent world, lore, and state.
- Markdown lore editor with auto-classification and keyword triggering.
- Pin critical lore so it's always in context.

### Smart Memory & High Scale
- **Session summaries** — old history auto-condensed, memorable quotes preserved.
- **Scene archive** — lossless verbatim log of all scenes, never discarded.
- **Chapters** — auto-organized with LLM-generated summaries.
- **Semantic search** — recall by meaning across your full history.

### Living NPCs
- Auto-detected as they appear in the story.
- AI-generated profiles: personality, voice, goals, factions, visuals.
- Portrait generation in 5 art styles.
- Witness tracking and relationship networks.

### World State Tracking
- Living timeline of world truths — locations, alliances, deaths.
- Auto-resolved contradictions.
- Manual event management.

### Dice & Randomness
- Surprise, Encounter, and World Event engines with configurable thresholds.
- Fair dice pool with advantage/disadvantage, criticals, and catastrophes.

### AI Co-DMs
- Enemy, Neutral, and Ally AI personas with independent LLM endpoints.

### LLM Tool Calls
- **Query Campaign Lore** — GM recalls world details on the fly.
- **Update Scene Notebook** — volatile working memory for active scene state.
- **Deep Archive Search** — tap the scan icon in the header to arm a full lore sweep on the next send.

### Security
- AES-256-GCM encrypted API key vault.
- Machine-key and password modes.
- Client-side encryption only.

---

## Quick Start — Example Campaigns

Two ready-to-play campaigns are included in the [`Example_Setup/`](https://github.com/Sagesheep/NarrativeEngine-M/tree/main/Example_Setup) folder:

| Campaign | Setting |
|---|---|
| **Spirit Card World** | Gritty survival fantasy — humanity behind walls, monsters outside, Spirit Cards as power |
| **Shinobi World** | Naruto-inspired TTRPG with expanded lore and a campaign seed |

Each folder contains three files you'll copy into the app:

| File | Where it goes in the app |
|---|---|
| `AI_GM_OS_v3_4_App_Optimized.md` | **Campaign Settings → System Prompt** |
| `*_world_lore*.md` / `awakening_world.md` | **World Info (Lore)** tab |
| `starter_prompt.md` / `campaign_start_seed.md` | Your **first message** in the chat |

### How to load them on your phone

There's no file picker — copy the text directly from GitHub into the app:

1. On your phone, open the campaign folder on GitHub (link above)
2. Tap a file $\rightarrow$ tap the **Raw** button $\rightarrow$ select all $\rightarrow$ copy
3. Open Narrative Engine, create a new campaign, and paste into the right field (see table above)
4. Repeat for the other two files
5. Hit send on the starter prompt — the GM will walk you through character creation

**Tip:** Do the lore and system prompt first, then start the chat with the starter prompt as your opening message.

---

## Developer Quick Reference

| Action | Command |
|---|---|
| Install | `npm install` |
| Dev server | `npm run dev` |
| Build & Sync | `npm run build:apk` |
| Lint | `npm run lint` |
| Generate icons | `npm run generate-icons` |
| Run Tests | `npm run test` |
| Run Eval Tests | `npm run eval` |

---

## License

MIT License — Copyright (c) 2026 Sagesheep.
