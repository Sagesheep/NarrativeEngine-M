import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    resolveThinkingControl,
    thinkingHostOf,
    isThinkingControlRejection,
    markThinkingControlRefused,
    __resetThinkingRefusalsForTests,
    type CatalogModel,
} from '../thinkingControl';
import { buildChatBody } from '../llmApiHelper';
import { llmCall } from '../llmCall';
import {
    __setModelCatalogForTests,
    lookupCatalogModel,
    parseNanoGptCatalog,
    parseOpenRouterCatalog,
} from '../../services/llm/modelCatalog';
import type { ApiFormat, LLMProvider, ThinkingEffort } from '../../types';

// Entries as NanoGPT and OpenRouter list them (model lists fetched 2026-10-13).
const NANO: Record<string, CatalogModel> = {
    'deepseek/deepseek-v4-flash': { reasoning: true, efforts: ['none', 'high', 'max'] },
    'moonshotai/kimi-k2.6': { reasoning: false },
    'moonshotai/kimi-k2.6:thinking': { reasoning: true },
    'z-ai/glm-5.3': { reasoning: true, efforts: ['low', 'high', 'max'] },
    'z-ai/glm-5.3:thinking': { reasoning: true, efforts: ['high', 'max'] },
    'z-ai/glm-5.1': { reasoning: true, efforts: ['none', 'high'] },
    'anthropic/claude-opus-5.5': { reasoning: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    'thedrummer/cydonia-24b-v4.3': { reasoning: false },
};
const OPENROUTER: Record<string, CatalogModel> = {
    'deepseek/deepseek-v4-flash': { reasoning: true, efforts: ['xhigh', 'high'] },
    'z-ai/glm-5.3': { reasoning: true, mandatory: true, defaultOn: true, efforts: ['max', 'high', 'low'] },
    'anthropic/claude-opus-4.7': { reasoning: true, defaultOn: false, efforts: ['max', 'xhigh', 'high', 'medium', 'low'] },
    'moonshotai/kimi-k3': { reasoning: true, defaultOn: true, efforts: ['max', 'high', 'low'] },
    'thedrummer/cydonia-24b-v4.1': { reasoning: false },
};

const lookupIn = (models: Record<string, CatalogModel>) => (id: string) => models[id.toLowerCase()];

function p(endpoint: string, modelName: string, apiFormat: ApiFormat = 'openai'): LLMProvider {
    return { id: modelName, label: modelName, endpoint, apiKey: 'k', modelName, apiFormat };
}

const NANO_URL = 'https://nano-gpt.com/api/v1';
const OR_URL = 'https://openrouter.ai/api/v1';

beforeEach(() => __resetThinkingRefusalsForTests());

describe('thinkingHostOf', () => {
    it('recognises each host by name, not by model', () => {
        expect(thinkingHostOf('https://api.deepseek.com/v1')).toBe('deepseek');
        expect(thinkingHostOf('https://nano-gpt.com/api/v1')).toBe('nanogpt');
        expect(thinkingHostOf('https://openrouter.ai/api/v1')).toBe('openrouter');
        expect(thinkingHostOf('https://api.z.ai/api/paas/v4')).toBe('zai');
        expect(thinkingHostOf('https://open.bigmodel.cn/api/paas/v4')).toBe('zai');
        expect(thinkingHostOf('https://api.moonshot.ai/v1')).toBe('moonshot');
        expect(thinkingHostOf('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toBe('dashscope');
        expect(thinkingHostOf('https://api.openai.com/v1')).toBe('openaiStyle');
        expect(thinkingHostOf('https://api.x.ai/v1')).toBe('openaiStyle');
        expect(thinkingHostOf('http://192.168.1.20:5001/v1')).toBe('generic');
        expect(thinkingHostOf('https://llm.chutes.ai/v1')).toBe('generic');
        // A DeepSeek model on another host is that host's business.
        expect(thinkingHostOf('https://my-deepseek-proxy.example.com/v1')).toBe('generic');
        expect(thinkingHostOf('not a url')).toBe('generic');
    });
});

describe('Model default sends nothing', () => {
    it('for every host and format', () => {
        const providers = [
            p('https://api.deepseek.com', 'deepseek-v4-flash'),
            p(NANO_URL, 'deepseek/deepseek-v4-flash'),
            p(OR_URL, 'z-ai/glm-5.3'),
            p('http://localhost:11434', 'qwen3', 'ollama'),
            p('https://generativelanguage.googleapis.com/v1beta', 'gemini-3.5-flash', 'gemini'),
        ];
        for (const provider of providers) {
            const c = resolveThinkingControl(provider, provider.apiFormat!, undefined, lookupIn(NANO));
            expect(c.fields).toEqual({});
            expect(c.model).toBeUndefined();
        }
    });
});

describe('DeepSeek API', () => {
    const ds = p('https://api.deepseek.com/v1', 'deepseek-v4-flash');
    it('turns thinking off explicitly (it thinks by default)', () => {
        expect(resolveThinkingControl(ds, 'openai', 'off').fields).toEqual({ thinking: { type: 'disabled' } });
    });
    it('sends high or max when on', () => {
        expect(resolveThinkingControl(ds, 'openai', 'low').fields).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
        expect(resolveThinkingControl(ds, 'openai', 'max').fields).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    });
});

describe('NanoGPT', () => {
    const off = (model: string) => resolveThinkingControl(p(NANO_URL, model), 'openai', 'off', lookupIn(NANO));
    const on = (model: string, effort: ThinkingEffort) => resolveThinkingControl(p(NANO_URL, model), 'openai', effort, lookupIn(NANO));

    it('sends none when the model can turn thinking off', () => {
        expect(off('deepseek/deepseek-v4-flash')).toEqual({ fields: { reasoning_effort: 'none' }, reserveEffort: undefined });
        expect(off('z-ai/glm-5.1').fields).toEqual({ reasoning_effort: 'none' });
    });

    it('switches a :thinking model to its plain id', () => {
        expect(off('moonshotai/kimi-k2.6:thinking')).toEqual({ fields: {}, model: 'moonshotai/kimi-k2.6', reserveEffort: undefined });
        expect(off('z-ai/glm-5.3:thinking')).toEqual({ fields: { reasoning_effort: 'low' }, model: 'z-ai/glm-5.3', reserveEffort: 'low' });
    });

    it('drops a model that must think to its lowest level, and reserves tokens for it', () => {
        expect(off('z-ai/glm-5.3')).toEqual({ fields: { reasoning_effort: 'low' }, reserveEffort: 'low' });
        expect(off('anthropic/claude-opus-5.5').fields).toEqual({ reasoning_effort: 'low' });
    });

    it('sends nothing to a model that never thinks (any case)', () => {
        expect(off('TheDrummer/Cydonia-24B-v4.3')).toEqual({ fields: {}, reserveEffort: undefined });
    });

    it('asks for none when the model is not listed', () => {
        expect(off('some/new-model')).toEqual({ fields: { reasoning_effort: 'none' }, reserveEffort: undefined });
    });

    it('picks the nearest level the model accepts when on', () => {
        expect(on('z-ai/glm-5.1', 'low').fields).toEqual({ reasoning_effort: 'high' });
        expect(on('deepseek/deepseek-v4-flash', 'medium').fields).toEqual({ reasoning_effort: 'high' });
        expect(on('deepseek/deepseek-v4-flash', 'max').fields).toEqual({ reasoning_effort: 'max' });
        expect(on('some/new-model', 'medium').fields).toEqual({ reasoning_effort: 'medium' });
    });
});

describe('OpenRouter', () => {
    const off = (model: string) => resolveThinkingControl(p(OR_URL, model), 'openai', 'off', lookupIn(OPENROUTER));

    it('sends effort none to models that can turn thinking off', () => {
        expect(off('deepseek/deepseek-v4-flash')).toEqual({ fields: { reasoning: { effort: 'none' } }, reserveEffort: undefined });
    });
    it('drops a mandatory-thinking model to its lowest level', () => {
        expect(off('z-ai/glm-5.3')).toEqual({ fields: { reasoning: { effort: 'low' } }, reserveEffort: 'low' });
    });
    it('sends nothing when the model does not think unless asked', () => {
        expect(off('anthropic/claude-opus-4.7').fields).toEqual({});
        expect(off('thedrummer/cydonia-24b-v4.1').fields).toEqual({});
    });
    it('maps an on level to the nearest supported one', () => {
        const c = resolveThinkingControl(p(OR_URL, 'deepseek/deepseek-v4-flash'), 'openai', 'low', lookupIn(OPENROUTER));
        expect(c.fields).toEqual({ reasoning: { effort: 'high' } });
    });
});

describe('other hosts', () => {
    it('Z.ai and Kimi use thinking.type', () => {
        expect(resolveThinkingControl(p('https://api.z.ai/api/paas/v4', 'glm-5.1'), 'openai', 'off').fields).toEqual({ thinking: { type: 'disabled' } });
        expect(resolveThinkingControl(p('https://api.moonshot.ai/v1', 'kimi-k2.6'), 'openai', 'high').fields).toEqual({ thinking: { type: 'enabled' } });
    });
    it('Qwen on DashScope uses enable_thinking', () => {
        const q = p('https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus');
        expect(resolveThinkingControl(q, 'openai', 'off').fields).toEqual({ enable_thinking: false });
        expect(resolveThinkingControl(q, 'openai', 'medium').fields).toEqual({ enable_thinking: true });
    });
    it('OpenAI-style hosts use reasoning_effort none', () => {
        expect(resolveThinkingControl(p('https://api.openai.com/v1', 'gpt-5.5'), 'openai', 'off').fields).toEqual({ reasoning_effort: 'none' });
        expect(resolveThinkingControl(p('https://api.openai.com/v1', 'gpt-5.5'), 'openai', 'max').fields).toEqual({ reasoning_effort: 'xhigh' });
    });
    it('unknown and local servers get chat template switches', () => {
        const local = p('http://192.168.1.20:8080/v1', 'Qwen3.6-27B');
        expect(resolveThinkingControl(local, 'openai', 'off')).toEqual({
            fields: { chat_template_kwargs: { enable_thinking: false, thinking: false } },
            reserveEffort: undefined,
        });
        expect(resolveThinkingControl(local, 'openai', 'high').fields).toEqual({ reasoning_effort: 'high' });
    });
    it('Ollama uses think true/false', () => {
        const o = p('http://localhost:11434', 'qwen3', 'ollama');
        expect(resolveThinkingControl(o, 'ollama', 'off').fields).toEqual({ think: false });
        expect(resolveThinkingControl(o, 'ollama', 'high').fields).toEqual({ think: true });
    });
    it('Claude is left to llmApiHelper', () => {
        expect(resolveThinkingControl(p('https://api.anthropic.com', 'claude-opus-4-7', 'claude'), 'claude', 'off').fields).toEqual({});
    });
});

describe('Gemini', () => {
    const g = (model: string, effort: ThinkingEffort) =>
        resolveThinkingControl(p('https://generativelanguage.googleapis.com/v1beta', model, 'gemini'), 'gemini', effort);

    it('2.5 Flash turns off with a zero budget; 2.5 Pro cannot', () => {
        expect(g('gemini-2.5-flash', 'off').fields).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
        expect(g('gemini-2.5-pro', 'off')).toEqual({ fields: {}, reserveEffort: 'medium' });
        expect(g('gemini-2.5-flash', 'high').fields).toEqual({ thinkingConfig: { thinkingBudget: 8192 } });
    });
    it('3+ drops to minimal (Flash) or low (Pro)', () => {
        expect(g('gemini-3.5-flash', 'off').fields).toEqual({ thinkingConfig: { thinkingLevel: 'MINIMAL' } });
        expect(g('gemini-3.1-pro-preview', 'off').fields).toEqual({ thinkingConfig: { thinkingLevel: 'LOW' } });
        expect(g('gemini-3.5-flash', 'medium').fields).toEqual({ thinkingConfig: { thinkingLevel: 'MEDIUM' } });
    });
    it('Gemma has nothing to switch off', () => {
        expect(g('gemma-4-31b-it', 'off').fields).toEqual({});
    });
});

describe('refusals', () => {
    const control = { fields: { reasoning_effort: 'none' }, reserveEffort: undefined };

    it('counts a 400/422 that names thinking or reasoning', () => {
        expect(isThinkingControlRejection(400, '{"error":"reasoning_effort is not supported for this model"}', control)).toBe(true);
        expect(isThinkingControlRejection(422, 'Unknown field: chat_template_kwargs', control)).toBe(true);
        expect(isThinkingControlRejection(400, 'Thinking level is not supported for this model', control)).toBe(true);
    });
    it('ignores other failures', () => {
        expect(isThinkingControlRejection(400, 'maximum context length exceeded', control)).toBe(false);
        expect(isThinkingControlRejection(500, 'reasoning failed', control)).toBe(false);
        expect(isThinkingControlRejection(400, 'reasoning_effort invalid', { fields: {}, reserveEffort: undefined })).toBe(false);
    });
    it('counts any 400/404 after a model switch', () => {
        expect(isThinkingControlRejection(404, 'model not found', { fields: {}, model: 'a/b', reserveEffort: undefined })).toBe(true);
    });
    it('stops sending the fields to a model that refused them', () => {
        const ds = p('https://api.deepseek.com/v1', 'deepseek-reasoner');
        markThinkingControlRefused(ds);
        expect(resolveThinkingControl(ds, 'openai', 'off')).toEqual({ fields: {}, reserveEffort: 'medium' });
        expect(resolveThinkingControl({ ...ds, modelName: 'deepseek-v4-flash' }, 'openai', 'off').fields).toEqual({ thinking: { type: 'disabled' } });
    });
});

describe('model lists', () => {
    afterEach(() => {
        __setModelCatalogForTests('nanogpt', null);
        __setModelCatalogForTests('openrouter', null);
    });

    it('parses NanoGPT entries and aliases', () => {
        const models = parseNanoGptCatalog({
            data: [
                { id: 'deepseek/deepseek-v4-flash', capabilities: { reasoning: true }, reasoning_efforts: ['none', 'high', 'max'] },
                { id: 'TheDrummer/Cydonia-24B-v4.3', capabilities: { reasoning: false } },
                { id: 'cloudflare/clef', capabilities: { reasoning: true }, aliases: ['clef'] },
                { name: 'no id' },
            ],
        });
        expect(models['deepseek/deepseek-v4-flash']).toEqual({ reasoning: true, efforts: ['none', 'high', 'max'] });
        expect(models['thedrummer/cydonia-24b-v4.3']).toEqual({ reasoning: false });
        expect(models.clef).toBe(models['cloudflare/clef']);
        expect(Object.keys(models)).toHaveLength(4);
    });

    it('parses OpenRouter reasoning blocks', () => {
        const models = parseOpenRouterCatalog({
            data: [
                { id: 'z-ai/glm-5.3', reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['max', 'high', 'low'] }, supported_parameters: ['reasoning'] },
                { id: 'anthropic/claude-opus-4.7', reasoning: { mandatory: false, default_enabled: false, supported_efforts: ['high'] } },
                { id: 'thedrummer/cydonia-24b-v4.1', reasoning: null, supported_parameters: ['temperature'] },
            ],
        });
        expect(models['z-ai/glm-5.3']).toEqual({ reasoning: true, mandatory: true, defaultOn: true, efforts: ['max', 'high', 'low'] });
        expect(models['anthropic/claude-opus-4.7']).toEqual({ reasoning: true, defaultOn: false, efforts: ['high'] });
        expect(models['thedrummer/cydonia-24b-v4.1']).toEqual({ reasoning: false });
    });

    it('looks up OpenRouter routing suffixes by base model', () => {
        __setModelCatalogForTests('openrouter', OPENROUTER);
        expect(lookupCatalogModel(OR_URL, 'moonshotai/kimi-k3:nitro')).toBe(OPENROUTER['moonshotai/kimi-k3']);
        expect(lookupCatalogModel('https://api.deepseek.com', 'deepseek-v4-flash')).toBeUndefined();
    });

    it('buildChatBody uses the list: plain id for a :thinking model, reserve for a must-think one', () => {
        __setModelCatalogForTests('nanogpt', NANO);
        const kimi = buildChatBody(p(NANO_URL, 'moonshotai/kimi-k2.6:thinking'), [{ role: 'user', content: 'x' }], { max_tokens: 10, thinkingEffort: 'off' });
        expect(kimi.model).toBe('moonshotai/kimi-k2.6');
        expect(kimi.max_tokens).toBe(10);
        expect(kimi.reasoning_effort).toBeUndefined();

        const glm = buildChatBody(p(NANO_URL, 'z-ai/glm-5.3'), [{ role: 'user', content: 'x' }], { max_tokens: 10, thinkingEffort: 'off' });
        expect(glm.model).toBe('z-ai/glm-5.3');
        expect(glm.reasoning_effort).toBe('low');
        expect(glm.max_tokens).toBe(4106);
    });
});

describe('llmCall retries once without refused thinking fields', () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    const ok = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
    const sentBody = (call: number) => JSON.parse(fetchMock.mock.calls[call][1].body as string);

    it('drops the fields after a refusal and remembers it', async () => {
        const local = p('http://192.168.1.20:8080/v1', 'strict-model');
        fetchMock
            .mockResolvedValueOnce(new Response('{"error":"Unrecognized request argument: chat_template_kwargs"}', { status: 400 }))
            .mockResolvedValueOnce(ok('YES'))
            .mockResolvedValueOnce(ok('NO'));

        await expect(llmCall(local, 'q', { maxTokens: 10, thinkingEffort: 'off' })).resolves.toBe('YES');
        expect(sentBody(0).chat_template_kwargs).toBeDefined();
        expect(sentBody(1).chat_template_kwargs).toBeUndefined();

        await expect(llmCall(local, 'q2', { maxTokens: 10, thinkingEffort: 'off' })).resolves.toBe('NO');
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sentBody(2).chat_template_kwargs).toBeUndefined();
    });

    it('does not retry an unrelated 400', async () => {
        fetchMock.mockResolvedValueOnce(new Response('{"error":"context length exceeded"}', { status: 400 }));
        await expect(llmCall(p('https://api.deepseek.com/v1', 'deepseek-v4-flash'), 'q', { thinkingEffort: 'off' }))
            .rejects.toThrow(/400/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
