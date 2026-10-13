import type { ApiFormat, LLMProvider, ThinkingEffort } from '../types';

/**
 * How to switch a model's thinking off (or set its level) on each host.
 *
 * Leaving the thinking fields out of a request is not "off": DeepSeek V4, GLM,
 * Kimi, Qwen and most 2026 reasoning models think by default. Every host spells
 * the switch differently, so it is chosen per method:
 *
 * - DeepSeek's own API, Z.ai (GLM), Moonshot (Kimi): `thinking: {type}`.
 * - Qwen on DashScope: `enable_thinking`.
 * - OpenAI, xAI, Google's OpenAI-compatible endpoint: `reasoning_effort`.
 * - NanoGPT: `reasoning_effort`, using its model list. A `:thinking` model id
 *   switches to its plain id when that is how the model turns thinking off.
 * - OpenRouter: `reasoning.effort`, using its model list.
 * - Ollama: `think`. Gemini: `thinkingBudget` (2.5) or `thinkingLevel` (3+).
 * - Anything else (llama.cpp, vLLM, KoboldCpp, Chutes, NIM...):
 *   `chat_template_kwargs`, which Qwen, GLM, DeepSeek and Kimi chat templates read.
 *
 * Claude is not handled here: it thinks only when asked (llmApiHelper).
 * A host that refuses the fields gets the request again without them
 * (isThinkingControlRejection), and they are not sent to that model again
 * this session.
 */

/** A host's published thinking options for one model (services/llm/modelCatalog). */
export interface CatalogModel {
    /** The model can think at all. */
    reasoning: boolean;
    /** Effort levels the host accepts; 'none' means thinking can be turned off. */
    efforts?: string[];
    /** OpenRouter: thinking cannot be turned off. */
    mandatory?: boolean;
    /** OpenRouter: whether the model thinks when the request does not ask. */
    defaultOn?: boolean;
}

export type CatalogLookup = (modelId: string) => CatalogModel | undefined;

export type ThinkingHost =
    | 'deepseek' | 'nanogpt' | 'openrouter' | 'zai' | 'moonshot' | 'dashscope'
    | 'openaiStyle' | 'generic';

export interface ThinkingControl {
    /** Fields merged into the request body (into generationConfig for Gemini). */
    fields: Record<string, unknown>;
    /** Model id to send instead of the configured one (NanoGPT `:thinking` → plain id). */
    model?: string;
    /** Effort the request may still think at, for the max_tokens reserve. */
    reserveEffort: ThinkingEffort | undefined;
}

export function thinkingHostOf(endpoint: string): ThinkingHost {
    let host: string;
    try {
        host = new URL(endpoint.trim()).hostname.toLowerCase();
    } catch {
        return 'generic';
    }
    const is = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (is('deepseek.com')) return 'deepseek';
    if (is('nano-gpt.com')) return 'nanogpt';
    if (is('openrouter.ai')) return 'openrouter';
    if (is('z.ai') || is('bigmodel.cn')) return 'zai';
    if (is('moonshot.ai') || is('moonshot.cn') || is('kimi.ai') || is('kimi.com')) return 'moonshot';
    if (host.startsWith('dashscope')) return 'dashscope';
    if (is('openai.com') || is('x.ai') || host === 'generativelanguage.googleapis.com') return 'openaiStyle';
    return 'generic';
}

const OPENAI_EFFORT_MAP: Record<Exclude<ThinkingEffort, 'off'>, string> = {
    low: 'low', medium: 'medium', high: 'high', max: 'xhigh',
};

// DeepSeek's own API takes high or max; lower levels run as high.
const DEEPSEEK_EFFORT_MAP: Record<Exclude<ThinkingEffort, 'off'>, string> = {
    low: 'high', medium: 'high', high: 'high', max: 'max',
};

const GEMINI_LEVEL_MAP: Record<Exclude<ThinkingEffort, 'off'>, string> = {
    low: 'LOW', medium: 'MEDIUM', high: 'HIGH', max: 'HIGH',
};

// Gemini 2.5 takes a token budget, not a level.
const GEMINI_BUDGET_MAP: Record<Exclude<ThinkingEffort, 'off'>, number> = {
    low: 1024, medium: 4096, high: 8192, max: 24576,
};

