/**
 * semanticMemory.ts
 *
 * Semantic Memory Layer — queries the server-side fact store and returns
 * matching facts for injection into the LLM payload.
 *
 * Facts are extracted server-side during archive append (Phase 2).
 * This service queries them by entity matching against current context.
 */

import type { SemanticFact, NPCEntry, CharacterTrait, CharacterProfileState, SceneEventType } from '../../types';
import { CORE_FLOOR_TRAITS } from '../../types';
import { countTokens } from '../infrastructure';
import { offlineStorage } from '../storage';
import { PROPER_NOUN_STOP_WORDS } from '../../utils/stopWords';

export async function fetchFacts(campaignId: string): Promise<SemanticFact[]> {
    try {
        return await offlineStorage.facts.get(campaignId);
    } catch (err) {
        console.warn('[SemanticMemory] Failed to fetch facts:', err);
    }
    return [];
}

export function extractContextEntities(
    userMessage: string,
    recentMessages: { content: string; role: string }[],
    npcLedger?: NPCEntry[]
): Set<string> {
    const entities = new Set<string>();

    if (npcLedger) {
        for (const npc of npcLedger) {
            entities.add(npc.name.toLowerCase());
            if (npc.aliases) {
                for (const alias of npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)) {
                    entities.add(alias);
                }
            }
        }
    }

    const allText = [userMessage, ...recentMessages.slice(-5).map(m => m.content || '')].join(' ');
    const properNouns = allText.match(/[A-Z][A-Za-z]{2,}(?:\s[A-Z][A-Za-z]{2,})*/g) || [];
    for (const noun of properNouns) {
        if (!PROPER_NOUN_STOP_WORDS.has(noun)) entities.add(noun.toLowerCase());
    }

    return entities;
}

export function queryFacts(
    facts: SemanticFact[],
    userMessage: string,
    recentMessages: { content: string; role: string }[],
    npcLedger?: NPCEntry[],
    tokenBudget = 500
): SemanticFact[] {
    if (!facts || facts.length === 0) return [];

    const entities = extractContextEntities(userMessage, recentMessages, npcLedger);

    const scored = facts.map(fact => {
        let score = 0;
        const sLower = fact.subject.toLowerCase();
        const oLower = fact.object.toLowerCase();
        if (entities.has(sLower)) score += fact.importance;
        if (entities.has(oLower)) score += fact.importance * 0.8;
        for (const entity of entities) {
            if (sLower.includes(entity) || entity.includes(sLower)) score += 2;
            if (oLower.includes(entity) || entity.includes(oLower)) score += 1.5;
        }
        return { fact, score };
    });

    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    const selected: SemanticFact[] = [];
    let usedTokens = 0;

    for (const { fact } of matched) {
        const factText = `${fact.subject} --${fact.predicate}-> ${fact.object} [importance:${fact.importance}]`;
        const tokens = countTokens(factText);
        if (usedTokens + tokens > tokenBudget) break;
        selected.push(fact);
        usedTokens += tokens;
    }

    if (selected.length > 0) {
        console.log(`[SemanticMemory] Matched ${selected.length}/${facts.length} facts (~${usedTokens} tokens)`);
    }
    return selected;
}

