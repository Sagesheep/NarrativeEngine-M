import type { ChatMessage, LLMProvider, CharacterProfileState, CharacterTrait, CharacterIdentity, StatBlock, DivergenceCategory, SceneEventType } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import {
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ONLY_FOOTER,
    joinPromptSections,
} from '../infrastructure';

/**
 * Scene-aware structured PC profile parser.
 *
 * Replaces the legacy flat-string parser. Reviews the recent chat history and
 * the current structured profile, then emits an updated CharacterProfileState
 * as JSON. Key differences from the legacy parser:
 *
 * 1. REPLACE, don't append. When a new fact contradicts an existing trait with
 *    the same `subject` + `category`, the LLM must mark the old trait
 *    `superseded: true` and add the new one. This fixes the AVERIN
 *    "14 Halsen Court vs Tellis Court" append-only bug.
 * 2. Bounded. `activeTraits` is capped at 10 entries (excluding superseded).
 *    The LLM is instructed to drop the lowest-importance trait when the cap is
 *    reached, rather than silently growing the list.
 * 3. Scene-tagged. Each trait carries `eventTags` (SceneEventType[]) so the
 *    retrieval layer (`queryTraits`) can filter by the planner's scene
 *    classification at injection time.
 *
 * Fault tolerance: on any parse failure, returns `currentProfile` unchanged
 * (same pattern as plannerStage.ts). No data loss, just no update this turn.
 */
