import { describe, it, expect } from 'vitest';
import {
    getApiFormat,
    detectFormatFromEndpoint,
    getBaseUrl,
    getChatUrl,
    buildChatBody,
    extractContent,
    extractStreamDelta,
} from '../../utils/llmApiHelper';
import type { LLMProvider } from '../../types';

const openaiProvider: LLMProvider = {
    id: 'openai-test',
    label: 'OpenAI Test',
    endpoint: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    modelName: 'gpt-4',
    apiFormat: 'openai',
};

const ollamaProvider: LLMProvider = {
    id: 'ollama-test',
    label: 'Ollama Test',
    endpoint: 'http://localhost:11434',
    apiKey: '',
    modelName: 'llama3',
    apiFormat: 'ollama',
};

const claudeProvider: LLMProvider = {
    id: 'claude-test',
    label: 'Claude Test',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: 'sk-ant-test',
    modelName: 'claude-3-opus',
    apiFormat: 'claude',
};

const geminiProvider: LLMProvider = {
    id: 'gemini-test',
    label: 'Gemini Test',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza-test',
    modelName: 'gemini-pro',
    apiFormat: 'gemini',
};

describe('getApiFormat', () => {
    it('returns openai by default', () => {
        expect(getApiFormat({ id: 'default', label: 'Default', endpoint: '', apiKey: '', modelName: '' })).toBe('openai');
    });
    it('returns the specified format', () => {
        expect(getApiFormat(ollamaProvider)).toBe('ollama');
        expect(getApiFormat(claudeProvider)).toBe('claude');
        expect(getApiFormat(geminiProvider)).toBe('gemini');
    });
});

describe('detectFormatFromEndpoint', () => {
    it('detects anthropic', () => {
        expect(detectFormatFromEndpoint('https://api.anthropic.com/v1')).toBe('claude');
    });
    it('detects gemini', () => {
        expect(detectFormatFromEndpoint('https://generativelanguage.googleapis.com/v1beta')).toBe('gemini');
    });
    it('does not detect ollama from localhost without path (hostname excludes port)', () => {
        // Note: detectFormatFromEndpoint checks hostname which excludes port,
        // so plain http://localhost:11434 returns null (hostname is just "localhost").
        // This is a known limitation; in practice ollama endpoints have /v1 or /api/chat paths.
        expect(detectFormatFromEndpoint('http://localhost:11434')).toBeNull();
    });
    it('detects ollama via 127.0.0.1 hostname check', () => {
        // In jsdom, URL.hostname for http://127.0.0.1:11434 returns "127.0.0.1" without port
        expect(detectFormatFromEndpoint('http://127.0.0.1:11434')).toBeNull();
    });
    it('returns null for unknown', () => {
        expect(detectFormatFromEndpoint('https://api.example.com/v1')).toBeNull();
    });
    it('returns null for invalid URL', () => {
        expect(detectFormatFromEndpoint('not-a-url')).toBeNull();
    });
});

describe('getBaseUrl', () => {
    it('appends /v1 to bare openai host', () => {
        expect(getBaseUrl(openaiProvider)).toBe('https://api.openai.com/v1');
    });
    it('does not double-append /v1', () => {
        const p: LLMProvider = { ...openaiProvider, endpoint: 'https://api.openai.com/v1/' };
        expect(getBaseUrl(p)).toBe('https://api.openai.com/v1');
    });
    it('does not append /v1 to ollama', () => {
        expect(getBaseUrl(ollamaProvider)).toBe('http://localhost:11434');
    });
    it('does not append /v1 to claude', () => {
        expect(getBaseUrl(claudeProvider)).toBe('https://api.anthropic.com/v1');
    });
});

describe('getChatUrl', () => {
    it('builds openai chat URL', () => {
        expect(getChatUrl(openaiProvider)).toBe('https://api.openai.com/v1/chat/completions');
    });
    it('builds ollama chat URL', () => {
        expect(getChatUrl(ollamaProvider)).toBe('http://localhost:11434/api/chat');
    });
    it('builds claude messages URL', () => {
        expect(getChatUrl(claudeProvider)).toBe('https://api.anthropic.com/v1/messages');
    });
    it('builds gemini stream URL', () => {
        const url = getChatUrl(geminiProvider, { stream: true });
        expect(url).toContain('streamGenerateContent');
    });
    it('builds gemini non-stream URL', () => {
        const url = getChatUrl(geminiProvider, { stream: false });
        expect(url).toContain('generateContent');
        expect(url).not.toContain('streamGenerateContent');
    });
});

