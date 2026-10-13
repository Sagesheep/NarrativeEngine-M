import { describe, expect, it } from 'vitest';
import { buildChatBody, withThinkingReserve, CLAUDE_BUDGET_MAP } from '../llmApiHelper';
import type { ApiFormat, LLMProvider, ThinkingEffort } from '../../types';

const messages = [{ role: 'user', content: 'Hello' }];
const reasoningEfforts: Exclude<ThinkingEffort, 'off'>[] = ['low', 'medium', 'high', 'max'];

function provider(apiFormat: ApiFormat, endpoint: string): LLMProvider {
    return { id: apiFormat, label: apiFormat, endpoint, apiKey: 'k', modelName: 'm', apiFormat };
}
const claude = provider('claude', 'https://api.anthropic.com');
const gemini = provider('gemini', 'https://generativelanguage.googleapis.com/v1beta');
const openai = provider('openai', 'https://api.openai.com/v1');
const deepseek = provider('openai', 'https://api.deepseek.com/v1');
const ollama = provider('ollama', 'http://localhost:11434');

describe('thinking token reserve', () => {
    it('leaves thinking-off request bodies unchanged', () => {
        for (const p of [claude, gemini, openai, deepseek, ollama]) {
            const inheritedOff = buildChatBody({ ...p, thinkingEffort: 'off' }, messages, { max_tokens: 800 });
            const explicitOff = buildChatBody({ ...p, thinkingEffort: 'high' }, messages, { max_tokens: 800, thinkingEffort: 'off' });
            expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(inheritedOff));
        }
    });

    it('keeps Claude answer room above its thinking budget', () => {
        for (const effort of reasoningEfforts) {
            for (const answer of [10, 500, 4096]) {
                const body = buildChatBody(claude, messages, { max_tokens: answer, thinkingEffort: effort });
                const thinking = body.thinking as { budget_tokens: number };
                expect(body.max_tokens).toBe(answer + CLAUDE_BUDGET_MAP[effort]);
                expect(body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
            }
        }
    });

    it('gives a small utility call thinking headroom on OpenAI-style endpoints (inherited effort)', () => {
        for (const p of [openai, deepseek]) {
            const body = buildChatBody({ ...p, thinkingEffort: 'high' }, messages, { max_tokens: 200 });
            expect(body.max_tokens).toBe(8192);
        }
    });

    it('adds headroom to Gemini maxOutputTokens when thinking is on', () => {
        const body = buildChatBody(gemini, messages, { max_tokens: 200, thinkingEffort: 'low' });
        const config = body.generationConfig as { maxOutputTokens: number; thinkingConfig: unknown };
        expect(config.maxOutputTokens).toBe(4296);
        expect(config.thinkingConfig).toBeDefined();
    });

    it('never lowers a large requested answer', () => {
        expect(withThinkingReserve('openai', 'high', 20000)).toBe(20000);
        expect(withThinkingReserve('gemini', 'max', 16384)).toBe(16384);
    });

    it('leaves Ollama and thinking-off caps alone', () => {
        expect(withThinkingReserve('ollama', 'high', 200)).toBe(200);
        expect(withThinkingReserve('openai', 'off', 200)).toBe(200);
        expect(withThinkingReserve('claude', undefined, 200)).toBe(200);
    });
});
