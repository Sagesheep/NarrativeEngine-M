import type { LoreChunk, ArchiveScene } from '../../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { tierAllows } from './aiTier';
import { buildPayload } from '../chatEngine';
import { retrieveRelevantLore, retrieveRelevantRules } from '../lore';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes, deepArchiveScan, recallWithChapterFunnel } from '../archive';
import { offlineStorage } from '../storage';
import { recommendContext } from '../payload';
import { queryFacts, formatFactsForContext, formatResolvedForContext, getDivergenceSceneIds, EMPTY_REGISTER } from '../campaign-state';
import { semanticSearch, semanticSearchScored, isEmbedderReady } from '../embedding';
import type { SearchHit } from '../embedding/vectorSearch';
import { rerankCandidates, type RerankCandidate } from '../payload';
import type { LLMProvider } from '../../types';
import { llmCall } from '../../utils/llmCall';
import {
    countTokens,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ARRAY_ONLY_FOOTER,
    JSON_ONLY_FOOTER,
    TTRPG_PERSONA_RETRIEVAL_PLANNER,
    joinPromptSections,
} from '../infrastructure';

const SEMANTIC_FLOOR_SCENE = 0.30;
const SEMANTIC_FLOOR_LORE = 0.30;

// How long gatherContext waits for the chapter funnel before falling back to
// flat recall. On timeout the funnel is aborted (so its remaining validation
// calls stop spending) and flat recall runs instead — never a turn with zero
// archive memory (AUDIT F1).
const FUNNEL_RACE_TIMEOUT_MS = 5000;

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
    npcLedger: import('../../types').NPCEntry[],
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

        const prompt = joinPromptSections(
            TTRPG_PERSONA_RETRIEVAL_PLANNER,

            `OUTPUT — a single JSON object (example values shown for shape; emit your own based on the input):
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
}`,

            `RULES:
- subQueries: 0-3 alternative phrasings of what to search for. Optional — omit or use [] if the user message is already specific.
- filters.characters: NPC names (from the roster below) that should heavily influence recall. Only include if the user message clearly references them.
- filters.locations / items / concepts: domain entities mentioned or strongly implied.
- filters.eventTypes: any of [combat, discovery, item_acquired, item_lost, relationship_shift, travel, promise, betrayal, death, revelation, quest_milestone, other]. Only include when the user message references that kind of event (e.g. "what did I promise" → ["promise"]).
- sceneIdRange: only set if the user message clearly anchors to a time window (e.g. "back in Waterdeep" → range covering those scenes); otherwise null.
- If nothing is clear, output {} — empty filters is valid. DO NOT hallucinate filters.`,

            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `USER MESSAGE: """${userMessage}"""`,
            `RECENT CONTEXT (last few turns):\n${recentContextText}`,
            `NPC ROSTER:\n${npcRosterText}`,
            `CHAPTER SUMMARY (if any):\n${chapterSummary || '(no chapter summary)'}`,
        );

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

