import type { LLMChatMessage, AssistantMessage, ToolCall } from '../../types/llmMessages';
import { isAssistantMessage, hasToolCalls, isToolResultMessage } from '../../types/llmMessages';

const THINKING_MODEL_RE = /deepseek-r|deepseek-v[34]|deepseek.*think|qwq|qwen.*think|r1/i;

function isValidToolCall(tc: unknown): tc is ToolCall {
    if (!tc || typeof tc !== 'object') return false;
    const c = tc as Record<string, unknown>;
    if (c.type !== 'function' || typeof c.id !== 'string') return false;
    if (!c.function || typeof (c.function as Record<string, unknown>).name !== 'string') return false;
    if ((c.function as Record<string, unknown>).arguments !== undefined) {
        try { JSON.parse((c.function as Record<string, unknown>).arguments as string); } catch { return false; }
    }
    return true;
}

export const sanitizePayloadForApi = (rawPayload: LLMChatMessage[], allowTools: boolean, modelName?: string): LLMChatMessage[] => {
    const isThinkingModel = modelName ? THINKING_MODEL_RE.test(modelName) : false;

    const cleaned: LLMChatMessage[] = [];
    const openToolCalls = new Set<string>();

    for (const msg of rawPayload) {
        if (!msg || typeof msg !== 'object') continue;

        if (isAssistantMessage(msg)) {
            const toolCalls = hasToolCalls(msg) ? msg.tool_calls : undefined;
            const hasCalls = toolCalls !== undefined;

            if (isThinkingModel && hasCalls && !msg.reasoning_content) {
                console.warn('[Sanitizer] Thinking-model: stripping tool_calls from assistant missing reasoning_content — would cause 400. ids:', toolCalls.map(tc => tc.id));
                const stripped: AssistantMessage = { ...msg };
                delete (stripped as Partial<AssistantMessage>).tool_calls;
                cleaned.push(stripped);
                continue;
            }

            if (!allowTools || !hasCalls) {
                if (allowTools && Array.isArray(msg.tool_calls)) {
                    console.warn('[Payload] Stripped empty tool_calls from assistant message');
                } else if (!allowTools && hasCalls) {
                    console.warn('[Payload] Stripped tool_calls from assistant message (tools disabled)');
                }
                const { tool_calls: _tc, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            const validCalls = toolCalls.filter(isValidToolCall);

            if (validCalls.length === 0) {
                console.warn('[Payload] All tool_calls invalid for assistant message, stripping', msg.tool_calls?.length, 'calls');
                const { tool_calls: _tc, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            cleaned.push({ ...msg, tool_calls: validCalls });
            for (const tc of validCalls) openToolCalls.add(tc.id);
            continue;
        }

        if (isToolResultMessage(msg)) {
            if (!allowTools) continue;

            const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (!callId || !openToolCalls.has(callId)) {
                console.warn('[Payload] Dropping orphan tool message:', msg.tool_call_id);
                continue;
            }

            openToolCalls.delete(callId);
            cleaned.push(msg);
            continue;
        }

        if (msg.role === 'user' && (msg as unknown as Record<string, unknown>).reasoning_content !== undefined) {
            const userMsg = Object.assign({}, msg) as unknown as Record<string, unknown>;
            delete userMsg.reasoning_content;
            cleaned.push(userMsg as unknown as LLMChatMessage);
            continue;
        }

        cleaned.push(msg);
    }

    const resolvedCallIds = new Set(
        cleaned.filter(isToolResultMessage).map(m => m.tool_call_id)
    );
    const result = cleaned.map(msg => {
        if (hasToolCalls(msg)) {
            const resolved = msg.tool_calls.filter(tc => resolvedCallIds.has(tc.id));
            if (resolved.length !== msg.tool_calls.length) {
                console.warn('[Payload] Stripping unresolved tool_calls from assistant message to prevent 400');
                const { tool_calls: _tc, ...rest } = msg;
                return resolved.length > 0 ? { ...rest, tool_calls: resolved } : rest;
            }
        }
        return msg;
    });

    return result;
};
