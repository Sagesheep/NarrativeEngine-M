import type { SceneStakes, LLMProvider } from '../../types';
import { llmCall } from '../llm/llmCall';
import { joinPromptSections, TTRPG_PERSONA_STATE_ANALYZER, JSON_ONLY_FOOTER, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER } from '../infrastructure';
import { recordSceneStakesFallback } from '../llm/sceneStakesTelemetry';

const SCENE_STAKES_RE = /\[\[SCENE_STAKES:\s*(calm|tense|dangerous)\s*\]\]/i;
const SCENE_STAKES_ANY_RE = /\[\[SCENE_STAKES:\s*\S+\s*\]\]/i;
const VALID_STAKES: Set<string> = new Set(['calm', 'tense', 'dangerous']);

export function extractAndStripSceneStakes(text: string): { displayText: string; stakes: SceneStakes } {
    const match = text.match(SCENE_STAKES_RE);
    if (!match) {
        const garbled = text.match(SCENE_STAKES_ANY_RE);
        if (garbled) {
            const displayText = text.replace(SCENE_STAKES_ANY_RE, '').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
            return { displayText, stakes: 'calm' };
        }
        return { displayText: text, stakes: 'calm' };
    }
    const raw = match[1].toLowerCase();
    const stakes: SceneStakes = VALID_STAKES.has(raw) ? (raw as SceneStakes) : 'calm';
    const displayText = text.replace(SCENE_STAKES_RE, '').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return { displayText, stakes };
}

export async function classifySceneStakes(
    provider: LLMProvider,
    recentScene: string,
): Promise<SceneStakes> {
    const prompt = joinPromptSections(
        TTRPG_PERSONA_STATE_ANALYZER,
        'TASK: Classify the scene stakes as one of: calm, tense, dangerous.\n' +
        'calm = no immediate threat; tense = physical OR social/political threat looming;\n' +
        'dangerous = active harm or imminent deadly/ruinous consequences.',
        JSON_ONLY_FOOTER,
        'Output ONLY: {"stakes":"calm"} or {"stakes":"tense"} or {"stakes":"dangerous"}',
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,
        recentScene.slice(0, 3000),
    );

    recordSceneStakesFallback();

    try {
        const raw = await llmCall(provider, prompt, {
            priority: 'low',
            maxTokens: 20,
            thinkingEffort: 'off',
            trackingLabel: 'scene-stakes-classify',
            timeoutMs: 30000,
        });
        const cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        const parsed = JSON.parse(cleaned);
        const s = String(parsed.stakes ?? '').toLowerCase();
        if (VALID_STAKES.has(s)) return s as SceneStakes;
    } catch { /* malformed → calm */ }
    return 'calm';
}