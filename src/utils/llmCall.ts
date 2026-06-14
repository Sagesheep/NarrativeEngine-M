import type { LLMProvider, ThinkingEffort } from '../types';
import { getQueueForEndpoint, type LLMCallPriority } from '../services/llm/llmRequestQueue';
import { getApiFormat, getChatUrl, buildChatHeaders, buildChatBody, extractContent } from './llmApiHelper';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { startUtilityCall } from '../services/llm/utilityCallTracker';
import { recordCacheUsage } from '../services/llm/cacheTelemetry';
import type { LLMUsage } from '../types/llmMessages';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export type { LLMCallPriority };

export class UtilityTimeoutError extends Error {
    elapsedMs: number;
    label: string;
    constructor(elapsedMs: number, label: string) {
        super(`Utility call "${label}" exceeded deadline (${elapsedMs}ms)`);
        this.name = 'UtilityTimeoutError';
        this.elapsedMs = elapsedMs;
        this.label = label;
    }
}

export async function llmCall(
    provider: LLMProvider,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
        thinkingEffort?: ThinkingEffort;
        /** If set, registers this call with utilityCallTracker so UI can show countdown + EXTEND. */
        trackingLabel?: string;
        /** Soft deadline in ms. On expiry, rejects with UtilityTimeoutError. Caller should fall back. */
        timeoutMs?: number;
    }
): Promise<string> {
    const inner = runInner(provider, prompt, opts, opts?.trackingLabel ?? 'utility');

    if (!opts?.trackingLabel || !opts?.timeoutMs) {
        return inner;
    }

    const label = opts.trackingLabel;
    const handle = startUtilityCall(label, provider.modelName || provider.endpoint, opts.timeoutMs);
    const startedAt = Date.now();

    try {
        const result = await Promise.race([
            inner.then(v => ({ kind: 'ok' as const, value: v })),
            handle.deadlinePromise.then(() => ({ kind: 'timeout' as const })),
        ]);

        if (result.kind === 'timeout') {
            handle.settleError('timeout');
            throw new UtilityTimeoutError(Date.now() - startedAt, label);
        }

        handle.settleSuccess();
        return result.value;
    } catch (e) {
        // If inner threw before deadline, record it.
        if (!(e instanceof UtilityTimeoutError)) {
            const msg = e instanceof Error ? e.message : String(e);
            handle.settleError('error', msg);
        }
        throw e;
    }
}

async function runInner(
    provider: LLMProvider,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
        thinkingEffort?: ThinkingEffort;
    },
    telemetryLabel = 'utility',
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const format = getApiFormat(provider);
    const resolvedEffort = opts?.thinkingEffort !== undefined ? opts.thinkingEffort : provider.thinkingEffort;

    const body = buildChatBody(
        provider,
        [{ role: 'user', content: prompt }],
        { stream: false, max_tokens: opts?.maxTokens, thinkingEffort: resolvedEffort }
    );

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const priority = opts?.priority ?? 'normal';
    const queue = getQueueForEndpoint(provider.endpoint);
    const isNative = Capacitor.isNativePlatform();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await queue.acquireSlot(priority);

        if (isNative) {
            let nativeUrl = url;
            if (format === 'gemini' && provider.apiKey) {
                const sep = nativeUrl.includes('?') ? '&' : '?';
                nativeUrl = `${nativeUrl}${sep}key=${provider.apiKey}`;
            }

            try {
                const nativeRes = await CapacitorHttp.post({
                    url: nativeUrl,
                    headers,
                    data: body,
                    readTimeout: 600000,
                    connectTimeout: 15000,
                });

                queue.releaseSlot();

                const nativeRetryable = nativeRes.status === 429 || nativeRes.status === 503 || nativeRes.status === 529;
                if (nativeRetryable) {
                    queue.onRateLimitHit();
                    if (attempt === MAX_RETRIES) {
                        throw new Error(`LLM API error ${nativeRes.status} (retries exhausted, max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
                    }
                    console.warn(
                        `[LLMQueue] Native ${nativeRes.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
                        `Waiting ${DEFAULT_RETRY_DELAY_MS}ms then retrying...`
                    );
                    await new Promise(resolve => setTimeout(resolve, DEFAULT_RETRY_DELAY_MS));
                    continue;
                }

                if (nativeRes.status < 200 || nativeRes.status >= 300) {
                    throw new Error(`LLM API error ${nativeRes.status}: ${JSON.stringify(nativeRes.data)} (max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
                }

                recordCacheUsage(telemetryLabel, (nativeRes.data as { usage?: LLMUsage })?.usage);
                return extractContent(nativeRes.data, provider);
            } catch (e) {
                queue.releaseSlot();
                throw e;
            }
        }

        let fetchUrl = url;
        if (format === 'gemini' && provider.apiKey) {
            const sep = fetchUrl.includes('?') ? '&' : '?';
            fetchUrl = `${fetchUrl}${sep}key=${provider.apiKey}`;
        }

        let res: Response;
        try {
            res = await fetch(fetchUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: opts?.signal,
            });
        } catch (e) {
            queue.releaseSlot();
            throw e;
        }

        const retryable = res.status === 429 || res.status === 503 || res.status === 529;
        if (!retryable) {
            queue.releaseSlot();
            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`LLM API error ${res.status}: ${errBody} (max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
            }
            const data = await res.json();
            recordCacheUsage(telemetryLabel, (data as { usage?: LLMUsage })?.usage);
            return extractContent(data, provider);
        }

        queue.onRateLimitHit();
        queue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`LLM API error ${res.status} (retries exhausted): ${errBody} (max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
        }

        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
            ? parseFloat(retryAfter) * 1000
            : DEFAULT_RETRY_DELAY_MS;

        console.warn(
            `[LLMQueue] ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
            `Waiting ${delay}ms then re-queuing for next open slot...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error('[LLMQueue] Unreachable');
}