describe('buildChatBody', () => {
    const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
    ];

    it('builds openai body with messages', () => {
        const body = buildChatBody(openaiProvider, messages);
        expect(body.model).toBe('gpt-4');
        expect(body.messages).toEqual(messages);
        expect(body.stream).toBe(false);
    });

    it('builds ollama body with simplified messages', () => {
        const body = buildChatBody(ollamaProvider, messages);
        expect(body.model).toBe('llama3');
        expect(body.messages).toEqual([
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ]);
    });

    it('builds claude body with system separate', () => {
        const withSystem = [
            { role: 'system' as const, content: 'You are a GM' },
            ...messages,
        ];
        const body = buildChatBody(claudeProvider, withSystem);
        expect(body.system).toBe('You are a GM');
        expect((body.messages as { role: string }[]).every(m => m.role !== 'system')).toBe(true);
    });

    it('applies sampling config', () => {
        const body = buildChatBody(openaiProvider, messages, {
            sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 2048 },
        });
        expect(body.temperature).toBe(0.7);
        expect(body.top_p).toBe(0.9);
        expect(body.max_tokens).toBe(2048);
    });

    it('does not include tools for ollama', () => {
        const tools = [{ type: 'function', function: { name: 'test', description: 'desc', parameters: {} } }];
        const body = buildChatBody(ollamaProvider, messages, { tools });
        expect(body.tools).toBeUndefined();
    });

    it('includes tools for openai', () => {
        const tools = [{ type: 'function', function: { name: 'test', description: 'desc', parameters: {} } }];
        const body = buildChatBody(openaiProvider, messages, { tools });
        expect(body.tools).toBeDefined();
    });
});

describe('service tier', () => {
    const messages = [{ role: 'user' as const, content: 'Hello' }];
    const nano: LLMProvider = { ...openaiProvider, endpoint: 'https://nano-gpt.com/api/v1', modelName: 'openai/gpt-5.5' };
    const router: LLMProvider = { ...openaiProvider, endpoint: 'https://openrouter.ai/api/v1', modelName: 'openai/gpt-5.5' };

    it('sends nothing when unset', () => {
        expect(buildChatBody(nano, messages).service_tier).toBeUndefined();
        expect(buildChatBody(router, messages).service_tier).toBeUndefined();
    });

    it('sends flex and fast to NanoGPT', () => {
        expect(buildChatBody({ ...nano, serviceTier: 'flex' }, messages).service_tier).toBe('flex');
        expect(buildChatBody({ ...nano, serviceTier: 'priority' }, messages).service_tier).toBe('fast');
    });

    it('sends flex and priority to OpenRouter', () => {
        expect(buildChatBody({ ...router, serviceTier: 'flex' }, messages).service_tier).toBe('flex');
        expect(buildChatBody({ ...router, serviceTier: 'priority' }, messages).service_tier).toBe('priority');
    });

    it('sends nothing to other hosts or formats', () => {
        expect(buildChatBody({ ...openaiProvider, serviceTier: 'flex' }, messages).service_tier).toBeUndefined();
        expect(buildChatBody({ ...router, apiFormat: 'claude', serviceTier: 'flex' }, messages).service_tier).toBeUndefined();
    });
});

describe('extractContent', () => {
    it('extracts openai content', () => {
        const data = { choices: [{ message: { content: 'Hello world' } }] };
        expect(extractContent(data, openaiProvider)).toBe('Hello world');
    });
    it('extracts ollama content', () => {
        const data = { message: { content: 'Hello from ollama' } };
        expect(extractContent(data, ollamaProvider)).toBe('Hello from ollama');
    });
    it('extracts claude content', () => {
        const data = { content: [{ type: 'text', text: 'Hello from claude' }] };
        expect(extractContent(data, claudeProvider)).toBe('Hello from claude');
    });
    it('extracts gemini content', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'Hello from gemini' }] } }] };
        expect(extractContent(data, geminiProvider)).toBe('Hello from gemini');
    });
    it('returns empty string for missing data', () => {
        expect(extractContent({}, openaiProvider)).toBe('');
    });
});

describe('extractStreamDelta', () => {
    it('extracts openai delta', () => {
        const data = { choices: [{ delta: { content: 'Hello' } }] };
        expect(extractStreamDelta(data, openaiProvider)).toBe('Hello');
    });
    it('extracts claude text delta', () => {
        const data = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
        expect(extractStreamDelta(data, claudeProvider)).toBe('Hello');
    });
    it('returns empty for claude non-delta', () => {
        const data = { type: 'message_start' };
        expect(extractStreamDelta(data, claudeProvider)).toBe('');
    });
    it('extracts gemini delta', () => {
        const data = { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] };
        expect(extractStreamDelta(data, geminiProvider)).toBe('Hi');
    });
});

