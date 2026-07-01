import type { LLMProvider, SamplingConfig } from '../../types';
import type { LLMChatMessage, OpenAICompletionResponse } from '../../types/llmMessages';
import { uid } from '../../utils/uid';
import { getApiFormat, getChatUrl, getModelsUrl, buildChatHeaders, buildChatBody, extractContent, extractStreamDelta, extractStreamToolCall } from '../../utils/llmApiHelper';
import { isAbortError } from '../../types/llmMessages';
import type { LLMUsage } from '../../types/llmMessages';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { startUtilityCall } from './utilityCallTracker';
import { recordCacheUsage } from './cacheTelemetry';

const STORY_LABEL = 'story-generation';

const STORY_INITIAL_TIMEOUT_MS = 120000;
const STORY_CHUNK_EXTEND_MS = 30000;
const STORY_CHUNK_EXTEND_THRESHOLD_MS = 30000;

export type OpenAIMessage = LLMChatMessage;

/**
 * Native story turn over CapacitorHttp (bypasses WebView CORS). Non-streaming: the
 * full response is buffered, so the story arrives as a single chunk. Used when
 * streaming is disabled AND as the transparent fallback when a native streaming
 * fetch is CORS-blocked (e.g. NVIDIA NIM). Owns its own utilityCallTracker entry.
 */
async function nativeNonStreamStory(
    provider: LLMProvider,
    messages: OpenAIMessage[],
    format: ReturnType<typeof getApiFormat>,
    headers: Record<string, string>,
    tools: unknown[] | undefined,
    sampling: SamplingConfig | undefined,
    onChunk: (text: string) => void,
    onDone: (text: string, toolCall?: { id: string; name: string; arguments: string }, reasoningContent?: string) => void,
    onError: (err: string) => void,
): Promise<void> {
    // Fallback path may arrive with a streaming URL in scope — recompute non-stream
    // (critical for Gemini: :generateContent, not :streamGenerateContent).
    let nativeUrl = getChatUrl(provider, { stream: false });
    if (format === 'gemini' && provider.apiKey) {
        const sep = nativeUrl.includes('?') ? '&' : '?';
        nativeUrl = `${nativeUrl}${sep}key=${provider.apiKey}`;
    }
    const nativeCall = startUtilityCall(
        'story-generation',
        provider.modelName || provider.endpoint,
        STORY_INITIAL_TIMEOUT_MS,
    );
    const nativeStartedAt = Date.now();
    let settled = false;
    console.info(`[story-gen] start (native non-stream) model=${provider.modelName || provider.endpoint} format=${format} messages=${messages.length} tools=${tools ? (tools as unknown[]).length : 0} timeoutMs=${STORY_INITIAL_TIMEOUT_MS}`);
    // CapacitorHttp can't be aborted mid-flight, so the deadline is informational here.
    nativeCall.deadlinePromise.then(() => {
        if (settled) return;
        console.warn(`[story-gen] deadline reached after ${Date.now() - nativeStartedAt}ms (native non-stream — request cannot be cancelled, still waiting on response)`);
    });
    try {
        const nativePayload = buildChatBody(provider, messages, { stream: false, tools, sampling });
        const nativeRes = await CapacitorHttp.post({
            url: nativeUrl,
            headers,
            data: nativePayload,
            readTimeout: 600000,
            connectTimeout: 15000,
        });
        if (nativeRes.status < 200 || nativeRes.status >= 300) {
            settled = true;
            nativeCall.settleError('error', `API error ${nativeRes.status}`);
            console.warn(`[story-gen] http error ${nativeRes.status} after ${Date.now() - nativeStartedAt}ms (native non-stream)`);
            onError(`API error ${nativeRes.status}: ${JSON.stringify(nativeRes.data)}`);
            return;
        }
        const nativeText = extractContent(nativeRes.data, provider);
        recordCacheUsage(STORY_LABEL, (nativeRes.data as { usage?: LLMUsage })?.usage);
        const nativeReasoning = (nativeRes.data as OpenAICompletionResponse)?.choices?.[0]?.message?.reasoning_content as string | undefined;
        settled = true;
        nativeCall.settleSuccess({ chars: nativeText.length, durationMs: Date.now() - nativeStartedAt, streaming: false, native: true });
        console.info(`[story-gen] done (native non-stream) chars=${nativeText.length} durationMs=${Date.now() - nativeStartedAt}`);
        onChunk(nativeText);
        onDone(nativeText, undefined, nativeReasoning || undefined);
    } catch (e) {
        if (!settled) {
            settled = true;
            nativeCall.settleError(isAbortError(e) ? 'aborted' : 'error', e instanceof Error ? e.message : undefined);
        }
        if (isAbortError(e)) {
            console.warn('[story-gen] aborted (native non-stream)');
            onError('__ABORT__');
            return;
        }
        const msg = e instanceof Error ? e.message : 'Unknown network error';
        console.warn(`[story-gen] native non-stream error: ${msg}`);
        onError(msg);
    }
}

