import type { GameContext, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, ArchiveChapter, ChatMessage, PayloadTrace, DivergenceRegister, SceneEvent } from '../../../types';
import { countTokens } from '../infrastructure';
import { buildBehaviorDirective, buildDriftAlert } from '../npc';
import { minifyLoreChunk, minifyNPC } from './contextMinifier';
import type { BudgetMap } from './payloadBudgeter';

export interface WorldBlock {
    source: string;
    content: string;
    tokens: number;
    reason: string;
}

function renderSceneEvents(events: SceneEvent[]): string {
    if (!events || events.length === 0) return '';
    return events
        .slice()
        .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
        .map(e => {
            const parts = [`[${e.eventType}] ${e.text}`];
            if (e.cause && e.result) parts.push(`(${e.cause} → ${e.result})`);
            else if (e.cause) parts.push(`(cause: ${e.cause})`);
            else if (e.result) parts.push(`(result: ${e.result})`);
            return parts.join(' ');
        })
        .join('\n');
}

function filterRecallByPerception(
    archiveRecall: ArchiveScene[],
    archiveIndex: ArchiveIndexEntry[] | undefined,
    npcLedger: NPCEntry[] | undefined,
    onStageNpcIds: string[] | undefined,
): ArchiveScene[] {
    let filteredRecall = archiveRecall;
    if (archiveIndex && archiveIndex.length > 0) {
        const currentActiveIds = new Set<string>();
        if (npcLedger) {
            for (const n of npcLedger) {
                if (!n.archived) currentActiveIds.add(n.id);
            }
        }
        const onStageSet = new Set(onStageNpcIds ?? []);

        if (currentActiveIds.size > 0) {
            const indexMap = new Map(archiveIndex.map(e => [e.sceneId, e]));
            const hasAnyWitnessData = archiveIndex.some(e => e.npcsWitnessed !== undefined);

            if (hasAnyWitnessData) {
                filteredRecall = filteredRecall.filter(scene => {
                    const idxEntry = indexMap.get(scene.sceneId);
                    if (!idxEntry) return true;
                    if (idxEntry.npcsWitnessed === undefined) return true;
                    for (const wId of idxEntry.npcsWitnessed) {
                        if (onStageSet.has(wId)) return true;
                    }
                    for (const wId of idxEntry.npcsWitnessed) {
                        if (currentActiveIds.has(wId)) return true;
                    }
                    return false;
                });
            }
        }
    }
    return filteredRecall;
}

type NpcSelectMode = 'recommended' | 'fallback';

function selectActiveNPCs(opts: {
    npcLedger: NPCEntry[];
    mode: NpcSelectMode;
    recommendedNames?: string[];
    loreHeadersSet: Set<string>;
    scanHistory: string;
}): NPCEntry[] {
    const { npcLedger, mode, recommendedNames, loreHeadersSet, scanHistory } = opts;
    const nonArchivedLedger = npcLedger.filter(npc => !npc.archived);

    let activeNPCs: NPCEntry[];

    if (mode === 'recommended' && recommendedNames && recommendedNames.length > 0) {
        const recommendedSet = new Set(recommendedNames.map(n => n.toLowerCase()));
        activeNPCs = nonArchivedLedger.filter(npc => {
            if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
            const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
            const allNames = [npc.name.toLowerCase(), ...aliases];
            return allNames.some(n => recommendedSet.has(n));
        });
        const matched = activeNPCs.map(n => n.name);
        const omitted = nonArchivedLedger.length - activeNPCs.length;
        console.log(`[NPC] path=recommender total=${nonArchivedLedger.length} matched=[${matched.join(',')}] omitted=${omitted} (archived/lore-collision)`);
    } else {
        activeNPCs = nonArchivedLedger.filter(npc => {
            if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
            const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
            const patterns = [npc.name.toLowerCase(), ...aliases];
            return patterns.some(p => scanHistory.toLowerCase().includes(p));
        });
        const matched = activeNPCs.map(n => n.name);
        const omitted = nonArchivedLedger.length - activeNPCs.length;
        console.log(`[NPC] path=fallback total=${nonArchivedLedger.length} matched=[${matched.join(',')}] omitted=${omitted} (archived/lore-collision)`);
    }

    if (activeNPCs.length === 0) {
        const path = mode;
        console.log(`[NPC] no NPCs included this turn — path=${path} candidates=${nonArchivedLedger.length}`);
    }

    return activeNPCs;
}

function capActiveNPCs(activeNPCs: NPCEntry[], onStageNpcIds: string[] | undefined): NPCEntry[] {
    const MAX_TOTAL_NPCS = 10;
    if (activeNPCs.length <= MAX_TOTAL_NPCS) return activeNPCs;

    const onStageIds = new Set(onStageNpcIds ?? []);
    const onStage = activeNPCs.filter(n => onStageIds.has(n.id));
    const offStage = activeNPCs.filter(n => !onStageIds.has(n.id));
    const prioritized = [...onStage, ...offStage];
    const dropped = prioritized.slice(MAX_TOTAL_NPCS).map(n => n.name);
    console.log(`[NPC] capped to ${MAX_TOTAL_NPCS} (dropped: [${dropped.join(',')}])`);
    return prioritized.slice(0, MAX_TOTAL_NPCS);
}

