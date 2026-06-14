export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ToolResultMessage {
    role: 'tool';
    tool_call_id: string;
    content: string;
    name?: string;
}

export interface AssistantMessage {
    role: 'assistant';
    content: string | null;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    cache_control?: { type: 'ephemeral' };
}

export interface UserMessage {
    role: 'user';
    content: string;
    reasoning_content?: never;
    cache_control?: { type: 'ephemeral' };
}

export interface SystemMessage {
    role: 'system';
    content: string;
    cache_control?: { type: 'ephemeral' };
}

export type LLMChatMessage =
    | SystemMessage
    | UserMessage
    | AssistantMessage
    | ToolResultMessage;

/**
 * Token usage as returned by OpenAI-compatible providers. DeepSeek additionally
 * reports prompt-cache split (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`)
 * — capture them so cache performance is observable instead of having to be
 * reverse-engineered from payload diffs.
 */
export interface LLMUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** DeepSeek: input tokens served from the context cache. */
    prompt_cache_hit_tokens?: number;
    /** DeepSeek: input tokens that were NOT cached (full price). */
    prompt_cache_miss_tokens?: number;
}

export interface OpenAICompletionResponse {
    choices: Array<{
        message: AssistantMessage;
        finish_reason: string;
    }>;
    usage?: LLMUsage;
}

export function isAssistantMessage(m: LLMChatMessage): m is AssistantMessage {
    return m.role === 'assistant';
}

export function hasToolCalls(m: LLMChatMessage): m is AssistantMessage & { tool_calls: ToolCall[] } {
    return m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

export function isToolResultMessage(m: LLMChatMessage): m is ToolResultMessage {
    return m.role === 'tool';
}

export function isAbortError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
    if (err instanceof Error && err.name === 'AbortError') return true;
    if (typeof err === 'object' && err !== null && 'name' in err && (err as { name?: string }).name === 'AbortError') return true;
    return false;
}

export function buildAssistantToolCallMessage(
    content: string | null,
    toolCalls: ToolCall[],
    reasoningContent?: string,
): AssistantMessage {
    return {
        role: 'assistant',
        content,
        tool_calls: toolCalls,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    };
}

export function buildToolResultMessage(
    toolCallId: string,
    content: string,
    name?: string,
): ToolResultMessage {
    return {
        role: 'tool',
        tool_call_id: toolCallId,
        content,
        ...(name ? { name } : {}),
    };
}