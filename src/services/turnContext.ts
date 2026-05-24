import type { LoreChunk, ArchiveScene } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { buildPayload } from './chatEngine';
import { retrieveRelevantLore } from './loreRetriever';
import { retrieveRelevantRules } from './rulesRetriever';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';
import { countTokens } from './tokenizer';
import { offlineStorage } from './storage';
import { recommendContext } from './contextRecommender';
import { deepArchiveScan } from './deepArchiveSearch';
import { queryFacts, formatFactsForContext } from './semanticMemory';
import { semanticSearch } from './vectorSearch';
import { isEmbedderReady } from './embedder';
import { formatResolvedForContext } from './timelineResolver';
import { recallWithChapterFunnel } from './archiveChapterEngine';
import { getDivergenceSceneIds } from './divergenceRegister';
import { EMPTY_REGISTER } from './divergenceRegister';
import { rerankCandidates, type RerankCandidate } from './semanticReranker';
import type { LLMProvider } from '../types';
import { llmCall } from '../utils/llmCall';

const SEMANTIC_FLOOR_SCENE = 0.30;
const SEMANTIC_FLOOR_LORE = 0.30;

const CALLBACK_REGEX = /\b(remember|earlier|back when|before|previously|that .*(we|i) (did|met|fought|saw|found|got))\b/i;

type PlannerResult = {
    subQueries?: string[];
    filters?: {
        characters?: string[];
        locations?: string[];
        items?: string[];
        concepts?: string[];
        eventTypes?: string[];
    };
    sceneIdRange?: [string, string] | null;
};

export async function runPlannerCall(
    userMessage: string,
    recentMessages: Array<{ role?: string; content?: string }>,
    npcLedger: import('../types').NPCEntry[],
    chapterSummary: string | undefined,
    utilityEndpoint: LLMProvider,
    timeoutSeconds?: number,
): Promise<PlannerResult | null> {
    try {
        const timeoutMs = (timeoutSeconds ?? 45) * 1000;

        const recentContextText = recentMessages
            .slice(-8)
            .map(m => `${m.role === 'assistant' ? 'GM' : 'Player'}: ${(m.content ?? '').slice(0, 200)}`)
            .join('\n');

        const npcRosterText = npcLedger.slice(0, 30).map(n => `${n.id}: ${n.name}`).join('\n') || '(none)';

        const prompt = `You are a retrieval planner for a TTRPG campaign archive. Output a JSON object that helps focus memory recall for the GM's next turn.

USER MESSAGE: """${userMessage}"""

RECENT CONTEXT (last few turns):
${recentContextText}

NPC ROSTER:
${npcRosterText}

CHAPTER SUMMARY (if any):
${chapterSummary || '(no chapter summary)'}

OUTPUT — a single JSON object:
{
  "subQueries": ["query rephrase 1", "query rephrase 2"],
  "filters": {
    "characters": ["Astarion"],
    "locations": ["Baldur's Gate"],
    "items": [],
    "concepts": [],
    "eventTypes": ["promise", "betrayal"]
  },
  "sceneIdRange": null
}

RULES:
- subQueries: 0-3 alternative phrasings of what to search for. Optional — omit or use [] if the user message is already specific.
- filters.characters: NPC names (from the roster above) that should heavily influence recall. Only include if the user message clearly references them.
- filters.locations / items / concepts: domain entities mentioned or strongly implied.
- filters.eventTypes: any of [combat, discovery, item_acquired, item_lost, relationship_shift, travel, promise, betrayal, death, revelation, quest_milestone, other]. Only include when the user message references that kind of event (e.g. "what did I promise" → ["promise"]).
- sceneIdRange: only set if the user message clearly anchors to a time window (e.g. "back in Waterdeep" → range covering those scenes); otherwise null.
- If nothing is clear, output {} — empty filters is valid. DO NOT hallucinate filters.

Respond with ONE JSON object only. No prose, no markdown fences.`;

        const raw = await llmCall(utilityEndpoint, prompt, {
            temperature: 0.1,
            priority: 'high',
            maxTokens: 400,
            timeoutMs,
            trackingLabel: 'planner',
        });

        let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const braceStart = clean.indexOf('{');
        const braceEnd = clean.lastIndexOf('}');
        if (braceStart === -1 || braceEnd === -1) return null;

        const parsed: PlannerResult = JSON.parse(clean.substring(braceStart, braceEnd + 1));
        return parsed;
    } catch {
        return null;
    }
}

