export interface BudgetMap {
    stable: number;
    summary: number;
    world: number;
    rules: number;
    volatile: number;
    /**
     * NPC floor — a guaranteed slice for the [ACTIVE NPC CONTEXT] block, decoupled
     * from the world budget so lore/archive pressure can never starve the scene's
     * actors. Unused remainder flows back to `world` in payloadBuilder's two-phase
     * trim. Fixed 5% — on small contexts (8K) that's ~400 tokens (1-2 NPCs, the
     * silly-tavern RP case); on large contexts (200K) it's ~10K (plenty).
     */
    npc: number;
}

/**
 * NOTE: only `world` (trimWorldBlocks), `npc` (two-phase NPC trim) and `rules`
 * (RAG threshold in buildStablePreamble) are *enforced*. `stable`, `summary` and
 * `volatile` are advisory — kept for trace/observability and proportioning, not
 * hard caps. Overflow of the advisory sections is surfaced by buildPayload's
 * warn (AUDIT F9).
 */
export function computeBudgets(limit: number, hasDeepContext: boolean, rulesBudgetPct: number): BudgetMap {
    const rules = Math.max(50, Math.floor(limit * (rulesBudgetPct || 0)));
    const adjusted = limit - rules;
    const npc = Math.floor(adjusted * 0.05);
    const worldAdjusted = adjusted - npc;
    return {
        stable:   Math.floor(worldAdjusted * (hasDeepContext ? 0.15 : 0.25)),
        summary:  Math.floor(worldAdjusted * 0.10),
        world:    Math.floor(worldAdjusted * (hasDeepContext ? 0.60 : 0.40)),
        rules,
        volatile: Math.floor(worldAdjusted * (hasDeepContext ? 0.07 : 0.10)),
        npc,
    };
}