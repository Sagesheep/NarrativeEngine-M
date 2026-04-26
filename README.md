# Narrative Engine — Mobile

The mobile companion to [Narrative Engine](https://github.com/Sagesheep/NarrativeEngine-p). Same AI Dungeon Master, built as a native Android app with Capacitor.

Run extended, multi-session TTRPG campaigns with persistent memory, living NPCs, and automated world management — powered by any OpenAI-compatible LLM or Ollama endpoint — from your phone.

No cloud. No subscription. Your campaigns stay on your device.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Android Studio](https://developer.android.com/studio) with Android SDK installed
- Java 17+

### Install & Run (dev)

```
git clone https://github.com/Sagesheep/NarrativeEngine-M.git
cd NarrativeEngine-M
npm install
npm run dev
```

### Build APK

```
npm run build
npm run build:apk
```

The APK is output to `android/app/build/outputs/apk/`.

### Install on device

Enable **Install unknown apps** on your Android device, then sideload the APK — or open the project in Android Studio and run it directly.

---

## Connecting to Your LLM

The mobile app connects to LLM providers over the network. Options:

- **Remote API** — OpenAI, DeepSeek, or any OpenAI-compatible cloud endpoint. Add your API key in Settings.
- **Local Ollama** — Run Ollama on your PC and point the app at your machine's local IP (e.g. `http://192.168.1.x:11434`). Make sure Ollama is set to listen on all interfaces: `OLLAMA_HOST=0.0.0.0 ollama serve`.

---

## Features

All core features from the desktop app are available on mobile. See the [desktop README](https://github.com/Sagesheep/NarrativeEngine-p) for full details. Summary:

### Your Campaign, Your World
- Multiple campaigns with independent world, lore, and state
- Markdown lore editor with auto-classification and keyword triggering
- Pin critical lore so it's always in context

### Smart Memory
- **Session summaries** — old history auto-condensed, memorable quotes preserved
- **Scene archive** — lossless verbatim log, never discarded
- **Chapters** — auto-organized with LLM-generated summaries
- **Semantic search** — recall by meaning across your full history

### Living NPCs
- Auto-detected as they appear in the story
- AI-generated profiles: personality, voice, goals, factions, visuals
- Portrait generation in 5 art styles
- Witness tracking and personality drift alerts

### World State Tracking
- Living timeline of world truths — locations, alliances, deaths
- Auto-resolved contradictions
- Manual event management

### Dice & Randomness
- Surprise, Encounter, and World Event engines with configurable thresholds
- Fair dice pool with advantage/disadvantage, criticals, and catastrophes

### AI Co-DMs
- Enemy, Neutral, and Ally AI personas with independent LLM endpoints

### LLM Tool Calls
- **Query Campaign Lore** — GM recalls world details on the fly
- **Update Scene Notebook** — volatile working memory for active scene state
- **Deep Archive Search** — tap the scan icon in the header to arm a full lore sweep on the next send

### Security
- AES-256-GCM encrypted API key vault
- Machine-key and password modes
- Client-side encryption only

---

## Supported LLM Providers

Any OpenAI-compatible API. Configure up to 6 endpoints per preset:

| Role | Purpose |
|---|---|
| **Story AI** | Main GM narration |
| **Summarizer AI** | Condensing old history |
| **Utility AI** | NPC validation, importance rating, context recommendations |
| **Image AI** | Portrait and scene generation |
| **Enemy / Neutral / Ally AI** | Co-DM personas |

---

## Setting Up Your First Campaign

The desktop repo's `Example_Setup/` folder contains a complete ready-to-play campaign (**The Awakening**) with world lore, a GM rulebook, and a starter prompt. You can use those files directly in the mobile app:

1. Create a new campaign
2. Open **World Info (Lore)** and paste `Spirit_Card_World_Lore.md`
3. Open **Campaign Settings** and paste `Rulebook v2.6.md` into the System Prompt field
4. Start a chat and paste `starter_prompt.md` as your first message

See the [desktop README](https://github.com/Sagesheep/NarrativeEngine-p#setting-up-your-first-campaign) for full setup details and lore writing conventions.

---

## Quick Reference

| Action | Command |
|---|---|
| Install | `npm install` |
| Dev server | `npm run dev` |
| Build APK | `npm run build && npm run build:apk` |
| Lint | `npm run lint` |
| Generate icons | `npm run generate-icons` |

---

## License

MIT License — Copyright (c) 2026 Sagesheep.