// Effort names used by NanoGPT and OpenRouter, lowest first.
const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function levelRank(level: string): number {
    const i = LEVELS.indexOf(level);
    return i === -1 ? LEVELS.indexOf('medium') : i;
}

/** The supported level closest to the one asked for; ties go to the higher one. */
function nearestLevel(wanted: string, supported: string[]): string {
    const choices = supported.filter(l => l !== 'none');
    if (choices.length === 0) return wanted;
    const target = levelRank(wanted);
    return choices.reduce((best, l) => {
        const d = Math.abs(levelRank(l) - target);
        const bestD = Math.abs(levelRank(best) - target);
        return d < bestD || (d === bestD && levelRank(l) > levelRank(best)) ? l : best;
    });
}

function lowestLevel(supported: string[]): string {
    return supported.reduce((a, b) => (levelRank(b) < levelRank(a) ? b : a));
}

/** The app effort a host level thinks at, for the token reserve. */
function effortOfLevel(level: string): ThinkingEffort | undefined {
    const rank = levelRank(level);
    if (rank <= levelRank('none')) return undefined;
    if (rank <= levelRank('low')) return 'low';
    if (rank <= levelRank('medium')) return 'medium';
    if (rank <= levelRank('high')) return 'high';
    return 'max';
}

const NOTHING: ThinkingControl = { fields: {}, reserveEffort: undefined };

// ── Models whose host refused the thinking fields (this session only) ──────
const refused = new Set<string>();

function refusalKey(provider: Pick<LLMProvider, 'endpoint' | 'modelName'>): string {
    return `${provider.endpoint.trim().replace(/\/+$/, '').toLowerCase()}|${(provider.modelName ?? '').trim().toLowerCase()}`;
}

export function markThinkingControlRefused(provider: Pick<LLMProvider, 'endpoint' | 'modelName'>): void {
    refused.add(refusalKey(provider));
}

export function isThinkingControlRefused(provider: Pick<LLMProvider, 'endpoint' | 'modelName'>): boolean {
    return refused.has(refusalKey(provider));
}

export function __resetThinkingRefusalsForTests(): void {
    refused.clear();
}

export function hasThinkingControl(control: ThinkingControl): boolean {
    return Object.keys(control.fields).length > 0 || Boolean(control.model);
}

/**
 * Whether a failed request should be sent again without the thinking fields:
 * a 400/404/422 whose message names reasoning or thinking, or any of those
 * after the model id was switched.
 */
export function isThinkingControlRejection(status: number, errorBody: string, control: ThinkingControl): boolean {
    if (!hasThinkingControl(control)) return false;
    if (status !== 400 && status !== 404 && status !== 422) return false;
    return Boolean(control.model) || /reason|think|effort|chat_template/i.test(errorBody);
}

// ── Per-host resolution ─────────────────────────────────────────────────────

function nanoGptOff(model: string, lookup: CatalogLookup): ThinkingControl {
    const entry = lookup(model);
    if (entry && !entry.reasoning) return NOTHING;
    if (entry?.efforts?.includes('none')) return { fields: { reasoning_effort: 'none' }, reserveEffort: undefined };
    // NanoGPT lists many thinking models as a `:thinking` id beside a plain one;
    // the plain id is how they run without thinking.
    const plain = model.replace(/:thinking$/i, '');
    if (plain !== model && lookup(plain)) {
        return { ...nanoGptOff(plain, lookup), model: plain };
    }
    if (entry?.efforts?.length) {
        const level = lowestLevel(entry.efforts);
        return { fields: { reasoning_effort: level }, reserveEffort: effortOfLevel(level) };
    }
    // Not in the list (or no list): ask for none; a refusal drops it.
    return { fields: { reasoning_effort: 'none' }, reserveEffort: undefined };
}

function openRouterOff(model: string, lookup: CatalogLookup): ThinkingControl {
    const entry = lookup(model);
    if (entry && !entry.reasoning) return NOTHING;
    if (entry?.mandatory) {
        if (!entry.efforts?.length) return { fields: {}, reserveEffort: 'medium' };
        const level = lowestLevel(entry.efforts);
        return { fields: { reasoning: { effort: level } }, reserveEffort: effortOfLevel(level) };
    }
    if (entry?.defaultOn === false) return NOTHING;
    return { fields: { reasoning: { effort: 'none' } }, reserveEffort: undefined };
}

