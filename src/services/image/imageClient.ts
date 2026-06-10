import type { LLMProvider } from '../../types';
import { getApiFormat, getBaseUrl, buildChatHeaders } from '../../utils/llmApiHelper';
import { getQueueForEndpoint, type LLMCallPriority } from '../llm/llmRequestQueue';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

export type GenerateImageOpts = {
    size?: '256x256' | '512x512' | '1024x1024' | '1024x1536';
    priority?: LLMCallPriority;
    negativePrompt?: string;
    seed?: number;
};

export async function generateImage(
    provider: LLMProvider,
    prompt: string,
    opts?: GenerateImageOpts,
): Promise<string> {
    const format = getApiFormat(provider);

    if (format === 'claude' || format === 'ollama') {
        throw new Error(`Image generation is not supported for ${format} API format. Use an OpenAI-compatible image endpoint.`);
    }

    if (format === 'gemini') {
        throw new Error('Gemini image generation is not yet supported. Use an OpenAI-compatible image endpoint.');
    }

    try {
        return await generateOpenAI(provider, prompt, opts, true);
    } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (msg.includes('400') && /response_format/i.test(msg)) {
            return generateOpenAI(provider, prompt, opts, false);
        }
        throw e;
    }
}

async function generateOpenAI(
    provider: LLMProvider,
    prompt: string,
    opts?: GenerateImageOpts,
    includeResponseFormat = true,
): Promise<string> {
    const base = getBaseUrl(provider);
    const url = `${base}/images/generations`;
    const headers = buildChatHeaders(provider);

    const size = opts?.size ?? '1024x1024';
    const body: Record<string, unknown> = {
        model: provider.modelName,
        prompt,
        n: 1,
        size,
    };
    if (includeResponseFormat) {
        body.response_format = 'b64_json';
    }
    if (opts?.negativePrompt) {
        body.negative_prompt = opts.negativePrompt;
    }
    if (opts?.seed !== undefined) {
        body.seed = opts.seed;
    }

    const priority = opts?.priority ?? 'low';
    const queue = getQueueForEndpoint(provider.endpoint);
    const isNative = Capacitor.isNativePlatform();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await queue.acquireSlot(priority);

        if (isNative) {
            // Release the slot exactly once per acquired slot. The request itself
            // is the only thing that can fail before release; the post-release
            // status checks must NOT trigger a second releaseSlot() (that would
            // under-count inflight and corrupt this — potentially shared — queue).
            let nativeRes;
            try {
                nativeRes = await CapacitorHttp.post({
                    url,
                    headers,
                    data: body,
                    readTimeout: 120000,
                    connectTimeout: 15000,
                });
            } catch (e) {
                queue.releaseSlot();
                throw e;
            }

            queue.releaseSlot();

            const nativeRetryable = nativeRes.status === 429 || nativeRes.status === 503 || nativeRes.status === 529;
            if (nativeRetryable) {
                queue.onRateLimitHit();
                if (attempt === MAX_RETRIES) {
                    throw new Error(`Image API error ${nativeRes.status} (retries exhausted)`);
                }
                await new Promise(resolve => setTimeout(resolve, DEFAULT_RETRY_DELAY_MS));
                continue;
            }

            if (nativeRes.status < 200 || nativeRes.status >= 300) {
                throw new Error(`Image API error ${nativeRes.status}: ${JSON.stringify(nativeRes.data)}`);
            }

            return extractOpenAIImage(nativeRes.data, includeResponseFormat);
        }

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
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
                throw new Error(`Image API error ${res.status}: ${errBody}`);
            }
            const data = await res.json();
            return extractOpenAIImage(data, includeResponseFormat);
        }

        queue.onRateLimitHit();
        queue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`Image API error ${res.status} (retries exhausted): ${errBody}`);
        }

        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
            ? parseFloat(retryAfter) * 1000
            : DEFAULT_RETRY_DELAY_MS;

        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error('[ImageClient] Unreachable');
}

function extractOpenAIImage(data: unknown, expectB64: boolean): string {
    const resp = data as { data?: Array<{ b64_json?: string; url?: string }> };
    const entry = resp?.data?.[0];
    if (!entry) {
        throw new Error('Image API returned no image data');
    }
    if (expectB64 && entry.b64_json) {
        return `data:image/png;base64,${entry.b64_json}`;
    }
    if (entry.url) {
        return entry.url;
    }
    if (entry.b64_json) {
        return `data:image/png;base64,${entry.b64_json}`;
    }
    throw new Error('Image API returned no image data');
}