export async function sendMessage(
    provider: LLMProvider,
    messages: OpenAIMessage[],
    onChunk: (text: string) => void,
    onDone: (text: string, toolCall?: { id: string; name: string; arguments: string }, reasoningContent?: string) => void,
    onError: (err: string) => void,
    tools?: unknown[],
    abortController?: AbortController,
    sampling?: SamplingConfig,
) {
    const format = getApiFormat(provider);
    const useStreaming = provider.streamingEnabled !== false;
    const url = getChatUrl(provider, { stream: useStreaming });
    const headers = buildChatHeaders(provider);

    let trackerSettled = false;
    let tracker: ReturnType<typeof startUtilityCall> | null = null;
    const settleTrackerError = (status: 'timeout' | 'error' | 'aborted', message?: string) => {
        if (trackerSettled || !tracker) return;
        trackerSettled = true;
        tracker.settleError(status, message);
    };

    try {
        // On native with streaming OFF: use CapacitorHttp to bypass WebView CORS restrictions.
        if (Capacitor.isNativePlatform() && !useStreaming) {
            await nativeNonStreamStory(provider, messages, format, headers, tools, sampling, onChunk, onDone, onError);
            return;
        }

        const payload = buildChatBody(provider, messages, {
            stream: useStreaming,
            tools,
            sampling,
        });

        const controller = abortController || new AbortController();
        const storyCall = startUtilityCall(
            'story-generation',
            provider.modelName || provider.endpoint,
            STORY_INITIAL_TIMEOUT_MS,
        );
        tracker = storyCall;
        const startedAt = Date.now();
        let chunkCount = 0;
        const settleSuccess = (verbose: Record<string, unknown>) => {
            if (trackerSettled) return;
            trackerSettled = true;
            storyCall.settleSuccess(verbose);
        };
        const settleError = settleTrackerError;
        storyCall.deadlinePromise.then(() => {
            if (trackerSettled) return;
            const elapsedMs = Date.now() - startedAt;
            console.warn(`[story-gen] deadline reached after ${elapsedMs}ms, aborting (model=${provider.modelName || provider.endpoint}, chunks=${chunkCount})`);
            controller.abort();
            settleError('timeout');
        });

        console.info(`[story-gen] start model=${provider.modelName || provider.endpoint} format=${format} streaming=${useStreaming} messages=${messages.length} tools=${tools ? (tools as unknown[]).length : 0} timeoutMs=${STORY_INITIAL_TIMEOUT_MS}`);

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
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (fetchErr) {
            // Android WebView fetch to a no-CORS provider (e.g. NVIDIA NIM) rejects with a
            // TypeError before any response. Recover by re-running this turn over the native
            // HTTP transport (CapacitorHttp), which is not subject to WebView CORS. Streaming
            // providers never reach here — their fetch succeeds. Trade-off: this turn arrives
            // as one blob. A genuine network outage falls through the same path and surfaces
            // its real error from the non-stream attempt.
            if (Capacitor.isNativePlatform() && !isAbortError(fetchErr)) {
                console.warn(`[story-gen] streaming fetch failed on native (${fetchErr instanceof Error ? fetchErr.message : 'unknown'}); falling back to CapacitorHttp non-stream`);
                settleTrackerError('error', 'stream-fallback');
                await nativeNonStreamStory(provider, messages, format, headers, tools, sampling, onChunk, onDone, onError);
                return;
            }
            throw fetchErr;
        }

        if (!res.ok) {
            const errBody = await res.text();
            settleError('error', `API error ${res.status}`);
            console.warn(`[story-gen] http error ${res.status} after ${Date.now() - startedAt}ms: ${errBody.slice(0, 200)}`);
            onError(`API error ${res.status}: ${errBody}`);
            return;
        }

        if (!useStreaming) {
            const data = await res.json();
            const text = extractContent(data, provider);
            recordCacheUsage(STORY_LABEL, (data as { usage?: LLMUsage })?.usage);
            const reasoning = (data as OpenAICompletionResponse)?.choices?.[0]?.message?.reasoning_content as string | undefined;
            settleSuccess({ chars: text.length, durationMs: Date.now() - startedAt, streaming: false });
            console.info(`[story-gen] done (non-stream) chars=${text.length} durationMs=${Date.now() - startedAt}`);
            onChunk(text);
            onDone(text, undefined, reasoning || undefined);
            return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
            settleError('error', 'No readable stream in response');
            onError('No readable stream in response');
            return;
        }

        let nextAutoExtendAt = startedAt + (STORY_INITIAL_TIMEOUT_MS - STORY_CHUNK_EXTEND_THRESHOLD_MS);
        const wrappedOnChunk = (text: string) => {
            chunkCount++;
            const now = Date.now();
            if (now >= nextAutoExtendAt) {
                storyCall.extendSilent(STORY_CHUNK_EXTEND_MS);
                nextAutoExtendAt += STORY_CHUNK_EXTEND_MS;
                console.info(`[story-gen] auto-extend +${STORY_CHUNK_EXTEND_MS}ms (elapsed=${now - startedAt}ms, chunks=${chunkCount})`);
            }
            if (chunkCount === 1 || chunkCount % 25 === 0) {
                console.info(`[story-gen] chunk #${chunkCount} chars=${text.length} elapsedMs=${now - startedAt}`);
            }
            onChunk(text);
        };

        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        let tcId = '';
        let tcName = '';
        let tcArgs = '';
        let reasoningContent = '';
        let streamUsage: LLMUsage | undefined;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (format === 'ollama') {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed.message?.content) {
                            fullText += parsed.message.content;
                            wrappedOnChunk(fullText);
                        }
                    } catch {
                        // skip malformed chunks
                    }
                    continue;
                }

                if (format === 'claude' || format === 'gemini') {
                    if (!trimmed.startsWith('data: ')) continue;
                    const data = trimmed.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = extractStreamDelta(parsed, provider);
                        if (delta) {
                            fullText += delta;
                            wrappedOnChunk(fullText);
                        }

                        const tc = extractStreamToolCall(parsed, provider);
                        if (tc) {
                            if (tc.id) tcId = tc.id;
                            if (tc.name) tcName = tc.name;
                            if (tc.arguments) tcArgs += tc.arguments;
                        }
                    } catch {
                        // skip malformed chunks
                    }
                    continue;
                }

                // OpenAI SSE format
                if (!trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    // DeepSeek/OpenAI emit a trailing chunk (choices:[]) carrying usage
                    // when stream_options.include_usage is set.
                    if (parsed.usage) streamUsage = parsed.usage as LLMUsage;
                    const delta = parsed.choices?.[0]?.delta;

                    const reasoningDelta: string = delta?.reasoning_content ?? delta?.reasoning ?? '';
                    if (reasoningDelta) reasoningContent += reasoningDelta;

                    if (delta?.content) {
                        fullText += delta.content;
                        wrappedOnChunk(fullText);
                    }

                    if (delta?.tool_calls && delta.tool_calls.length > 0) {
                        const tc = delta.tool_calls[0];
                        if (tc.id) tcId = tc.id;
                        if (tc.function?.name) tcName = tc.function.name;
                        if (tc.function?.arguments) tcArgs += tc.function.arguments;
                    }
                } catch {
                    // skip malformed chunks
                }
            }
        }

        // --- DeepSeek / Local Model Fallback Parsing ---
        if (format !== 'claude' && format !== 'gemini' && !tcName && fullText.includes('<\uFF5CDSML\uFF5C>function_calls>')) {
            const funcMatch = fullText.match(/<\uFF5CDSML\uFF5C>invoke name="([^"]+)">/);
            if (funcMatch) {
                tcName = funcMatch[1];
                tcId = uid();

                const paramRegex = /<\uFF5CDSML\uFF5Cparameter name="([^"]+)"[^>]*>([\s\S]*?)<\/\uFF5CDSML\uFF5Cparameter>/g;
                let match;
                const argsObj: Record<string, unknown> = {};

                while ((match = paramRegex.exec(fullText)) !== null) {
                    argsObj[match[1]] = match[2].trim();
                }

                if (Object.keys(argsObj).length > 0) {
                    tcArgs = JSON.stringify(argsObj);
                } else {
                    const fallbackQueryMatch = fullText.match(/>([^<]+)<\/\uFF5CDSML\uFF5Cparameter>/);
                    if (fallbackQueryMatch) {
                        tcArgs = JSON.stringify({ query: fallbackQueryMatch[1].trim() });
                    } else if (fullText.includes('string="true">')) {
                        const directMatch = fullText.split('string="true">')[1]?.split('</')[0];
                        if (directMatch) {
                            tcArgs = JSON.stringify({ query: directMatch.trim() });
                        }
                    }
                }

                fullText = fullText.split('<\uFF5CDSML\uFF5C>function_calls>')[0].trim();
                wrappedOnChunk(fullText);
            }
        }

        recordCacheUsage(STORY_LABEL, streamUsage);
        settleSuccess({
            chars: fullText.length,
            durationMs: Date.now() - startedAt,
            chunks: chunkCount,
            toolCall: tcName || null,
            reasoningChars: reasoningContent.length,
            usage: streamUsage,
        });
        console.info(`[story-gen] done model=${provider.modelName || provider.endpoint} chars=${fullText.length} chunks=${chunkCount} durationMs=${Date.now() - startedAt} toolCall=${tcName || 'none'}`);

        if (tcName) {
            onDone(fullText, { id: tcId, name: tcName, arguments: tcArgs }, reasoningContent || undefined);
        } else {
            onDone(fullText, undefined, reasoningContent || undefined);
        }
    } catch (err) {
        if (isAbortError(err)) {
            settleTrackerError('aborted');
            console.warn('[story-gen] aborted');
            onError('__ABORT__');
            return;
        }
        const msg = err instanceof Error ? err.message : 'Unknown network error';
        settleTrackerError('error', msg);
        console.warn(`[story-gen] error: ${msg}`);
        onError(msg);
    }
}

export async function testConnection(provider: LLMProvider): Promise<{ ok: boolean; detail: string }> {
    const format = getApiFormat(provider);
    const headers = buildChatHeaders(provider);
    delete headers['Content-Type'];
    let url = getModelsUrl(provider);

    if (format === 'gemini' && provider.apiKey) {
        url = `${url}?key=${provider.apiKey}`;
    }

    try {
        if (Capacitor.isNativePlatform()) {
            const res = await CapacitorHttp.get({ url, headers });
            if (res.status >= 200 && res.status < 300) {
                return { ok: true, detail: 'Connection successful' };
            }
            return { ok: false, detail: `HTTP ${res.status}: ${JSON.stringify(res.data)}` };
        }

        const res = await fetch(url, { headers });
        if (res.ok) {
            return { ok: true, detail: 'Connection successful' };
        }
        return { ok: false, detail: `HTTP ${res.status}: ${await res.text()}` };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'Network error' };
    }
}