function mergeSemanticRecall(
    activeNPCs: NPCEntry[],
    semanticallyRecalledNpcIds: string[] | undefined,
    npcLedger: NPCEntry[],
): NPCEntry[] {
    if (!semanticallyRecalledNpcIds || semanticallyRecalledNpcIds.length === 0) return activeNPCs;

    const MAX_TOTAL_NPCS = 10;
    const existingIds = new Set(activeNPCs.map(n => n.id));
    const nonArchivedLedger = npcLedger.filter(n => !n.archived);
    const recalled: NPCEntry[] = [];
    for (const id of semanticallyRecalledNpcIds) {
        if (existingIds.has(id)) continue;
        if (activeNPCs.length + recalled.length >= MAX_TOTAL_NPCS) break;
        const npc = nonArchivedLedger.find(n => n.id === id);
        if (npc) {
            npc.recalledByEmbedding = true;
            recalled.push(npc);
        }
    }
    if (recalled.length > 0) {
        const result = [...activeNPCs, ...recalled];
        const recalledNames = recalled.map(n => `${n.name} (semantic)`);
        console.log(`[NPC] semantic callback added: [${recalledNames.join(',')}]`);
        return result;
    }
    return activeNPCs;
}

export interface NpcStrategy {
    mode: NpcSelectMode;
    recommendedNames?: string[];
    semanticallyRecalledNpcIds?: string[];
}

