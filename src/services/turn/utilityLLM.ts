import type { LLMProvider } from '../../types';
import { llmCall } from '../../utils/llmCall';
import type { UtilityLLM } from './turnTypes';

/**
 * Production adapter for the {@link UtilityLLM} port.
 *
 * Binds utility LLM access to a live endpoint lookup. `getEndpoint` is re-invoked
 * on every `call`/`endpoint` so callers always see the freshest provider (model,
 * api key) — matching the old `state.getUtilityEndpoint?.()` re-fetch pattern.
 */
export function realUtilityLLM(getEndpoint: () => LLMProvider | undefined): UtilityLLM {
    return {
        endpoint: getEndpoint,
        call(prompt, opts) {
            const ep = getEndpoint();
            if (!ep) throw new Error('[UtilityLLM] No utility endpoint configured');
            return llmCall(ep, prompt, opts);
        },
    };
}
