export const DEFAULT_STORY_TIMEOUT_SECONDS = 120;
export const DEFAULT_UTILITY_TIMEOUT_SECONDS = 45;
export const MIN_AI_TIMEOUT_SECONDS = 10;
export const MAX_AI_TIMEOUT_SECONDS = 3600;

export function normalizeTimeoutSeconds(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(MIN_AI_TIMEOUT_SECONDS, Math.min(MAX_AI_TIMEOUT_SECONDS, Math.round(value)));
}
