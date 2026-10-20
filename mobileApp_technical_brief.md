# MOBILE APP NARRATIVE ENGINE: TECHNICAL BRIEF

## 1. ENGINE ARCHITECTURE
The Narrative Engine is a sophisticated **Context Orchestrator** for LLMs. It does not just send a chat history; it dynamically builds a multi-layered prompt designed to give the AI the "full picture" of the world and current state while staying within context limits.

## 2. PROMPT HIERARCHY (Payload Construction)
The engine assembles the prompt in the following priority order:
1.  **Stable Truth**: System Prompt, Core Rules, and Campaign Starter.
2.  **Divergence Register**: The "New Canon." Any events that have happened during play that override the original lore.
3.  **Volatile State**: Current Character Profile, Inventory, and Scene Notebook (working memory).
4.  **World Lore (RAG)**: Relevant chunks of the world lore file injected based on keyword matches and semantic search.
5.  **Active NPCs**: Minified profiles of NPCs currently involved in the scene.
6.  **Fitted History**: Recent dialogue, trimmed to fit the remaining budget.

## 3. LORE INGESTION & RETRIEVAL
### Ingestion (Markdown Parsing)
Lore is parsed from a single Markdown file. The engine looks for:
- `##` or `###` headers.
- `[CHUNK: TYPE -- NAME]` prefixes (e.g., `### [CHUNK: faction -- Ironwall]`).
- Supported types: `world_overview`, `faction`, `location`, `character`, `power_system`, `economy`, `event`, `rules`.

### Retrieval (RAG)
Lore chunks are injected into the context via:
- **Keyword Triggers**: If a word in `triggerKeywords` appears in the recent chat or the user's message, the chunk is prioritized.
- **Category Scoring**: The engine boosts scores for certain categories (e.g., "Combat" boosts `power_system` chunks).
- **Tool Calls**: The AI can explicitly query the lore using `query_lore`.

## 4. NPC & STATE MANAGEMENT
### Living NPCs
- NPCs are auto-detected by name in the text.
- The engine tracks **Witnessing**: Only NPCs who witnessed an event can recall it (unless it's global news).
- Profiles are minified for the prompt to save tokens.

### Memory Systems
- **Scene Notebook**: Short-term, volatile facts about the immediate area. The auxiliary model maintains it after each turn (not a story-model tool); edits apply when the turn commits.
- **Canon State**: Long-term, immutable truths.
- **Deep Archive Search**: A full sweep of the entire session history that synthesizes a brief for the AI.

## 5. OPTIMIZING LORE FOR THE ENGINE
To ensure the **Themis** lore works perfectly:
1.  **Headers**: Maintain the `### Category — Title` format.
2.  **Triggers**: Ensure NPCs, Locations, and Factions have their names as trigger keywords.
3.  **Power System**: Ensure the unique "Physics-as-Types" rules are marked as `alwaysInclude` or have high-priority triggers (combat, element names).
4.  **Bonds**: The bond types should be easily retrievable when a player interacts with a creature.