export async function scanCharacterProfile(
    provider: LLMProvider,
    messages: ChatMessage[],
    currentProfile: CharacterProfileState,
): Promise<CharacterProfileState> {
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentProfile;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const currentProfileJson = JSON.stringify({
        identity: currentProfile.identity,
        stats: currentProfile.stats,
        activeTraits: currentProfile.activeTraits.map(t => ({
            ...t,
            // Trim fields the LLM doesn't need to see to keep the prompt tight
            sceneEstablished: undefined,
            source: undefined,
        })),
    }, null, 2);

    const eventTagList: SceneEventType[] = [
        'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
        'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
    ];
    const categoryList: DivergenceCategory[] = [
        'locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc',
    ];

    const prompt = joinPromptSections(
        'You are an AI game engine parser responsible for maintaining the player character\'s structured profile and trait list.',

        `TASK: Review the recent chat history and the current structured profile below. Identify any updates to the character's identity, stats, or narrative traits based on the recent narrative.

INSTRUCTIONS:
1. IDENTITY: Update name/race/class/archetype/level only if explicitly revealed or changed in the chat. Otherwise copy through unchanged.
2. STATS: Update only if the chat explicitly shows a level-up, injury, or stat change. Otherwise copy through.
3. TRAITS — SUPERSESSION (CRITICAL): If a new fact contradicts an existing trait with the same \`subject\` AND the same \`category\`, you MUST:
   - Set the existing trait's \`superseded: true\`
   - Add a new trait with the updated fact
   Do NOT append contradictory facts alongside old ones. Do NOT retain superseded traits as active. This is the most important instruction.
4. TRAITS — BOUND: The \`activeTraits\` array (traits where \`superseded: false\`) must contain AT MOST 10 entries. If adding a new trait would exceed 10, drop the trait with the lowest \`importance\` (set its \`superseded: true\`).
5. TRAITS — TAGGING: Every new or updated trait must include \`eventTags\` chosen from: [${eventTagList.join(', ')}]. Tag broadly — a trait can have multiple tags. Examples:
   - "Lives at Tellis Court" → tags: ["travel", "relationship_shift"]
   - "Wields Frostbite, a enchanted blade" → tags: ["combat", "item_acquired"]
   - "Owes Garrick 200 gold" → tags: ["promise", "betrayal"]
   - "Trusted by the city guard" → tags: ["relationship_shift", "quest_milestone"]
   - "Has a scar over left eye" → tags: ["combat", "discovery"]
6. TRAITS — CATEGORY: Each trait's \`category\` must be one of: [${categoryList.join(', ')}]. Use \`party_facts\` for personal attributes/scars/titles/abilities, \`locations\` for residence/travel, \`promises_debts\` for oaths/debts, \`npc_events\` for NPC relationships, \`world_state\` for broad world changes affecting the PC.
7. TRAITS — IMPORTANCE: Assign 1-10 based on narrative weight. Combat-relevant or plot-critical facts: 7-10. Personal bonds/flavor: 4-6. Minor details: 1-3.
8. OUTPUT: Emit ONLY a JSON object matching the CharacterProfileState shape below. No prose, no markdown fences, no explanations.

OUTPUT SHAPE:
{
  "identity": { "name": "...", "race": "...", "class": "...", "archetype": "bulwark|assassin|caster|skirmisher|brute", "level": 1 },
  "stats": { "VIT": 8, "PWR": 8, "RES": 8, "FOC": 8, "SPD": 8, "WIL": 8 },
  "activeTraits": [
    {
      "id": "any-unique-string",
      "subject": "PC name",
      "category": "party_facts",
      "text": "The narrative fact, one short sentence",
      "importance": 7,
      "eventTags": ["combat", "discovery"],
      "sceneEstablished": "scene-id-or-placeholder",
      "superseded": false,
      "source": "llm"
    }
  ]
}

If nothing changed, return the current profile as-is (with superseded flags preserved).`,

        JSON_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `=== CURRENT CHARACTER PROFILE (JSON) ===\n${currentProfileJson}`,
        `=== RECENT CHAT HISTORY ===\n${turns}`,
    );

    try {
        const result = await llmCall(provider, prompt, { priority: 'low', maxTokens: 4096 });

        let clean = result.replace(/<think[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const braceStart = clean.indexOf('{');
        const braceEnd = clean.lastIndexOf('}');
        if (braceStart === -1 || braceEnd === -1) {
            console.warn('[CharacterProfileParser] No JSON object found in response — returning current profile unchanged');
            return currentProfile;
        }

        const parsed = JSON.parse(clean.substring(braceStart, braceEnd + 1));
        return normalizeParsedProfile(parsed, currentProfile);
    } catch (e) {
        console.warn('[CharacterProfileParser] Parse failed — returning current profile unchanged:', e);
        return currentProfile;
    }
}

/**
 * Normalize a parsed JSON object into a valid CharacterProfileState.
 * Defensive: fills missing fields, generates IDs for new traits, clamps
 * importance, validates category/eventTags against the enums, and enforces
 * the 10-trait cap on non-superseded entries.
 */
function normalizeParsedProfile(
    parsed: unknown,
    fallback: CharacterProfileState,
): CharacterProfileState {
    if (!parsed || typeof parsed !== 'object') return fallback;
    const obj = parsed as Record<string, unknown>;

    const VALID_CATEGORIES: ReadonlySet<DivergenceCategory> = new Set([
        'locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc',
    ]);
    const VALID_TAGS: ReadonlySet<SceneEventType> = new Set([
        'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
        'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
    ]);

    const identityRaw = obj.identity && typeof obj.identity === 'object' ? obj.identity as Record<string, unknown> : {};
    const identity: CharacterIdentity = {
        name: typeof identityRaw.name === 'string' ? identityRaw.name : fallback.identity.name,
        race: typeof identityRaw.race === 'string' ? identityRaw.race : fallback.identity.race,
        class: typeof identityRaw.class === 'string' ? identityRaw.class : fallback.identity.class,
        archetype: typeof identityRaw.archetype === 'string' ? identityRaw.archetype as CharacterIdentity['archetype'] : fallback.identity.archetype,
        level: typeof identityRaw.level === 'number' ? identityRaw.level : fallback.identity.level,
    };

    let stats: StatBlock | undefined;
    if (obj.stats && typeof obj.stats === 'object') {
        const s = obj.stats as Record<string, unknown>;
        stats = {
            VIT: typeof s.VIT === 'number' ? s.VIT : fallback.stats?.VIT ?? 8,
            PWR: typeof s.PWR === 'number' ? s.PWR : fallback.stats?.PWR ?? 8,
            RES: typeof s.RES === 'number' ? s.RES : fallback.stats?.RES ?? 8,
            FOC: typeof s.FOC === 'number' ? s.FOC : fallback.stats?.FOC ?? 8,
            SPD: typeof s.SPD === 'number' ? s.SPD : fallback.stats?.SPD ?? 8,
            WIL: typeof s.WIL === 'number' ? s.WIL : fallback.stats?.WIL ?? 8,
        };
    } else {
        stats = fallback.stats;
    }

    const traitsRaw = Array.isArray(obj.activeTraits) ? obj.activeTraits : [];
    const seenIds = new Set<string>();
    const traits: CharacterTrait[] = traitsRaw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => {
            const category = typeof t.category === 'string' && VALID_CATEGORIES.has(t.category as DivergenceCategory)
                ? t.category as DivergenceCategory
                : 'misc';
            const tags = Array.isArray(t.eventTags)
                ? t.eventTags.filter((tag): tag is SceneEventType => typeof tag === 'string' && VALID_TAGS.has(tag as SceneEventType))
                : [];
            const id = typeof t.id === 'string' && !seenIds.has(t.id) ? t.id : uid();
            seenIds.add(id);
            const importance = typeof t.importance === 'number' ? Math.max(1, Math.min(10, Math.round(t.importance))) : 5;
            return {
                id,
                subject: typeof t.subject === 'string' ? t.subject : (identity.name || 'PC'),
                category,
                text: typeof t.text === 'string' ? t.text : '',
                importance,
                eventTags: tags,
                sceneEstablished: typeof t.sceneEstablished === 'string' ? t.sceneEstablished : '',
                superseded: t.superseded === true,
                source: (t.source === 'manual' || t.source === 'seed') ? t.source : 'llm',
            } as CharacterTrait;
        })
        .filter(t => t.text.length > 0);

    // Enforce the 10-trait cap on non-superseded entries.
    const active = traits.filter(t => !t.superseded);
    const superseded = traits.filter(t => t.superseded);
    if (active.length > 10) {
        active.sort((a, b) => b.importance - a.importance);
        const overflow = active.slice(10);
        for (const t of overflow) t.superseded = true;
    }

    const finalTraits = [...active, ...superseded];

    // Preserve legacyNotes from fallback if not present in parsed output.
    const legacyNotes = fallback.legacyNotes;

    return {
        identity,
        stats,
        activeTraits: finalTraits,
        legacyNotes,
    };
}