function geminiControl(modelName: string, effort: ThinkingEffort): ThinkingControl {
    const model = modelName.toLowerCase();
    const version = /gemini-(\d+)(?:\.(\d+))?/.exec(model);
    const major = version ? Number(version[1]) : 0;
    const minor = version?.[2] ? Number(version[2]) : 0;
    const isPro = /-pro\b/.test(model);

    if (major === 2 && minor === 5) {
        if (effort === 'off') {
            // 2.5 Pro cannot turn thinking off.
            return isPro
                ? { fields: {}, reserveEffort: 'medium' }
                : { fields: { thinkingConfig: { thinkingBudget: 0 } }, reserveEffort: undefined };
        }
        return { fields: { thinkingConfig: { thinkingBudget: GEMINI_BUDGET_MAP[effort] } }, reserveEffort: effort };
    }
    if (major >= 3) {
        if (effort === 'off') {
            // Gemini 3+ cannot turn thinking off; Flash goes down to minimal, Pro to low.
            return { fields: { thinkingConfig: { thinkingLevel: isPro ? 'LOW' : 'MINIMAL' } }, reserveEffort: 'low' };
        }
        return { fields: { thinkingConfig: { thinkingLevel: GEMINI_LEVEL_MAP[effort] } }, reserveEffort: effort };
    }
    // Gemma and older models: nothing to switch off.
    if (effort === 'off') return NOTHING;
    return { fields: { thinkingConfig: { thinkingLevel: GEMINI_LEVEL_MAP[effort] } }, reserveEffort: effort };
}

/**
 * The thinking fields for one request. `effort` undefined is "Model default":
 * nothing is sent. Not for the Claude format.
 */
export function resolveThinkingControl(
    provider: Pick<LLMProvider, 'endpoint' | 'modelName'>,
    format: ApiFormat,
    effort: ThinkingEffort | undefined,
    lookup: CatalogLookup = () => undefined,
): ThinkingControl {
    if (effort === undefined || format === 'claude') return NOTHING;

    const host = thinkingHostOf(provider.endpoint);
    if (isThinkingControlRefused(provider)) {
        // Sent without the fields, the model may think at its own default.
        if (effort !== 'off') return { fields: {}, reserveEffort: effort };
        return { fields: {}, reserveEffort: format === 'ollama' || host === 'generic' ? undefined : 'medium' };
    }

    if (format === 'ollama') return { fields: { think: effort !== 'off' }, reserveEffort: effort === 'off' ? undefined : effort };
    if (format === 'gemini') return geminiControl(provider.modelName ?? '', effort);

    const model = provider.modelName ?? '';
    const off = effort === 'off';
    switch (host) {
        case 'deepseek':
            return off
                ? { fields: { thinking: { type: 'disabled' } }, reserveEffort: undefined }
                : { fields: { thinking: { type: 'enabled' }, reasoning_effort: DEEPSEEK_EFFORT_MAP[effort] }, reserveEffort: effort };
        case 'zai':
        case 'moonshot':
            return { fields: { thinking: { type: off ? 'disabled' : 'enabled' } }, reserveEffort: off ? undefined : effort };
        case 'dashscope':
            return { fields: { enable_thinking: !off }, reserveEffort: off ? undefined : effort };
        case 'openaiStyle':
            return off
                ? { fields: { reasoning_effort: 'none' }, reserveEffort: undefined }
                : { fields: { reasoning_effort: OPENAI_EFFORT_MAP[effort] }, reserveEffort: effort };
        case 'nanogpt': {
            if (off) return nanoGptOff(model, lookup);
            const efforts = lookup(model)?.efforts;
            const level = efforts?.length ? nearestLevel(effort, efforts) : effort;
            return { fields: { reasoning_effort: level }, reserveEffort: effort };
        }
        case 'openrouter': {
            if (off) return openRouterOff(model, lookup);
            const efforts = lookup(model)?.efforts;
            const level = efforts?.length ? nearestLevel(effort, efforts) : effort;
            return { fields: { reasoning: { effort: level } }, reserveEffort: effort };
        }
        default:
            return off
                ? { fields: { chat_template_kwargs: { enable_thinking: false, thinking: false } }, reserveEffort: undefined }
                : { fields: { reasoning_effort: OPENAI_EFFORT_MAP[effort] }, reserveEffort: effort };
    }
}