export function formatFactsForContext(facts: SemanticFact[]): string {
    if (facts.length === 0) return '';
    const lines = facts
        .sort((a, b) => b.importance - a.importance)
        .map(f => `▸ ${f.subject} —${f.predicate}→ ${f.object} [${f.importance}]`);
    return `[SEMANTIC MEMORY - ${facts.length} verified facts]\n${lines.join('\n')}\n[END SEMANTIC MEMORY]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PC Trait Retrieval
// ─────────────────────────────────────────────────────────────────────────────
//
// Sibling of queryFacts. Scores PC traits by entity match × importance (reusing
// extractContextEntities for the entity-matching core), then filters the
// extended tier by scene tags (planner eventTypes), and caps at a token budget.
//
// Core floor (CORE_FLOOR_TRAITS = 5): the top N highest-importance non-superseded
// traits are ALWAYS injected regardless of entity match or scene tags. This is
// the "GM is never starved" guarantee — the GM always knows who the PC is and
// their most important current state.
//
// Extended tier: remaining non-superseded traits are scored by entity match ×
// importance, then filtered by eventTags ∩ plannerEventTypes. Traits with no
// tags, or when plannerEventTypes is empty, bypass the tag filter (fault
// tolerance — missing planner output degrades to "inject best by score,"
// not "inject nothing").

export type SelectedTraits = {
    core: CharacterTrait[];      // always injected (core floor)
    extended: CharacterTrait[];  // scene-relevant, budget-capped
};

export function queryTraits(
    traits: CharacterTrait[],
    userMessage: string,
    recentMessages: { content: string; role: string }[],
    npcLedger?: NPCEntry[],
    plannerEventTypes?: SceneEventType[],
    tokenBudget = 400,
    coreFloor: number = CORE_FLOOR_TRAITS,
): SelectedTraits {
    if (!traits || traits.length === 0) return { core: [], extended: [] };

    const active = traits.filter(t => !t.superseded);
    if (active.length === 0) return { core: [], extended: [] };

    // Core floor: top N by importance, regardless of entity match or tags.
    const sortedByImportance = [...active].sort((a, b) => b.importance - a.importance);
    const core = sortedByImportance.slice(0, coreFloor);
    const coreIds = new Set(core.map(t => t.id));

    // Extended candidates: everything not in core.
    const extendedCandidates = active.filter(t => !coreIds.has(t.id));
    if (extendedCandidates.length === 0) return { core, extended: [] };

    const entities = extractContextEntities(userMessage, recentMessages, npcLedger);
    const plannerTags = plannerEventTypes && plannerEventTypes.length > 0
        ? new Set(plannerEventTypes)
        : null;

    const scored = extendedCandidates.map(trait => {
        let score = 0;
        const tLower = trait.text.toLowerCase();
        const sLower = trait.subject.toLowerCase();

        // Entity match scoring (same logic as queryFacts, applied to trait.text
        // since PC traits are attributes, not subject/object triples).
        if (entities.has(sLower)) score += trait.importance;
        for (const entity of entities) {
            if (tLower.includes(entity)) score += 2;
            if (sLower.includes(entity) || entity.includes(sLower)) score += 1.5;
        }

        // Scene-tag filter: if the planner emitted event types, drop traits
        // whose tags don't intersect. Untagged traits (eventTags = []) bypass
        // the filter — they're treated as "always relevant" (fault tolerance).
        if (plannerTags && trait.eventTags.length > 0) {
            const hasIntersection = trait.eventTags.some(tag => plannerTags.has(tag));
            if (!hasIntersection) {
                // Trait's tags don't match the scene. Demote to score 0 so it
                // only injects if there's budget left after scored traits.
                score = 0;
            }
        }

        // Importance baseline: even with no entity match, high-importance traits
        // get a small score so they can fill the budget if nothing else matches.
        if (score === 0 && trait.importance >= 7) {
            score = trait.importance * 0.1;
        }

        return { trait, score };
    });

    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    const extended: CharacterTrait[] = [];
    let usedTokens = 0;

    // Core tokens count against the budget too — keep the total bounded.
    for (const t of core) {
        usedTokens += countTokens(formatTraitLine(t));
    }

    for (const { trait } of matched) {
        const line = formatTraitLine(trait);
        const tokens = countTokens(line);
        if (usedTokens + tokens > tokenBudget) break;
        extended.push(trait);
        usedTokens += tokens;
    }

    if (extended.length > 0) {
        console.log(`[TraitMemory] Core ${core.length} + extended ${extended.length}/${extendedCandidates.length} (~${usedTokens} tokens)`);
    }

    return { core, extended };
}

function formatTraitLine(trait: CharacterTrait): string {
    return `▸ [${trait.category}] ${trait.text} [imp:${trait.importance}${trait.eventTags.length > 0 ? ` tags:${trait.eventTags.join(',')}` : ''}]`;
}

export function formatTraitsForContext(
    profile: CharacterProfileState,
    selected: SelectedTraits,
): string {
    const parts: string[] = ['[CHARACTER PROFILE]'];

    // Identity (Tier 1 core — always present)
    const id = profile.identity;
    const idParts: string[] = [];
    if (id.name) idParts.push(id.name);
    if (id.race) idParts.push(id.race);
    if (id.class) idParts.push(id.class);
    if (id.archetype) idParts.push(id.archetype);
    if (id.level !== undefined) idParts.push(`Level ${id.level}`);
    if (idParts.length > 0) parts.push(idParts.join(' | '));

    // Stats (if present — structured, not a flat string)
    if (profile.stats) {
        const s = profile.stats;
        parts.push(`VIT ${s.VIT} | PWR ${s.PWR} | RES ${s.RES} | FOC ${s.FOC} | SPD ${s.SPD} | WIL ${s.WIL}`);
    }

    // Core traits (always injected — the "GM is never starved" floor)
    if (selected.core.length > 0) {
        parts.push('Core:');
        for (const t of selected.core) parts.push(formatTraitLine(t));
    }

    // Extended traits (scene-relevant — budget-capped)
    if (selected.extended.length > 0) {
        parts.push('Scene-relevant:');
        for (const t of selected.extended) parts.push(formatTraitLine(t));
    }

    parts.push('[END CHARACTER PROFILE]');
    return parts.join('\n');
}