export function assembleWorldBlocks(opts: {
    context: GameContext;
    history: ChatMessage[];
    userMessage: string;
    condensedUpToIndex?: number;
    relevantLore?: LoreChunk[];
    archiveRecall?: ArchiveScene[];
    archiveIndex?: ArchiveIndexEntry[];
    npcLedger?: NPCEntry[];
    npcStrategy?: NpcStrategy;
    onStageNpcIds?: string[];
    semanticFactText?: string;
    deepContextSummary?: string;
    chapters?: ArchiveChapter[];
    addTrace: (t: PayloadTrace) => void;
}): WorldBlock[] {
    const {
        context,
        history,
        userMessage,
        condensedUpToIndex,
        relevantLore,
        archiveRecall,
        archiveIndex,
        npcLedger,
        npcStrategy,
        onStageNpcIds,
        semanticFactText,
        deepContextSummary,
        chapters,
        addTrace,
    } = opts;

    const worldBlocks: WorldBlock[] = [];

    if (archiveRecall && archiveRecall.length > 0) {
        const activeAssistantContents = history
            .slice((condensedUpToIndex ?? -1) + 1)
            .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 20)
            .map(m => m.content as string);

        let filteredRecall = archiveRecall.filter(scene => {
            if (activeAssistantContents.some(asst => scene.content.includes(asst))) return false;
            return true;
        });

        filteredRecall = filterRecallByPerception(filteredRecall, archiveIndex, npcLedger, onStageNpcIds);

        if (filteredRecall.length > 0) {
            const indexMap = archiveIndex ? new Map(archiveIndex.map(e => [e.sceneId, e])) : new Map();

            const sceneLines = filteredRecall.map(s => {
                let lines = [`[SCENE #${s.sceneId}]`];
                const idxEntry = indexMap.get(s.sceneId);
                if (idxEntry?.events && idxEntry.events.length > 0) {
                    const eventsText = renderSceneEvents(idxEntry.events);
                    if (eventsText) {
                        lines.push('STRUCTURED EVENTS:');
                        lines.push(eventsText);
                        lines.push('');
                    }
                }
                lines.push(s.content);
                return lines.join('\n');
            }).join('\n\n');

            const text = `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${sceneLines}\n[END ARCHIVE RECALL]`;
            worldBlocks.push({ source: 'Archive Recall', content: text, tokens: countTokens(text), reason: `Verbatim history (${filteredRecall.length} scenes${archiveIndex?.some(e => e.npcsWitnessed !== undefined) ? ', perception-bounded' : ''})` });
        }
    }

    if (deepContextSummary) {
        const text = `[DEEP ARCHIVE CONTEXT — AI-synthesized from full campaign history]\n${deepContextSummary}\n[END DEEP ARCHIVE CONTEXT]`;
        worldBlocks.push({ source: 'Deep Archive Brief', content: text, tokens: countTokens(text), reason: 'Deep archive scan (GM long-press)' });
    }

    if (relevantLore && relevantLore.length > 0) {
        const grouped = new Map<string, string[]>();
        for (const chunk of relevantLore) {
            const cat = chunk.category || 'misc';
            const catTitle = cat === 'faction' ? 'FACTIONS'
                           : cat === 'character' ? 'CHARACTERS'
                           : cat === 'location' ? 'LOCATIONS'
                           : cat === 'power_system' || cat === 'rules' ? 'POWER SYSTEM & RULES'
                           : cat === 'economy' ? 'ECONOMY'
                           : cat === 'event' ? 'EVENTS'
                           : cat === 'world_overview' ? 'OVERVIEW'
                           : 'MISCELLANEOUS';
            
            if (!grouped.has(catTitle)) grouped.set(catTitle, []);
            grouped.get(catTitle)!.push(minifyLoreChunk(chunk));
        }

        const sections: string[] = [];
        for (const [title, chunks] of grouped.entries()) {
            sections.push(`[${title}]\n` + chunks.join('\n'));
        }

        const text = `[WORLD LORE — RELEVANT SECTIONS]\n${sections.join('\n\n')}\n[END WORLD LORE]`;
        worldBlocks.push({ source: 'RAG Lore', content: text, tokens: countTokens(text), reason: `RAG injected (${relevantLore.length} chunks, minified)` });
    } else if (context.loreRaw) {
        worldBlocks.push({ source: 'Raw Lore (Legacy)', content: context.loreRaw, tokens: countTokens(context.loreRaw), reason: 'Legacy fallback' });
    }

    if (semanticFactText) {
        worldBlocks.push({ source: 'Semantic Facts', content: semanticFactText, tokens: countTokens(semanticFactText), reason: 'Injected verified facts' });
    }

    if (context.notebookActive && context.notebook && context.notebook.length > 0) {
        const notebookText = '[SCENE NOTEBOOK]\n' +
            context.notebook.map(n => `- ${n.text}`).join('\n') +
            '\n[END SCENE NOTEBOOK]';
        worldBlocks.push({ source: 'Scene Notebook', content: notebookText, tokens: countTokens(notebookText), reason: 'Active scene state' });
    }

    if (npcLedger && npcLedger.length > 0) {
        const loreHeadersSet = new Set((relevantLore ?? []).map(l => l.header.toLowerCase()));
        const mode: NpcSelectMode = (npcStrategy?.mode === 'recommended' && npcStrategy.recommendedNames && npcStrategy.recommendedNames.length > 0)
            ? 'recommended'
            : 'fallback';
        const scanHistory = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;

        let activeNPCs = selectActiveNPCs({
            npcLedger,
            mode,
            recommendedNames: npcStrategy?.recommendedNames,
            loreHeadersSet,
            scanHistory,
        });

        activeNPCs = capActiveNPCs(activeNPCs, onStageNpcIds);
        activeNPCs = mergeSemanticRecall(activeNPCs, npcStrategy?.semanticallyRecalledNpcIds, npcLedger);

        if (activeNPCs.length > 0) {
            const onStageSet = new Set(onStageNpcIds ?? []);
            const npcText = `[ACTIVE NPC CONTEXT]\n${activeNPCs.map(npc => {
                let line = minifyNPC(npc, onStageSet.size > 0 && !onStageSet.has(npc.id));
                const directive = buildBehaviorDirective(npc);
                if (directive) line += ` | ${directive}`;
                const drift = buildDriftAlert(npc);
                if (drift) line += ` | ${drift}`;
                if (chapters && chapters.length > 0) {
                    for (let ci = chapters.length - 1; ci >= 0; ci--) {
                        const ch = chapters[ci];
                        if (ch.npcInnerState && ch.npcInnerState[npc.name]) {
                            const innerNote = ch.npcInnerState[npc.name];
                            line += ` | Inner: ${innerNote}`;
                            addTrace({
                                source: `NPC Inner State: ${npc.name}`,
                                classification: 'world_context',
                                tokens: countTokens(innerNote),
                                reason: `From chapter ${ch.chapterId}`,
                                included: true,
                                position: 'system_dynamic',
                            });
                            break;
                        }
                    }
                }
                return line;
            }).join('\n')}\n[END NPC CONTEXT]`;
            worldBlocks.push({ source: 'Active NPCs', content: npcText, tokens: countTokens(npcText), reason: `NPCs detected in context (${activeNPCs.length}, minified)` });
        }
    }

    return worldBlocks;
}

export function trimWorldBlocks(
    worldBlocks: WorldBlock[],
    budget: number,
    addTrace: (t: PayloadTrace) => void,
): { worldContent: string; currentWorldTokens: number } {
    let worldContent = '';
    let currentWorldTokens = 0;
    for (const block of worldBlocks) {
        if (currentWorldTokens + block.tokens <= budget) {
            worldContent += (worldContent ? '\n\n' : '') + block.content;
            currentWorldTokens += block.tokens;
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: block.reason, included: true, position: 'system_dynamic' });
        } else {
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Dropped: Exceeds World budget (${budget} t)`, included: false, position: 'system_dynamic' });
        }
    }
    return { worldContent, currentWorldTokens };
}