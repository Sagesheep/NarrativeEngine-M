import type { LLMProvider } from '../types';
import { llmQueue, type LLMCallPriority } from '../services/llmRequestQueue';
import { getChatUrl, buildChatHeaders, buildChatBody, extractContent } from './llmApiHelper';

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

    const body = buildChatBody(
        provider,
        [{ role: 'user', content: prompt }],
        { stream: false, max_tokens: opts?.maxTokens }
    );

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const priority = opts?.priority ?? 'normal';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await llmQueue.acquireSlot(priority);

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: opts?.signal,
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
