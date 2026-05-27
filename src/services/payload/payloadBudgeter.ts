export interface BudgetMap {
    stable: number;
    summary: number;
    world: number;
    rules: number;
    volatile: number;
}

export function computeBudgets(limit: number, hasDeepContext: boolean, rulesBudgetPct: number): BudgetMap {
    const rules = Math.max(50, Math.floor(limit * (rulesBudgetPct || 0)));
    const adjusted = limit - rules;
    return {
        stable:   Math.floor(adjusted * (hasDeepContext ? 0.15 : 0.25)),
        summary:  Math.floor(adjusted * 0.10),
        world:    Math.floor(adjusted * (hasDeepContext ? 0.60 : 0.40)),
        rules,
        volatile: Math.floor(adjusted * (hasDeepContext ? 0.07 : 0.10)),
    };
}