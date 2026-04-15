import type { ProviderConfig, EndpointConfig } from '../types';
import { llmQueue, type LLMCallPriority } from './llmRequestQueue';
import { getChatUrl, buildChatHeaders, buildChatBody, extractContent } from '../utils/llmApiHelper';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export type { LLMCallPriority };

export async function callLLM(
    provider: ProviderConfig | EndpointConfig,
    prompt: string,
    options?: {
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
        priority?: LLMCallPriority;
    }
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);

    const body = buildChatBody(provider, [{ role: 'user', content: prompt }], {
        stream: false,
        max_tokens: options?.maxTokens,
    });

    if (options?.temperature !== undefined) body.temperature = options.temperature;

    const priority = options?.priority ?? 'normal';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await llmQueue.acquireSlot(priority);

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: options?.signal,
            });
        } catch (e) {
            llmQueue.releaseSlot();
            throw e;
        }

        if (res.status !== 429) {
            llmQueue.releaseSlot();
            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`LLM API error ${res.status}: ${errBody}`);
            }
            const data = await res.json();
            return extractContent(data, provider);
        }

        llmQueue.onRateLimitHit();
        llmQueue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`LLM API error 429 (retries exhausted): ${errBody}`);
        }

        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
            ? parseFloat(retryAfter) * 1000
            : DEFAULT_RETRY_DELAY_MS;

        console.warn(
            `[LLMQueue] 429 (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
            `Waiting ${delay}ms then re-queuing for next open slot...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error('[LLMQueue] Unreachable');
}