async function expandQuery(query: string, npcLedger: import('../../types').NPCEntry[], utilityEndpoint: LLMProvider, timeoutMs?: number): Promise<string[]> {
    try {
        const npcContext = npcLedger.slice(0, 10).map(n => n.name).join(', ');
        const prompt = joinPromptSections(
            'You are a query expansion assistant for a TTRPG archive search.',

            'Generate 2 alternative phrasings of the user query that expand pronouns, add likely entity names from context, and use synonyms. Output a JSON array of exactly 2 strings.',

            JSON_ARRAY_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `User query: "${query}"`,
            `Known NPCs: ${npcContext}`,
        );

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
    sceneNumber: string | undefined;
    archiveRecall: ArchiveScene[] | undefined;
    semanticArchiveHits: SearchHit[];
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
    let semanticArchiveHits: SearchHit[] = [];
    let semanticLoreIds: string[] | undefined;
    let semanticRuleIds: string[] | undefined;

    const plannerEndpoint = state.getUtilityEndpoint?.();
    let plannerResult: PlannerResult | null = null;
    let plannerPromise: Promise<PlannerResult | null> = Promise.resolve(null);
    if (tierAllows(settings.aiTier, 'planner') && plannerEndpoint?.endpoint) {
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
                (isCallback || isShort) && expansionEndpoint?.endpoint && tierAllows(settings.aiTier, 'expandQuery')
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

            const [sceneHits, loreIds, ruleIds] = await Promise.all([
                semanticSearchScored(activeCampaignId, queries, 'scene', 40, SEMANTIC_FLOOR_SCENE),
                semanticSearch(activeCampaignId, queries, 'lore', 25, SEMANTIC_FLOOR_LORE),
                semanticSearch(activeCampaignId, queries, 'rule', 25, SEMANTIC_FLOOR_LORE),
            ]);
            semanticArchiveIds = sceneHits?.map(h => h.id);
            semanticArchiveHits = sceneHits ?? [];
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
    if (tierAllows(settings.aiTier, 'reranker') && rerankerEndpoint?.endpoint && (semanticArchiveIds?.length || semanticLoreIds?.length)) {
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
                const scoreLookup = new Map(semanticArchiveHits.map(h => [h.id, h.score]));
                semanticArchiveHits = rerankedIds.map((id, i) => ({ id, score: scoreLookup.get(id) ?? (1 - i * 0.05) }));
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
    if (state.context.rulesRaw) {
        const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
        const rulesBudget = Math.floor((settings.contextLimit || 8192) * rulesBudgetPct);
        const threshold = Math.floor(rulesBudget * 1.2);
        const rulesTokenCount = countTokens(state.context.rulesRaw);

        if (rulesTokenCount > threshold) {
            try {
                const { chunkLoreFile } = await import('../lore');
                const ruleChunks = chunkLoreFile(state.context.rulesRaw, 'rule');
                relevantRules = retrieveRelevantRules(
                    ruleChunks,
                    state.context.rulesChunkMeta,
                    finalInput,
                    rulesBudget,
                    messages,
                    semanticRuleIds
                );
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
        } catch (err) {
            console.warn('[TurnContext] Failed to get next scene number:', err);
        }
    }

    // If the embedder path didn't run, still resolve the planner before archive recall.
    if (!plannerResult && tierAllows(settings.aiTier, 'planner') && plannerEndpoint?.endpoint) {
        plannerResult = await plannerPromise;
    }

    const plannerFilters = plannerResult?.filters;

    callbacks.setLoadingStatus?.('[3/5] Recalling Archive Memory...');
    let archiveResult = { scenes: [] as ArchiveScene[], usedTokens: 0 };
    const { chapters, semanticFacts } = state;

    // Size the recall fetch to the world budget it has to live in, so a full
    // recall can't overflow and get dropped whole by trimWorldBlocks (AUDIT F5).
    // Use the non-deep world factor (0.40) — deepContextSummary isn't known yet,
    // and a conservative estimate is the safe side here.
    const contextLimit = settings.contextLimit || 8192;
    const rulesReserve = Math.max(50, Math.floor(contextLimit * (settings.rulesBudgetPct ?? 0.10)));
    const worldBudgetEstimate = Math.floor((contextLimit - rulesReserve) * 0.40);
    const archiveRecallBudget = Math.max(600, Math.min(3000, worldBudgetEstimate));

    // Single source of truth for flat recall — used as the funnel's fallback
    // (on both timeout and error) and as the no-funnel path. Divergence-scene
    // forcing and planner filters are applied here.
    const semanticForRecall = semanticArchiveHits.length > 0 ? semanticArchiveHits : semanticArchiveIds;
    const flatRecallFallback = (): Promise<ArchiveScene[]> =>
        recallArchiveScenes(
            activeCampaignId!, archiveIndex, finalInput, messages, archiveRecallBudget, npcLedger, semanticFacts,
            semanticForRecall, getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), undefined, plannerFilters
        ).then(scenes => scenes || []);

    if (tierAllows(settings.aiTier, 'archiveFunnel') && chapters.length > 0 && activeCampaignId) {
        const funnelAbort = new AbortController();
        try {
            const utilityEndpoint = state.getUtilityEndpoint?.();
            if (!utilityEndpoint) throw new Error('No utility endpoint');
            const funnelPromise = recallWithChapterFunnel(
                activeCampaignId, chapters, archiveIndex, finalInput, messages, npcLedger, semanticFacts, archiveRecallBudget, utilityEndpoint, undefined, semanticForRecall, funnelAbort.signal,
                getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), plannerFilters
            );
            let fallbackTimeoutId: ReturnType<typeof setTimeout>;
            const fallbackPromise = new Promise<{ scenes: string; usedTokens: number } | null>(resolve => {
                fallbackTimeoutId = setTimeout(resolve, FUNNEL_RACE_TIMEOUT_MS) as unknown as ReturnType<typeof setTimeout>;
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
            } else {
                // Funnel lost the race (slow utility endpoint). Abort it so its
                // remaining validation calls stop spending, then fall back to flat
                // recall so the turn still has archive memory (AUDIT F1).
                funnelAbort.abort();
                console.warn(`[Funnel] lost ${FUNNEL_RACE_TIMEOUT_MS}ms race — falling back to flat recall`);
                archiveResult = { scenes: await flatRecallFallback(), usedTokens: 0 };
            }
        } catch (err) {
            funnelAbort.abort();
            console.warn('[Funnel] failed — falling back to flat recall:', err);
            if (activeCampaignId) {
                archiveResult = { scenes: await flatRecallFallback(), usedTokens: 0 };
            }
        }
    } else if (archiveIndex.length > 0 && activeCampaignId) {
        // Covers: (a) no chapters yet, (b) archiveFunnel tier-gated — fall through to engine flat-recall
        archiveResult = { scenes: await flatRecallFallback(), usedTokens: 0 };
    }

    const archiveRecall = archiveResult.scenes.length > 0 ? archiveResult.scenes : undefined;

    // ── Pinned Chapter Injection ──
    if (state.pinnedChapterIds.length > 0 && activeCampaignId) {
        const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));

        const pinnedRanges: [string, string][] = state.pinnedChapterIds
            .map(id => state.chapters.find(c => c.chapterId === id))
            .filter((c): c is import('../../types').ArchiveChapter => !!c)
            .map(c => c.sceneRange);

        if (pinnedRanges.length > 0) {
            try {
                const scoredIds = retrieveArchiveMemory(
                    archiveIndex, finalInput, messages, npcLedger,
                    undefined, semanticFacts, pinnedRanges, semanticArchiveHits.length > 0 ? semanticArchiveHits : semanticArchiveIds,
                    getDivergenceSceneIds(state.divergenceRegister ?? EMPTY_REGISTER), plannerFilters
                ).filter(id => !alreadyCoveredIds.has(id));

                if (scoredIds.length > 0) {
                    // Pinned scenes share the world budget with the recall above —
                    // give them what recall left, not an independent 35% of the whole
                    // context (which used to push the combined block past the world
                    // budget and get it dropped, AUDIT F5).
                    const recallUsed = archiveResult.scenes.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
                    const pinnedBudget = Math.max(0, worldBudgetEstimate - recallUsed);
                    const pinnedScenes = pinnedBudget > 150
                        ? await fetchArchiveScenes(activeCampaignId, scoredIds, pinnedBudget)
                        : [];
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
    if (state.deepContextSearch && tierAllows(settings.aiTier, 'deepScan') && activeCampaignId) {
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
    } catch (err) {
        console.warn('[TurnContext] Failed to query semantic facts:', err);
    }

    try {
        const timeline = state.timeline;
        if (timeline && timeline.length > 0) {
            const { resolveTimeline } = await import('../campaign-state');
            const resolvedText = formatResolvedForContext(resolveTimeline(timeline));
            if (resolvedText) semanticFactText += '\n' + resolvedText;
        }
    } catch (err) {
        console.warn('[TurnContext] Failed to resolve timeline:', err);
    }

    let recommendedNPCNames: string[] | undefined;
    const utilityEndpoint = state.getUtilityEndpoint?.();
    const pinnedChaptersForRecommender = state.pinnedChapterIds.length > 0
        ? state.chapters.filter(c => state.pinnedChapterIds.includes(c.chapterId))
        : undefined;
    if (tierAllows(settings.aiTier, 'recommender') && utilityEndpoint?.endpoint) {
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
        combatState: state.combatState,
        pinnedExcerpts: state.pinnedExcerpts,
    });

    return { relevantLore, relevantRules, sceneNumber, archiveRecall: finalArchiveRecall, semanticArchiveHits, semanticFactText, recommendedNPCNames, deepContextSummary, payloadResult };
}