async function expandQuery(query: string, npcLedger: import('../types').NPCEntry[], utilityEndpoint: LLMProvider, timeoutMs?: number): Promise<string[]> {
    try {
        const npcContext = npcLedger.slice(0, 10).map(n => n.name).join(', ');
        const prompt = `User query: "${query}"
Known NPCs: ${npcContext}
Generate 2 alternative phrasings that expand pronouns, add likely entity names from context, and use synonyms. Return ONLY a JSON array of 2 strings. No prose.`;

        const raw = await llmCall(utilityEndpoint, prompt, {
            temperature: 0.2,
            priority: 'high',
            maxTokens: 200,
            ...(timeoutMs ? { timeoutMs, trackingLabel: 'expandQuery' } : {}),
        });

        let clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const bracketStart = clean.indexOf('[');
        const bracketEnd = clean.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1) return [query];

        const parsed = JSON.parse(clean.substring(bracketStart, bracketEnd + 1));
        if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((x: unknown) => typeof x === 'string')) {
            return [query, parsed[0], parsed[1]];
        }
        return [query];
    } catch {
        return [query];
    }
}


export type GatheredContext = {
    relevantLore: LoreChunk[] | undefined;
    relevantRules: LoreChunk[] | undefined;
    rulesManifest: string;
    sceneNumber: string | undefined;
    archiveRecall: ArchiveScene[] | undefined;
    semanticFactText: string;
    recommendedNPCNames: string[] | undefined;
    deepContextSummary: string | undefined;
    payloadResult: ReturnType<typeof buildPayload>;
};

