import type { LLMProvider, ThinkingEffort } from '../types';
import { getQueueForEndpoint, type LLMCallPriority } from '../services/llm/llmRequestQueue';
import { getApiFormat, getChatUrl, buildChatHeaders, buildChatBody, extractContent, thinkingControlFor } from './llmApiHelper';
import { isThinkingControlRejection, markThinkingControlRefused } from './thinkingControl';
import { ensureModelCatalog, ensureOpenRouterServiceTiers } from '../services/llm/modelCatalog';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { startUtilityCall } from '../services/llm/utilityCallTracker';
import { recordCacheUsage } from '../services/llm/cacheTelemetry';
import { noKeepAlive } from './nativeHttp';
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
        /** Soft deadline in ms. On expiry, aborts the request and rejects with UtilityTimeoutError. Caller should fall back. */
        timeoutMs?: number;
    }
): Promise<string> {
    if (!opts?.trackingLabel || !opts?.timeoutMs) {
        return runInner(provider, prompt, opts, opts?.trackingLabel ?? 'utility');
    }

    // Own controller so a timeout cancels the request instead of leaving it
    // running (and billed) after the caller has moved on. The caller's signal
    // still cancels it too.
    const controller = new AbortController();
    const callerSignal = opts.signal;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) controller.abort(callerSignal.reason);
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    const inner = runInner(provider, prompt, { ...opts, signal: controller.signal }, opts.trackingLabel);
    // After a timeout the aborted request rejects with nobody awaiting it.
    inner.catch(() => {});

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
            controller.abort();
            throw new UtilityTimeoutError(Date.now() - startedAt, label);
        }

        handle.settleSuccess();
        return result.value;
    } catch (e) {
        // If inner threw before deadline, record it.
        if (!(e instanceof UtilityTimeoutError)) {
            const msg = e instanceof Error ? e.message : String(e);
            handle.settleError(controller.signal.aborted ? 'aborted' : 'error', msg);
        }
        throw e;
    } finally {
        callerSignal?.removeEventListener('abort', onCallerAbort);
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
        timeoutMs?: number;
    },
    telemetryLabel = 'utility',
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const format = getApiFormat(provider);
    const resolvedEffort = opts?.thinkingEffort !== undefined ? opts.thinkingEffort : provider.thinkingEffort;

    await ensureModelCatalog(provider.endpoint);
    if (provider.serviceTier) await ensureOpenRouterServiceTiers(provider.endpoint, provider.modelName);
    const makeBody = () => {
        const b = buildChatBody(
            provider,
            [{ role: 'user', content: prompt }],
            { stream: false, max_tokens: opts?.maxTokens, thinkingEffort: resolvedEffort }
        );
        if (opts?.temperature !== undefined) b.temperature = opts.temperature;
        return b;
    };
    let body = makeBody();

    // A host that refuses the thinking fields gets the request once more without
    // them; thinkingControl remembers the refusal for the rest of the session.
    let thinkingRetried = false;
    const retryWithoutThinking = (status: number, errText: string): boolean => {
        if (thinkingRetried || !isThinkingControlRejection(status, errText, thinkingControlFor(provider, resolvedEffort))) return false;
        thinkingRetried = true;
        markThinkingControlRefused(provider);
        console.warn(`[llmCall] ${provider.modelName} refused the thinking setting (${status}); retrying without it`);
        body = makeBody();
        return true;
    };

    const priority = opts?.priority ?? 'normal';
    const queue = getQueueForEndpoint(provider.endpoint);
    const isNative = Capacitor.isNativePlatform();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await queue.acquireSlot(priority);
        // Cancelled while queued or backing off: don't send it. A native request
        // can't be aborted once sent, so this is the only cancel point there.
        if (opts?.signal?.aborted) {
            queue.releaseSlot();
            throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
        }

        if (isNative) {
            let nativeUrl = url;
            if (format === 'gemini' && provider.apiKey) {
                const sep = nativeUrl.includes('?') ? '&' : '?';
                nativeUrl = `${nativeUrl}${sep}key=${provider.apiKey}`;
            }

            try {
                const nativeRes = await CapacitorHttp.post({
                    url: nativeUrl,
                    headers: noKeepAlive(headers),
                    data: body,
                    readTimeout: Math.max(600000, opts?.timeoutMs ?? 0),
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
                    if (retryWithoutThinking(nativeRes.status, JSON.stringify(nativeRes.data))) {
                        attempt--;
                        continue;
                    }
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
                if (retryWithoutThinking(res.status, errBody)) {
                    attempt--;
                    continue;
                }
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
