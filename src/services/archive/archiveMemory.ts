import type { ArchiveIndexEntry, ArchiveScene, ChatMessage, NPCEntry, SemanticFact } from '../../types';
import type { SearchHit } from '../embedding/vectorSearch';
import { countTokens } from '../infrastructure';
import { offlineStorage } from '../storage';

/**
 * archiveMemory.ts
 *
 * T4 Memory — Index-based retrieval over lossless .archive.md content.
 *
 * Hybrid recall: IDF-weighted keyword ranking fused with embedding ranking via RRF.
 * Keywords are down-weighted by IDF so common terms count less than rare distinctive ones.
 * Embeddings and keywords are two independent rankers fused by Reciprocal Rank Fusion.
 */

// ─── IDF Computation ───

let _idfCache: { sig: string; idf: Record<string, number> } | null = null;

function indexSignature(index: ArchiveIndexEntry[]): string {
    if (index.length === 0) return '';
    const first = index[0].sceneId;
    const last = index[index.length - 1].sceneId;
    const tsLast = index[index.length - 1].timestamp;
    return `${index.length}:${first}:${last}:${tsLast}`;
}

export function computeArchiveIdf(index: ArchiveIndexEntry[]): Record<string, number> {
    const sig = indexSignature(index);
    if (_idfCache && _idfCache.sig === sig) return _idfCache.idf;

    const N = index.length;
    const df: Record<string, number> = {};

    for (const entry of index) {
        const seen = new Set<string>();
        const kwStrengths = entry.keywordStrengths ?? {};
        const npcStrengths = entry.npcStrengths ?? {};
        if (Object.keys(kwStrengths).length > 0 || Object.keys(npcStrengths).length > 0) {
            for (const kw of Object.keys(kwStrengths)) {
                const k = kw.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
            for (const npc of Object.keys(npcStrengths)) {
                const k = npc.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
        } else {
            for (const kw of entry.keywords) {
                const k = kw.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
            for (const npc of entry.npcsMentioned) {
                const k = npc.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
        }
    }

    const idf: Record<string, number> = {};
    for (const [term, count] of Object.entries(df)) {
        idf[term] = Math.log(1 + (N - count + 0.5) / (count + 0.5));
    }

    _idfCache = { sig, idf };
    return idf;
}

export function clearIdfCache(): void {
    _idfCache = null;
}

// ─── Keyword Relevance Scoring ───

type ScoreResult = {
    keywordRelevance: number;
    recency: number;
    importance: number;
};

function scoreEntry(
    entry: ArchiveIndexEntry,
    contextText: string,
    contextActivations: Record<string, number>,
    totalScenes: number,
    idf: Record<string, number>
): ScoreResult {
    const sceneNum = parseInt(entry.sceneId, 10) || 0;
    const turnsSince = totalScenes - sceneNum;
    const halfLife = Math.max(40, 0.2 * totalScenes);
    const recency = Math.pow(0.5, Math.max(0, turnsSince) / halfLife);

    const importance = entry.importance ?? 5;

    let keywordRelevance = 0;
    const kwStrengths = entry.keywordStrengths ?? {};
    for (const [keyword, strength] of Object.entries(kwStrengths)) {
        if (contextActivations[keyword]) {
            const idfWeight = idf[keyword] ?? 1;
            keywordRelevance += contextActivations[keyword] * strength * idfWeight;
        }
    }
    const npcStrengths = entry.npcStrengths ?? {};
    for (const [npc, strength] of Object.entries(npcStrengths)) {
        if (contextActivations[npc]) {
            const idfWeight = idf[npc] ?? 1;
            keywordRelevance += contextActivations[npc] * strength * 1.5 * idfWeight;
        }
    }

    if (entry.events && entry.events.length > 0) {
        let eventActivation = 0;
        for (const event of entry.events) {
            const eventImportanceScale = (event.importance ?? 5) / 10;
            let perEvent = 0;
            for (const name of (event.characters ?? [])) {
                const key = name.toLowerCase();
                if (contextActivations[key]) {
                    const idfWeight = idf[key] ?? 1;
                    perEvent += contextActivations[key] * 1.5 * idfWeight;
                }
            }
            for (const fieldNames of [event.locations ?? [], event.items ?? [], event.concepts ?? []]) {
                for (const name of fieldNames) {
                    const key = name.toLowerCase();
                    if (contextActivations[key]) {
                        const idfWeight = idf[key] ?? 1;
                        perEvent += contextActivations[key] * 1.0 * idfWeight;
                    }
                }
            }
            eventActivation += perEvent * eventImportanceScale;
        }
        keywordRelevance += Math.min(15, eventActivation);
    }

    if (Object.keys(kwStrengths).length === 0 && Object.keys(npcStrengths).length === 0 && !(entry.events && entry.events.length > 0)) {
        for (const kw of entry.keywords) {
            const k = kw.toLowerCase();
            if (contextText.includes(k)) {
                const exactMatch = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                const idfWeight = idf[k] ?? 1;
                keywordRelevance += (exactMatch.test(contextText) ? 2 : 0.5) * idfWeight;
            }
        }
        for (const npc of entry.npcsMentioned) {
            const k = npc.toLowerCase();
            if (contextText.includes(k)) {
                const idfWeight = idf[k] ?? 1;
                keywordRelevance += 3 * idfWeight;
            }
        }
    }

    return { keywordRelevance, recency, importance };
}

/**
 * Extract graded context activations from the current conversation.
 * Returns a map of keyword -> activation weight (0-1).
 * User message = 1.0, last 3 assistant messages = 0.7, last 10 messages = 0.3.
 */
export function extractContextActivations(
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[]
): Record<string, number> {
    const activations: Record<string, number> = {};

    // 2-char minimum to capture short NPC names common in fantasy settings (e.g. "Xi", "Ka", "Al")
    const userWords = userMessage.toLowerCase().match(/[a-z]{2,}/g) || [];
    for (const word of userWords) activations[word] = 1.0;

    const userProperNouns = userMessage.match(/[A-Z][A-Za-z]{1,}(?:\s[A-Z][A-Za-z]{1,})*/g) || [];
    for (const noun of userProperNouns) activations[noun.toLowerCase()] = 1.0;

    const recentWindow = recentMessages.slice(-30);
    for (let i = 0; i < recentWindow.length; i++) {
        const msg = recentWindow[i];
        const turnsBack = recentWindow.length - 1 - i;
        const weight = Math.max(0.15, Math.pow(0.92, turnsBack));
        const words = (msg.content || '').toLowerCase().match(/[a-z]{2,}/g) || [];
        const properNouns = (msg.content || '').match(/[A-Z][A-Za-z]{1,}(?:\s[A-Z][A-Za-z]{1,})*/g) || [];
        for (const word of words) {
            if (!activations[word] || activations[word] < weight) activations[word] = weight;
        }
        for (const noun of properNouns) {
            const k = noun.toLowerCase();
            if (!activations[k] || activations[k] < weight) activations[k] = weight;
        }
    }

    if (npcLedger) {
        for (const npc of npcLedger) {
            activations[npc.name.toLowerCase()] = 1.0;
            if (npc.aliases) {
                for (const alias of npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)) {
                    activations[alias] = 1.0;
                }
            }
        }
    }

    return activations;
}

/**
 * Expand context activations using semantic fact relationships.
 * If context mentions "Malachar" and a fact says "X killed_by Malachar",
 * then "x" also gets activated (weaker weight).
 */
export function expandActivationsWithFacts(
    activations: Record<string, number>,
    facts?: SemanticFact[]
): Record<string, number> {
    if (!facts || facts.length === 0) return activations;

    const expanded = { ...activations };

    for (const fact of facts) {
        const sLower = fact.subject.toLowerCase();
        const oLower = fact.object.toLowerCase();
        if (expanded[sLower] && !expanded[oLower]) {
            expanded[oLower] = expanded[sLower] * 0.5;
        }
        if (expanded[oLower] && !expanded[sLower]) {
            expanded[sLower] = expanded[oLower] * 0.5;
        }
    }

    return expanded;
}

// ─── RRF Fusion ───

export function fuseRecall(
    keywordRanked: string[],
    embeddingRanked: string[],
    k = 60,
    keywordWeight = 1.0,
    embeddingWeight = 1.0
): string[] {
    const allIds = new Set<string>([...keywordRanked, ...embeddingRanked]);
    if (allIds.size === 0) return [];
    if (keywordRanked.length === 0) return embeddingRanked;
    if (embeddingRanked.length === 0) return keywordRanked;

    const scores = new Map<string, number>();

    for (const id of allIds) {
        let score = 0;
        const kwRank = keywordRanked.indexOf(id);
        if (kwRank !== -1) score += keywordWeight / (k + kwRank + 1);
        const embRank = embeddingRanked.indexOf(id);
        if (embRank !== -1) score += embeddingWeight / (k + embRank + 1);
        scores.set(id, score);
    }

    return Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
}

function computeDynamicMax(keywordRanked: string[], embeddingRanked: string[], maxScenes?: number): number {
    if (maxScenes !== undefined) return maxScenes;
    const keywordSet = new Set(keywordRanked);
    let consensus = 0;
    for (const id of embeddingRanked) {
        if (keywordSet.has(id)) consensus++;
    }
    if (consensus >= 3) return 5;
    if (consensus >= 1) return 4;
    return 3;
}

/**
 * Search the archive index using IDF-weighted keyword scoring fused with
 * embedding ranking via Reciprocal Rank Fusion (RRF).
 */
export function retrieveArchiveMemory(
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    maxScenes?: number,
    semanticFacts?: SemanticFact[],
    sceneRanges?: [string, string][],
    semanticCandidateIds?: string[] | SearchHit[],
    divergenceSceneIds?: Set<string>,
    filters?: { characters?: string[]; locations?: string[]; items?: string[]; concepts?: string[]; eventTypes?: string[] }
): string[] {
    if (!index || index.length === 0) {
        console.log('[Archive Retrieval] Index is empty — no recall.');
        return [];
    }

    const contextText = [
        userMessage,
        ...recentMessages.slice(-3).map(m => m.content || '')
    ].join('\n').toLowerCase();

    let contextActivations = extractContextActivations(userMessage, recentMessages, npcLedger);
    contextActivations = expandActivationsWithFacts(contextActivations, semanticFacts);

    let scopedIndex = index;
    if (sceneRanges && sceneRanges.length > 0) {
        scopedIndex = index.filter(entry => {
            const sceneNum = parseInt(entry.sceneId, 10);
            return sceneRanges.some(([start, end]) => {
                const s = parseInt(start, 10);
                const e = parseInt(end, 10);
                return sceneNum >= s && sceneNum <= e;
            });
        });
    }

    const idf = computeArchiveIdf(index);
    const totalScenes = scopedIndex.length;

    const scored = scopedIndex.map(entry => {
        const { keywordRelevance, recency, importance } = scoreEntry(
            entry, contextText, contextActivations, totalScenes, idf
        );

        let filterBoost = 1.0;
        if (filters && entry.events && entry.events.length > 0) {
            const matched = entry.events.some(ev => {
                if (filters.eventTypes && filters.eventTypes.includes(ev.eventType)) return true;
                if (filters.characters && ev.characters?.some(c => filters.characters!.some(f => c.toLowerCase().includes(f.toLowerCase())))) return true;
                if (filters.locations && ev.locations?.some(l => filters.locations!.some(f => l.toLowerCase().includes(f.toLowerCase())))) return true;
                if (filters.items && ev.items?.some(i => filters.items!.some(f => i.toLowerCase().includes(f.toLowerCase())))) return true;
                if (filters.concepts && ev.concepts?.some(c => filters.concepts!.some(f => c.toLowerCase().includes(f.toLowerCase())))) return true;
                return false;
            });
            if (matched) filterBoost = 1.5;
        }

        return {
            sceneId: entry.sceneId,
            keywordRelevance,
            tiebreak: (0.1 * recency) + (0.05 * importance),
            filterBoost,
        };
    });

    const keywordRelevant = scored
        .filter(s => s.keywordRelevance > 0)
        .sort((a, b) => {
            const aScore = a.keywordRelevance * a.filterBoost + a.tiebreak;
            const bScore = b.keywordRelevance * b.filterBoost + b.tiebreak;
            return bScore - aScore;
        });
    const keywordRanked = keywordRelevant.map(s => s.sceneId);

    const scopedSceneIds = scopedIndex.length < index.length
        ? new Set(scopedIndex.map(e => e.sceneId))
        : null;

    let embeddingRanked: string[];
    if (Array.isArray(semanticCandidateIds) && semanticCandidateIds.length > 0) {
        if (typeof semanticCandidateIds[0] === 'object' && semanticCandidateIds[0] !== null && 'score' in (semanticCandidateIds[0] as SearchHit)) {
            const hits = (semanticCandidateIds as SearchHit[])
                .filter(h => !scopedSceneIds || scopedSceneIds.has(h.id))
                .sort((a, b) => b.score - a.score)
                .map(h => h.id);
            embeddingRanked = hits;
        } else {
            const ids = (semanticCandidateIds as string[]).filter(id => !scopedSceneIds || scopedSceneIds.has(id));
            embeddingRanked = ids;
        }
    } else {
        embeddingRanked = [];
    }

    const fused = fuseRecall(keywordRanked, embeddingRanked);
    const dynamicMax = computeDynamicMax(keywordRanked, embeddingRanked, maxScenes);

    // Divergence scenes (where the story left canon) must surface for continuity even
    // when they don't match the current turn's keywords or embeddings. Force them to the
    // front: matched ones keep their fused order, unmatched ones follow by recency.
    let ordered = fused;
    if (divergenceSceneIds && divergenceSceneIds.size > 0) {
        const fusedSet = new Set(fused);
        const divInScope = scopedIndex
            .map(e => e.sceneId)
            .filter(id => divergenceSceneIds.has(id));
        if (divInScope.length > 0) {
            const divSet = new Set(divInScope);
            const matchedDiv = fused.filter(id => divSet.has(id));
            const unmatchedDiv = divInScope
                .filter(id => !fusedSet.has(id))
                .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
            const rest = fused.filter(id => !divSet.has(id));
            ordered = [...matchedDiv, ...unmatchedDiv, ...rest];
        }
    }

    const result = ordered.slice(0, dynamicMax);

    console.log(
        `[Archive Retrieval] Hybrid: ${keywordRanked.length} keyword hits, ${embeddingRanked.length} embedding hits, ` +
        `consensus → max ${dynamicMax}. Top: [${result.join(', ')}]`
    );

    return result;
}

/**
 * Fetch full verbatim scene content from the server for a set of scene IDs.
 *
 * Inclusion is decided by **rank order** (the order of `sceneIds` as passed in,
 * which comes from `retrieveArchiveMemory`'s relevance ranking). The token budget
 * is filled greedily from highest-rank to lowest-rank, so a high-ranked scene is
 * never dropped just because it has a later scene number. Once selected, scenes
 * are sorted chronologically for readable injection.
 */
export async function fetchArchiveScenes(
    campaignId: string,
    sceneIds: string[],
    tokenBudget = 3000,
    excludeSceneIds?: Set<string>
): Promise<ArchiveScene[]> {
    if (sceneIds.length === 0) return [];

    try {
        const raw = await offlineStorage.archive.getScenes(campaignId, sceneIds);

        const deduped = excludeSceneIds ? raw.filter(s => !excludeSceneIds.has(s.sceneId)) : raw;

        // Build a map for O(1) lookup so we can walk in rank order
        const byId = new Map<string, ArchiveScene>(deduped.map(s => [s.sceneId, s]));

        // Walk sceneIds in rank order (highest relevance first) and fill the budget
        const selected: ArchiveScene[] = [];
        let usedTokens = 0;

        for (const id of sceneIds) {
            const scene = byId.get(id);
            if (!scene) continue; // not fetched (missing or excluded)

            const tokens = countTokens(scene.content);
            if (usedTokens + tokens > tokenBudget) {
                // Truncate if meaningful space remains; either way stop — lower-ranked
                // scenes are even less likely to fit
                const remaining = tokenBudget - usedTokens;
                if (remaining > 150) {
                    const maxChars = Math.floor(remaining * 4);
                    const truncated = scene.content.slice(0, maxChars) + '\n[...scene truncated for context budget...]';
                    selected.push({ sceneId: scene.sceneId, content: truncated, tokens: remaining });
                    usedTokens += remaining;
                }
                break;
            }
            selected.push({ sceneId: scene.sceneId, content: scene.content, tokens });
            usedTokens += tokens;
        }

        // Sort chronologically for readable injection (does not affect which scenes were chosen)
        selected.sort((a, b) => parseInt(a.sceneId) - parseInt(b.sceneId));

        console.log(
            `[Archive Retrieval] Fetched ${selected.length}/${raw.length} scenes ` +
            `(${usedTokens} tokens used of ${tokenBudget} budget).`
        );

        return selected;
    } catch (err) {
        console.warn('[Archive Retrieval] Error fetching scenes:', err);
        return [];
    }
}

/**
 * Convenience: search + fetch in one call.
 * Used in ChatArea before buildPayload().
 */
export async function recallArchiveScenes(
    campaignId: string,
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    tokenBudget = 3000,
    npcLedger?: NPCEntry[],
    semanticFacts?: SemanticFact[],
    semanticCandidateIds?: string[] | SearchHit[],
    divergenceSceneIds?: Set<string>,
    excludeSceneIds?: Set<string>,
    filters?: { characters?: string[]; locations?: string[]; items?: string[]; concepts?: string[]; eventTypes?: string[] }
): Promise<ArchiveScene[]> {
    const matchedIds = retrieveArchiveMemory(index, userMessage, recentMessages, npcLedger, undefined, semanticFacts, undefined, semanticCandidateIds, divergenceSceneIds, filters);
    if (matchedIds.length === 0) return [];
    return fetchArchiveScenes(campaignId, matchedIds, tokenBudget, excludeSceneIds);
}
