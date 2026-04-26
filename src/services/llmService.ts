import type { LLMProvider, SamplingConfig } from '../types';
import { uid } from '../utils/uid';
import { getApiFormat, getChatUrl, getModelsUrl, buildChatHeaders, buildChatBody, extractContent, extractStreamDelta, extractStreamToolCall } from '../utils/llmApiHelper';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

export type OpenAIMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
    reasoning_content?: string;
};

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

    try {
        // On native with streaming OFF: use CapacitorHttp to bypass WebView CORS restrictions.
        if (Capacitor.isNativePlatform() && !useStreaming) {
            let nativeUrl = url;
            if (format === 'gemini' && provider.apiKey) {
                const sep = nativeUrl.includes('?') ? '&' : '?';
                nativeUrl = `${nativeUrl}${sep}key=${provider.apiKey}`;
            }
            const nativePayload = buildChatBody(provider, messages, { stream: false, tools, sampling });
            const nativeRes = await CapacitorHttp.post({
                url: nativeUrl,
                headers,
                data: nativePayload,
                readTimeout: 600000,
                connectTimeout: 15000,
            });
            if (nativeRes.status < 200 || nativeRes.status >= 300) {
                onError(`API error ${nativeRes.status}: ${JSON.stringify(nativeRes.data)}`);
                return;
            }
            const nativeText = extractContent(nativeRes.data, provider);
            const nativeReasoning = (nativeRes.data as any)?.choices?.[0]?.message?.reasoning_content as string | undefined;
            onChunk(nativeText);
            onDone(nativeText, undefined, nativeReasoning || undefined);
            return;
        }

        const payload = buildChatBody(provider, messages, {
            stream: useStreaming,
            tools,
            sampling,
        });

        const controller = abortController || new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), 120000);

        let fetchUrl = url;
        if (format === 'gemini' && provider.apiKey) {
            const sep = fetchUrl.includes('?') ? '&' : '?';
            fetchUrl = `${fetchUrl}${sep}key=${provider.apiKey}`;
        }

        const res = await fetch(fetchUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!res.ok) {
            clearTimeout(timeoutId);
            const errBody = await res.text();
            onError(`API error ${res.status}: ${errBody}`);
            return;
        }

        if (!useStreaming) {
            clearTimeout(timeoutId);
            const data = await res.json();
            const text = extractContent(data, provider);
            const reasoning = (data as any)?.choices?.[0]?.message?.reasoning_content as string | undefined;
            onChunk(text);
            onDone(text, undefined, reasoning || undefined);
            return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
            onError('No readable stream in response');
            return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        let tcId = '';
        let tcName = '';
        let tcArgs = '';
        let reasoningContent = '';

        while (true) {
            const { done, value } = await reader.read();
            clearTimeout(timeoutId);
            if (done) break;

            timeoutId = setTimeout(() => controller.abort(), 120000);

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
                            onChunk(fullText);
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
                            onChunk(fullText);
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
                    const delta = parsed.choices?.[0]?.delta;

                    if (delta?.reasoning_content) {
                        reasoningContent += delta.reasoning_content;
                    }

                    if (delta?.content) {
                        fullText += delta.content;
                        onChunk(fullText);
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
                onChunk(fullText);
            }
        }

        if (tcName) {
            onDone(fullText, { id: tcId, name: tcName, arguments: tcArgs }, reasoningContent || undefined);
        } else {
            onDone(fullText, undefined, reasoningContent || undefined);
        }
    } catch (err) {
        const isAbort = (err instanceof DOMException && err.name === 'AbortError')
            || (err instanceof Error && err.name === 'AbortError')
            || (err as any)?.name === 'AbortError';
        if (isAbort) {
            onError('__ABORT__');
            return;
        }
        onError(err instanceof Error ? err.message : 'Unknown network error');
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
