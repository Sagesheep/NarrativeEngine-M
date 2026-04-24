import type { LLMProvider } from '../types';
import { getQueueForEndpoint, type LLMCallPriority } from '../services/llmRequestQueue';
import { getApiFormat, getChatUrl, buildChatHeaders, buildChatBody, extractContent } from './llmApiHelper';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export type { LLMCallPriority };

export async function llmCall(
    provider: LLMProvider,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
    }
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const format = getApiFormat(provider);

    const body = buildChatBody(
        provider,
        [{ role: 'user', content: prompt }],
        { stream: false, max_tokens: opts?.maxTokens }
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
                        throw new Error(`LLM API error ${nativeRes.status} (retries exhausted)`);
                    }
                    console.warn(
                        `[LLMQueue] Native ${nativeRes.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
                        `Waiting ${DEFAULT_RETRY_DELAY_MS}ms then retrying...`
                    );
                    await new Promise(resolve => setTimeout(resolve, DEFAULT_RETRY_DELAY_MS));
                    continue;
                }

                if (nativeRes.status < 200 || nativeRes.status >= 300) {
                    throw new Error(`LLM API error ${nativeRes.status}: ${JSON.stringify(nativeRes.data)}`);
                }

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
                throw new Error(`LLM API error ${res.status}: ${errBody}`);
            }
            const data = await res.json();
            return extractContent(data, provider);
        }

        queue.onRateLimitHit();
        queue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`LLM API error ${res.status} (retries exhausted): ${errBody}`);
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