export async function gatherContext(
    state: TurnState,
    callbacks: TurnCallbacks,
    finalInput: string,
    userMsgId: string
): Promise<GatheredContext> {
    const { settings, loreChunks, npcLedger, archiveIndex, activeCampaignId } = state;
    const utilityTimeoutMs = (settings.utilityTimeoutSeconds ?? 45) * 1000;
    let semanticArchiveIds: string[] | undefined;
    let semanticLoreIds: string[] | undefined;
    let semanticRuleIds: string[] | undefined;

    const plannerEndpoint = state.getUtilityEndpoint?.();
    let plannerResult: PlannerResult | null = null;
    let plannerPromise: Promise<PlannerResult | null> = Promise.resolve(null);
    if (plannerEndpoint?.endpoint) {
        const recentForPlanner = state.getMessages().filter(m => m.id !== userMsgId).slice(-8);
        const chapterSummary = state.chapters.length > 0 ? state.chapters[state.chapters.length - 1].summary : undefined;
        plannerPromise = runPlannerCall(finalInput, recentForPlanner, npcLedger, chapterSummary, plannerEndpoint, settings.utilityTimeoutSeconds);
    }

    if (isEmbedderReady() && activeCampaignId) {
        try {
            let queries = [finalInput];
            const isCallback = CALLBACK_REGEX.test(finalInput);
            const isShort = finalInput.trim().split(/\s+/).length < 8;
            const expansionEndpoint = state.getUtilityEndpoint?.();

            const [resolvedPlanner, expandedQueries] = await Promise.all([
                plannerPromise,
                (isCallback || isShort) && expansionEndpoint?.endpoint
                    ? expandQuery(finalInput, npcLedger, expansionEndpoint, utilityTimeoutMs)
                    : Promise.resolve([finalInput]),
            ]);

            plannerResult = resolvedPlanner;
            queries = expandedQueries;
            if (expandedQueries.length > 1) {
                console.log(`[QueryExpansion] "${finalInput}" → ${expandedQueries.length} variants`);
            }

            if (plannerResult?.subQueries?.length) {
                const newSubs = plannerResult.subQueries.filter(q => !queries.includes(q));
                queries = [...queries, ...newSubs];
                console.log(`[Planner] Added ${newSubs.length} sub-queries`);
            }

            const [sceneIds, loreIds, ruleIds] = await Promise.all([
                semanticSearch(activeCampaignId, queries, 'scene', 40, SEMANTIC_FLOOR_SCENE),
                semanticSearch(activeCampaignId, queries, 'lore', 25, SEMANTIC_FLOOR_LORE),
                semanticSearch(activeCampaignId, queries, 'rule', 25, SEMANTIC_FLOOR_LORE),
            ]);
            semanticArchiveIds = sceneIds;
            semanticLoreIds = loreIds;
            semanticRuleIds = ruleIds;

            if (semanticArchiveIds?.length) console.log(`[Semantic] Found ${semanticArchiveIds.length} scene candidates`);
            if (semanticLoreIds?.length) console.log(`[Semantic] Found ${semanticLoreIds.length} lore candidates`);
            if (semanticRuleIds?.length) console.log(`[Semantic] Found ${semanticRuleIds.length} rule candidates`);
        } catch (e) {
            console.warn('[Semantic] Candidate search failed, using keyword fallback:', e);
        }
    }

    const rerankerEndpoint = state.getUtilityEndpoint?.();
    if (rerankerEndpoint?.endpoint && (semanticArchiveIds?.length || semanticLoreIds?.length)) {
        try {
            if (semanticArchiveIds && semanticArchiveIds.length >= 5) {
                const sceneCandidates: RerankCandidate[] = semanticArchiveIds.map(id => {
                    const idxEntry = archiveIndex.find(e => e.sceneId === id);
                    return {
                        id,
                        summary: idxEntry ? `${idxEntry.userSnippet} — ${idxEntry.keywords.slice(0, 5).join(', ')}` : id,
                        type: 'scene' as const,
                    };
                });
                const rerankedIds = await rerankCandidates(finalInput, sceneCandidates, rerankerEndpoint, { maxCandidates: 30, topN: 12, timeoutMs: utilityTimeoutMs, trackingLabel: 'rerank-scene' });
                semanticArchiveIds = rerankedIds;
                console.log(`[Reranker] Scene candidates: ${rerankedIds.length} after rerank`);
            }

            if (semanticLoreIds && semanticLoreIds.length >= 5) {
                const loreCandidates: RerankCandidate[] = semanticLoreIds.map(id => {
                    const chunk = loreChunks.find(c => c.id === id);
                    return {
                        id,
                        summary: chunk ? `${chunk.header} — ${chunk.summary || chunk.content.slice(0, 80)}` : id,
                        type: 'lore' as const,
                    };
                });
                const rerankedLoreIds = await rerankCandidates(finalInput, loreCandidates, rerankerEndpoint, { maxCandidates: 25, topN: 10, timeoutMs: utilityTimeoutMs, trackingLabel: 'rerank-lore' });
                semanticLoreIds = rerankedLoreIds;
                console.log(`[Reranker] Lore candidates: ${rerankedLoreIds.length} after rerank`);
            }
        } catch (err) {
            console.warn('[Reranker] Failed, using semantic order:', err);
        }
    }

    const messages = state.getMessages().filter(m => m.id !== userMsgId);
    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, finalInput, 1200, messages, semanticLoreIds)
        : undefined;

    let relevantRules: LoreChunk[] | undefined;
    let rulesManifest = '';
    if (state.context.rulesRaw) {
        const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
        const rulesBudget = Math.floor((settings.contextLimit || 8192) * rulesBudgetPct);
        const threshold = Math.floor(rulesBudget * 1.2);
        const rulesTokenCount = countTokens(state.context.rulesRaw);

        if (rulesTokenCount > threshold) {
            try {
                const { chunkLoreFile } = await import('./loreChunker');
                const ruleChunks = chunkLoreFile(state.context.rulesRaw, 'rule');
                const result = retrieveRelevantRules(
                    ruleChunks,
                    state.context.rulesChunkMeta,
                    finalInput,
                    rulesBudget,
                    messages,
                    semanticRuleIds
                );
                relevantRules = result.selected;
                rulesManifest = result.manifest;
                if (relevantRules.length > 0) {
                    console.log(`[RulesRAG] Retrieved ${relevantRules.length}/${ruleChunks.length} rule chunks`);
                }
            } catch (e) {
                console.warn('[RulesRAG] Retrieval failed, falling back to verbatim:', e);
            }
        }
    }

    let sceneNumber: string | undefined;
    if (activeCampaignId) {
        callbacks.setLoadingStatus?.('[2/5] Fetching Timeline...');
        try {
            const nextScene = await offlineStorage.archive.getNextSceneNumber(activeCampaignId);
            sceneNumber = String(nextScene).padStart(3, '0');
        } catch { /* ignored */ }
    }

    // If the embedder path didn't run, still resolve the planner before archive recall.
    if (!plannerResult && plannerEndpoint?.endpoint) {
        plannerResult = await plannerPromise;
    }

    const plannerFilters = plannerResult?.filters;
    const plannerSceneRanges: [string, string][] | undefined =
        plannerResult?.sceneIdRange ? [plannerResult.sceneIdRange] : undefined;

    callbacks.setLoadingStatus?.('[3/5] Recalling Archive Memory...');
    let archiveResult = { scenes: [] as ArchiveScene[], usedTokens: 0 };
    const { chapters, semanticFacts } = state;

    if (chapters.length > 0 && activeCampaignId) {
        try {
            const utilityEndpoint = state.getUtilityEndpoint?.();
            if (!utilityEndpoint) throw new Error('No utility endpoint');
            const funnelPromise = recallWithChapterFunnel(
                activeCampaignId, chapters, archiveIndex, finalInput, messages, npcLedger, semanticFacts, 3000, utilityEndpoint, undefined, semanticArchiveIds
            );
            let fallbackTimeoutId: ReturnType<typeof setTimeout>;
            const fallbackPromise = new Promise<{ scenes: string; usedTokens: number } | null>(resolve => {
                fallbackTimeoutId = setTimeout(resolve, 5000) as unknown as ReturnType<typeof setTimeout>;
            }).then(() => null);

            const result = await Promise.race([
                funnelPromise.finally(() => clearTimeout(fallbackTimeoutId)),
                fallbackPromise
            ]);
            if (result) {
                archiveResult = { scenes: [] as ArchiveScene[], usedTokens: result.usedTokens };
                const sceneMatches = (result.scenes as string).match(/--- SCENE (\d+) ---\n([\s\S]*?)(?=\n--- SCENE \d+ ---|$)/g);
                if (sceneMatches) {
                    archiveResult.scenes = sceneMatches.map(match => {
                        const idMatch = match.match(/--- SCENE (\d+) ---/);
                        const content = match.replace(/--- SCENE \d+ ---\n/, '').trim();
                        return { sceneId: idMatch ? idMatch[1] : '', content, tokens: countTokens(content) };
                    });
                }
            }
        } catch {
            if (activeCampaignId) {
                const flatRecall = await recallArchiveScenes(activeCampaignId, archiveIndex, finalInput, messages, 3000, npcLedger, semanticFacts, semanticArchiveIds, getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), undefined, plannerFilters);
                archiveResult = { scenes: flatRecall || [], usedTokens: 0 };
            }
        }
    } else if (archiveIndex.length > 0 && activeCampaignId) {
        const flatRecall = await recallArchiveScenes(
            activeCampaignId, archiveIndex, finalInput, messages, 3000, npcLedger, semanticFacts, semanticArchiveIds, getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), undefined, plannerFilters
        );
        archiveResult = { scenes: flatRecall || [], usedTokens: 0 };
    }

    const archiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    // ── Pinned Chapter Injection ──
    if (state.pinnedChapterIds.length > 0 && activeCampaignId) {
        const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));

        const pinnedRanges: [string, string][] = state.pinnedChapterIds
            .map(id => state.chapters.find(c => c.chapterId === id))
            .filter((c): c is import('../types').ArchiveChapter => !!c)
            .map(c => c.sceneRange);

        if (pinnedRanges.length > 0) {
            try {
                const scoredIds = retrieveArchiveMemory(
                    archiveIndex, finalInput, messages, npcLedger,
                    undefined, semanticFacts, pinnedRanges, semanticArchiveIds,
                    undefined, plannerFilters
                ).filter(id => !alreadyCoveredIds.has(id));

                if (scoredIds.length > 0) {
                    const pinnedBudget = Math.floor((settings.contextLimit || 8192) * 0.35);
                    const pinnedScenes = await fetchArchiveScenes(activeCampaignId, scoredIds, pinnedBudget);
                    archiveResult.scenes = [...(archiveResult.scenes ?? []), ...pinnedScenes];
                    console.log(`[Pin] Injected ${pinnedScenes.length} scored scenes from ${pinnedRanges.length} pinned chapter(s)`);
                }
            } catch (err) {
                console.warn('[Pin] Failed to fetch pinned scenes:', err);
            }
        }
        state.clearPinnedChapters();
    }

    // ── Deep Archive Scan (one-shot when GM long-presses Send) ──
    let deepContextSummary: string | undefined;
    if (state.deepContextSearch && activeCampaignId) {
        const utilityForDeep = state.getUtilityEndpoint?.();
        if (utilityForDeep?.endpoint) {
            try {
                const sealedChapters = (state.chapters ?? []).filter(c => c.sealedAt !== undefined);
                const deepBudget = Math.floor((settings.contextLimit || 8192) * 0.45);
                const brief = await deepArchiveScan(
                    utilityForDeep,
                    archiveIndex,
                    sealedChapters,
                    activeCampaignId,
                    state.getMessages().filter(m => m.id !== userMsgId),
                    finalInput,
                    deepBudget,
                    (msg) => callbacks.setLoadingStatus?.(msg),
                );
                if (brief) deepContextSummary = brief;
            } catch (err) {
                console.warn('[DeepArchiveSearch] Failed, using standard recall:', err);
            }
        } else {
            console.warn('[DeepArchiveSearch] No utility endpoint configured — deep scan skipped.');
        }
    }

    const finalArchiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    let semanticFactText = '';
    try {
        semanticFactText = formatFactsForContext(queryFacts(semanticFacts, finalInput, messages, npcLedger, 500));
    } catch {}

    try {
        const timeline = state.timeline;
        if (timeline && timeline.length > 0) {
            const { resolveTimeline } = await import('./timelineResolver');
            const resolvedText = formatResolvedForContext(resolveTimeline(timeline));
            if (resolvedText) semanticFactText += '\n' + resolvedText;
        }
    } catch {}

    let recommendedNPCNames: string[] | undefined;
    const utilityEndpoint = state.getUtilityEndpoint?.();
    const pinnedChaptersForRecommender = state.pinnedChapterIds.length > 0
        ? state.chapters.filter(c => state.pinnedChapterIds.includes(c.chapterId))
        : undefined;
    if (utilityEndpoint?.endpoint) {
        callbacks.setLoadingStatus?.('[4/5] Consulting AI Recommender...');
        try {
            const recommenderResult = await recommendContext(utilityEndpoint, npcLedger, loreChunks, messages, finalInput, pinnedChaptersForRecommender, utilityTimeoutMs);
            if (recommenderResult) {
                recommendedNPCNames = recommenderResult.relevantNPCNames;

                // Inject lore chunks the recommender picked that keyword/semantic retrieval missed
                const { relevantLoreIds } = recommenderResult;
                if (relevantLoreIds.length > 0 && loreChunks.length > 0 && relevantLore) {
                    const alreadyIn = new Set(relevantLore.map(c => c.id));
                    const RECOMMENDER_EXTRA_BUDGET = 600;
                    let extraTokens = 0;

                    for (const id of relevantLoreIds) {
                        const chunk = loreChunks.find(c => c.id === id);
                        if (!chunk || alreadyIn.has(chunk.id) || chunk.alwaysInclude) continue;
                        if (extraTokens + chunk.tokens > RECOMMENDER_EXTRA_BUDGET) continue;
                        relevantLore.push(chunk);
                        alreadyIn.add(chunk.id);
                        extraTokens += chunk.tokens;
                    }

                    if (extraTokens > 0) console.log(`[TurnContext] Recommender injected lore (${extraTokens} extra tokens)`);
                }
            }
        } catch (err) {
            console.warn('[TurnOrchestrator] UtilityAI recommender failed:', err);
        }
    }

    const freshMessages = state.getMessages().filter(m => m.id !== userMsgId);
    callbacks.setLoadingStatus?.('[5/5] Architecting AI Prompt...');

    let semanticallyRecalledNpcIds: string[] = [];
    if (isEmbedderReady() && npcLedger && npcLedger.length > 0 && activeCampaignId) {
        try {
            const recentContext = freshMessages.slice(-3).map(m => m.content || '').filter(Boolean);
            const queryTexts = [...recentContext, finalInput].filter(t => t.length > 0).slice(-4);
            if (queryTexts.length > 0) {
                const hits = await semanticSearch(activeCampaignId, queryTexts, 'npc', 5, 0.4);
                if (hits && hits.length > 0) {
                    semanticallyRecalledNpcIds = hits;
                    console.log(`[NPC] semantic recall hits=[${hits.join(',')}] query="${finalInput.slice(0, 60)}..."`);
                }
            }
        } catch (e) {
            console.warn('[TurnContext] NPC semantic recall failed:', e);
        }
    }

    const { condenser } = state;

    const payloadResult = buildPayload({
        settings,
        context: state.context,
        history: freshMessages,
        userMessage: finalInput,
        condensedUpToIndex: condenser.condensedUpToIndex,
        relevantLore,
        relevantRules,
        rulesManifest,
        npcLedger,
        archiveRecall: finalArchiveRecall,
        onStageNpcIds: state.onStageNpcIds,
        sceneNumber,
        recommendedNPCNames,
        semanticFactText,
        deepContextSummary,
        divergenceRegister: state.divergenceRegister,
        chapters: state.chapters,
        archiveIndex: state.archiveIndex,
        semanticallyRecalledNpcIds,
    });

    return { relevantLore, relevantRules, rulesManifest, sceneNumber, archiveRecall: finalArchiveRecall, semanticFactText, recommendedNPCNames, deepContextSummary, payloadResult };
}