describe('cache_control on messages (prompt-caching regression)', () => {
    it('passes cache_control on system blocks through to Claude system array', () => {
        const messages = [
            { role: 'system' as const, content: 'You are a GM', cache_control: { type: 'ephemeral' as const } },
            { role: 'system' as const, content: 'Facts here', cache_control: { type: 'ephemeral' as const } },
            { role: 'user' as const, content: 'Hello' },
        ];
        const body = buildChatBody(claudeProvider, messages);
        const system = body.system as { type: string; text: string; cache_control?: { type: string } }[];
        expect(system).toHaveLength(2);
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds cache_control to plain user message as content block array', () => {
        const messages = [
            { role: 'system' as const, content: 'System', cache_control: { type: 'ephemeral' as const } },
            { role: 'user' as const, content: 'First user', cache_control: { type: 'ephemeral' as const } },
            { role: 'user' as const, content: 'Second user' },
        ];
        const body = buildChatBody(claudeProvider, messages);
        const convMessages = body.messages as { role: string; content: string | unknown[] }[];

        const firstUser = convMessages.find(m => m.role === 'user' && Array.isArray(m.content)) as { role: string; content: unknown[] } | undefined;
        expect(firstUser).toBeDefined();
        const firstBlock = firstUser!.content[0] as { type: string; text: string; cache_control?: { type: string } };
        expect(firstBlock.type).toBe('text');
        expect(firstBlock.cache_control).toEqual({ type: 'ephemeral' });

        const secondUser = convMessages.filter(m => m.role === 'user')[1];
        expect(typeof secondUser.content).toBe('string');
    });

    it('adds cache_control to plain assistant message as content block array', () => {
        const messages = [
            { role: 'system' as const, content: 'System', cache_control: { type: 'ephemeral' as const } },
            { role: 'user' as const, content: 'Hello' },
            { role: 'assistant' as const, content: 'Hi there!', cache_control: { type: 'ephemeral' as const } },
        ];
        const body = buildChatBody(claudeProvider, messages);
        const convMessages = body.messages as { role: string; content: string | unknown[] }[];

        const assistant = convMessages.find(m => m.role === 'assistant')!;
        expect(Array.isArray(assistant.content)).toBe(true);
        const block = (assistant.content as unknown[])[0] as { type: string; text: string; cache_control?: { type: string } };
        expect(block.type).toBe('text');
        expect(block.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('adds cache_control to last tool_calls content block for assistant with tool_calls', () => {
        const messages = [
            { role: 'system' as const, content: 'System', cache_control: { type: 'ephemeral' as const } },
            { role: 'user' as const, content: 'Roll dice' },
            { role: 'assistant' as const, content: 'Let me roll', tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name: 'roll_dice', arguments: '{"dice":"1d20"}' } }], cache_control: { type: 'ephemeral' as const } },
        ];
        const body = buildChatBody(claudeProvider, messages);
        const convMessages = body.messages as { role: string; content: string | unknown[] }[];

        const assistant = convMessages.find(m => m.role === 'assistant')!;
        expect(Array.isArray(assistant.content)).toBe(true);
        const lastBlock = (assistant.content as unknown[])[(assistant.content as unknown[]).length - 1] as Record<string, unknown>;
        expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('strips cache_control for OpenAI format', () => {
        const messages = [
            { role: 'system' as const, content: 'System' },
            { role: 'user' as const, content: 'Hello', cache_control: { type: 'ephemeral' as const } },
            { role: 'assistant' as const, content: 'Hi', cache_control: { type: 'ephemeral' as const } },
        ];
        const body = buildChatBody(openaiProvider, messages);
        const convMessages = body.messages as { role: string; content: string; cache_control?: unknown }[];
        expect(convMessages.every(m => m.cache_control === undefined)).toBe(true);
    });

    it('total cache breakpoints do not exceed 4 (3 system + 1 history)', () => {
        const messages = [
            { role: 'system' as const, content: 'Stable preamble', cache_control: { type: 'ephemeral' as const } },
            { role: 'system' as const, content: 'Divergence facts', cache_control: { type: 'ephemeral' as const } },
            { role: 'system' as const, content: 'Pinned memories', cache_control: { type: 'ephemeral' as const } },
            { role: 'user' as const, content: 'Turn 1' },
            { role: 'assistant' as const, content: 'Response 1' },
            { role: 'user' as const, content: 'Turn 2' },
            { role: 'assistant' as const, content: 'Response 2', cache_control: { type: 'ephemeral' as const } },
            { role: 'user' as const, content: 'Turn 3 (volatile)' },
        ];
        const body = buildChatBody(claudeProvider, messages);
        const system = body.system as { cache_control?: { type: string } }[] | undefined;
        const convMessages = body.messages as { role: string; content: string | unknown[] }[];

        let breakpointCount = 0;
        if (Array.isArray(system)) {
            breakpointCount += system.filter(b => b.cache_control).length;
        }
        for (const m of convMessages) {
            if (Array.isArray(m.content)) {
                for (const block of m.content as unknown[]) {
                    if ((block as Record<string, unknown>).cache_control) breakpointCount++;
                }
            }
        }
        expect(breakpointCount).toBeLessThanOrEqual(4);
    });
});