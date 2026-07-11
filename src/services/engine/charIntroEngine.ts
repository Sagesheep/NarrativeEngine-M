import type { GameContext, CharacterIntroEntry, ChatMessage, LLMProvider } from '../../types';
import { llmCall } from '../llm/llmCall';
import { INPUT_DELIMITER } from '../infrastructure';

export type CharIntroResult = {
    tag: string;
    newDC: number;
};

const LOCATION_PROMPT = `Based on the following scene, what is the party's current location? Reply with only the location name, nothing else.`;

function extractLocationFromResponse(response: string): string {
    const cleaned = response.trim();
    const thinkMatch = cleaned.match(/<think>[\s\S]*?<\/think>/i);
    if (thinkMatch) {
        const afterThink = cleaned.slice(thinkMatch.index! + thinkMatch[0].length).trim();
        return afterThink || cleaned;
    }
    return cleaned;
}

async function resolveLocation(
    messages: ChatMessage[],
    provider: LLMProvider
): Promise<string> {
    const recent = messages.slice(-10);
    const excerpt = recent.map(m => {
        const role = m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
        return `[${role}]: ${(m.content || '').slice(0, 400)}`;
    }).join('\n\n');

    try {
        const raw = await llmCall(provider, `${LOCATION_PROMPT}\n\n${INPUT_DELIMITER}\n\n${excerpt}`, {
            temperature: 0.1,
            priority: 'high',
            maxTokens: 100,
        });
        return extractLocationFromResponse(raw);
    } catch (err) {
        console.warn('[CharIntroEngine] Location AI call failed:', err);
        return '';
    }
}

function scanBoostKeywords(
    characters: CharacterIntroEntry[],
    messages: ChatMessage[]
): Map<string, number> {
    const weights = new Map<string, number>();
    const recentAssistant = messages
        .filter(m => m.role === 'assistant')
        .slice(-3)
        .map(m => (m.content || '').toLowerCase());

    for (const entry of characters) {
        if (!entry.boostKeywords || entry.boostKeywords.length === 0) {
            weights.set(entry.name, 1);
            continue;
        }
        let boosted = false;
        for (const kw of entry.boostKeywords) {
            const kwLower = kw.toLowerCase();
            for (const text of recentAssistant) {
                if (text.includes(kwLower)) {
                    boosted = true;
                    break;
                }
            }
            if (boosted) break;
        }
        weights.set(entry.name, boosted ? 3 : 1);
    }
    return weights;
}

function weightedRandomPick(entries: CharacterIntroEntry[], weights: Map<string, number>): CharacterIntroEntry | null {
    const totalWeight = entries.reduce((sum, e) => sum + (weights.get(e.name) ?? 1), 0);
    let roll = Math.random() * totalWeight;
    for (const entry of entries) {
        const w = weights.get(entry.name) ?? 1;
        roll -= w;
        if (roll <= 0) return entry;
    }
    return entries[entries.length - 1] ?? null;
}

export async function rollCharacterIntroEngine(
    context: GameContext,
    seenNpcNames: string[],
    messages: ChatMessage[],
    utilityProvider?: LLMProvider
): Promise<CharIntroResult> {
    const config = context.npcIntroConfig;
    if (!config || config.characters.length === 0 || context.npcIntroEngineActive === false) {
        return { tag: '', newDC: context.npcIntroDC ?? config?.initialDC ?? 196 };
    }

    const currentDC = context.npcIntroDC ?? config.initialDC;
    const roll = Math.floor(Math.random() * 200) + 1;

    if (roll < currentDC) {
        const decayed = Math.max(5, currentDC - config.dcReduction);
        return { tag: '', newDC: decayed };
    }

    const candidates = config.characters.filter(c => !seenNpcNames.includes(c.name));
    if (candidates.length === 0) {
        return { tag: '', newDC: currentDC };
    }

    const wanderingPool = candidates.filter(c => c.type === 'wandering' || c.type === 'wandering+boosted');
    let locationPool = candidates.filter(c => c.type === 'location' || c.type === 'location+boosted');

    if (locationPool.length > 0 && utilityProvider) {
        const aiLocation = await resolveLocation(messages, utilityProvider);
        if (aiLocation) {
            const aiLocLower = aiLocation.toLowerCase();
            locationPool = locationPool.filter(c =>
                c.location && aiLocLower.includes(c.location.toLowerCase())
            );
        } else {
            locationPool = [];
        }
    } else if (locationPool.length > 0 && !utilityProvider) {
        locationPool = [];
    }

    const pool = [...wanderingPool, ...locationPool];
    if (pool.length === 0) {
        return { tag: '', newDC: currentDC };
    }

    const weights = scanBoostKeywords(pool, messages);
    const picked = weightedRandomPick(pool, weights);
    if (!picked) {
        return { tag: '', newDC: currentDC };
    }

    const tag = `[INTRODUCE CHARACTER: ${picked.name}]`;
    const resetDC = config.initialDC;
    console.log(`[CharIntroEngine] Triggered! Introducing: ${picked.name} (type=${picked.type}). Resetting DC to ${resetDC}`);

    return { tag, newDC: resetDC };
}