import type { GameContext, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, ArchiveChapter, ChatMessage, PayloadTrace, SceneEvent, DivergenceRegister, DivergenceEntry, SceneEventType } from '../../types';
import { countTokens } from '../infrastructure';
import { buildDriftAlert } from '../npc';
import { relationBand, describeHex } from '../npc/agencyBands';
import { buildReactionMenu, type ReactionContext } from '../npc/reactionMenu';
import { applyRepressionToMenu } from '../npc/reactionRepression';
import { isKnownToAnyOnStage, parseKnownByToken } from '../campaign-state/knowledgeScope';
import { minifyLoreChunk, minifyNPC } from './contextMinifier';

/**
 * Map the planner's scene-type tags to the reaction menu's peaceful/dangerous
 * context split. Combat + the high-stakes scene types surface the danger pool;
 * everything else gets the peaceful pool (the default — covers social scenes,
 * travel, discovery, etc.). If the planner returned no tags, default peaceful.
 */
const DANGER_EVENT_TYPES: ReadonlySet<SceneEventType> = new Set([
    'combat', 'betrayal', 'death',
]);
function reactionContextFor(plannerTags: Set<SceneEventType> | null): ReactionContext {
    if (!plannerTags || plannerTags.size === 0) return 'peaceful';
    for (const t of plannerTags) if (DANGER_EVENT_TYPES.has(t)) return 'dangerous';
    return 'peaceful';
}

export function computeOpenThreads(chapters: ArchiveChapter[]): { text: string; chapterId: string }[] {
    const allUnresolved: { text: string; chapterId: string }[] = [];
    for (const ch of chapters) {
        // Invalidated chapters have stale summaries, so their threads are stale too
        // (same exclusion as troublemaker.ts); their resolvedThreads still count below.
        if (ch.invalidated) continue;
        if (ch.unresolvedThreads) {
            for (const t of ch.unresolvedThreads) {
                allUnresolved.push({ text: t, chapterId: ch.chapterId });
            }
        }
    }
    const allResolved = new Set<string>();
    for (const ch of chapters) {
        if (ch.resolvedThreads) {
            for (const t of ch.resolvedThreads) {
                allResolved.add(t);
            }
        }
    }
    const open = allUnresolved.filter(t => !allResolved.has(t.text));
    return open.slice(-12);
}

export interface WorldBlock {
    source: string;
    content: string;
    tokens: number;
    reason: string;
    /**
     * Optional per-item segments + a re-wrap fn. When a block carries these and
     * doesn't fit the world budget whole, trimWorldBlocks keeps the largest
     * prefix of segments that fits instead of dropping the whole block (AUDIT F5).
     */
    segments?: string[];
    rewrap?: (kept: string[]) => string;
    /** For the 'Active NPCs' block: ids of NPCs whose profile was included this
     *  turn. Consumed by the deterministic name swap (Plan 05) as the "was the
     *  profile in the payload" signal. */
    npcIds?: string[];
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
                currentActiveIds.add(n.id);
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
                    if (idxEntry.npcsWitnessed.length === 0) return true;
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

/**
 * Check whether a profile field's scene tags match the planner's event types.
 * - No fieldTags on the NPC → always match (backward compatible: always inject).
 * - Field not in fieldTags → always match (untagged = always inject).
 * - Field in fieldTags but with empty tags → always match.
 * - plannerTags null (planner didn't run or returned nothing) → always match.
 * - Otherwise: intersect field tags with planner tags.
 */
function fieldTagMatches(
    fieldName: string,
    fieldTags: Record<string, SceneEventType[]> | undefined,
    plannerTags: Set<SceneEventType> | null,
): boolean {
    if (!fieldTags) return true;
    if (!plannerTags) return true;
    const tags = fieldTags[fieldName];
    if (!tags || tags.length === 0) return true;
    return tags.some(t => plannerTags.has(t));
}

/**
 * Core directive — always injected for every active NPC regardless of scene.
 * Contains the 5-field "GM is never starved" floor: affinity, personality hex
 * (if present, since it's compact word-bands), and the current active goal
 * (wants.short[0] or drives fallback). This mirrors the most critical parts
 * of buildBehaviorDirective but drops voice, boundaries, triggers, example,
 * and drift — those move to the extended tier.
 *
 * Phase 2 §9.1 — the engine-built reaction menu is appended here (the primary
 * behavioral signal). The engine already consumed personalityHex + pcRelation
 * + traits + context to pick the reactions, so the menu is the cooked dish —
 * the AI picks ONE from the list instead of interpreting raw ingredients.
 * Rides inside the NPC budget slice (payloadBuilder two-phase trim), so it
 * never competes against lore/archive. Skipped for legacy hex-less NPCs or
 * when the menu is empty.
 */
function buildCoreDirective(npc: NPCEntry, reactionCtx: ReactionContext): string {
    const parts: string[] = [];

    const affinityLabel = npc.pcRelation !== undefined
        ? relationBand(npc.pcRelation)
        : undefined;
    if (affinityLabel) parts.push(`[Aff: ${affinityLabel}]`);

    if (npc.personalityHex) {
        parts.push(`Personality: ${describeHex(npc.personalityHex)}`);
    }

    if (npc.wants?.short?.[0]) {
        parts.push(`NOW: ${npc.wants.short[0].length > 40 ? npc.wants.short[0].substring(0, 40) + '…' : npc.wants.short[0]}`);
    } else if (npc.drives?.sceneWant) {
        const sw = npc.drives.sceneWant;
        parts.push(`NOW: ${sw.length > 40 ? sw.substring(0, 40) + '…' : sw}`);
    }

    // Phase 2 §9.1 — engine-built reaction menu. The enforcement clause
    // prevents the story AI from inventing a softer, out-of-character reaction
    // (the sycophant-smoothing failure mode). The engine picks rank-1 + 2
    // sampled alternatives from REACTION_VOCAB filtered by personality + traits
    // + relationship + context — zero LLM cost. Skipped for legacy hex-less NPCs.
    if (npc.personalityHex) {
        const rawMenu = buildReactionMenu(npc, reactionCtx);
        // Inner repression (peaceful only) — rewrites a hostile top impulse into a leak/mask
        // token. Event discarded here (read path); booked once-per-turn elsewhere.
        const { menu } = applyRepressionToMenu(rawMenu, npc, reactionCtx);
        if (menu.length > 0) {
            parts.push(
                `REACTIONS (choose ONE and play it — do NOT invent a softer reaction; prefer the less obvious when several fit): ${menu.join(' | ')}`
            );
        }
    }

    return parts.length > 0 ? `PLAY AS: ${parts.join(' | ')}` : '';
}

/**
 * Extended directive — scene-tagged fields injected only when relevant to the
 * current scene type. Contains: long/medium wants (goals), hard/soft boundaries,
 * behavioral triggers, voice, example output. Each field is checked against
 * the NPC's fieldTags (if any) intersected with the planner's eventTypes.
 */
function buildExtendedDirective(
    npc: NPCEntry,
    plannerTags: Set<SceneEventType> | null,
): string {
    const parts: string[] = [];

    // Goals/pursuits — broadly relevant (promise, quest_milestone), but
    // untagged by default so they always inject (goals are usually important).
    if (npc.wants?.long) {
        parts.push(`GOAL: ${npc.wants.long.length > 80 ? npc.wants.long.substring(0, 80) + '…' : npc.wants.long}`);
    }
    if (npc.wants?.medium?.[0]) {
        parts.push(`PURSUING: ${npc.wants.medium[0].length > 60 ? npc.wants.medium[0].substring(0, 60) + '…' : npc.wants.medium[0]}`);
    } else if (npc.drives && !npc.wants) {
        const driveParts: string[] = [];
        if (npc.drives.sessionWant) driveParts.push(npc.drives.sessionWant.length > 80 ? npc.drives.sessionWant.substring(0, 80) + '…' : npc.drives.sessionWant);
        if (npc.drives.coreWant) driveParts.push(npc.drives.coreWant.length > 80 ? npc.drives.coreWant.substring(0, 80) + '…' : npc.drives.coreWant);
        if (driveParts.length > 0) parts.push(`WANTS: ${driveParts.join(' ← ')}`);
    }

    if (npc.hardBoundaries?.length && fieldTagMatches('hardBoundaries', npc.fieldTags, plannerTags)) {
        parts.push(`WON'T: ${npc.hardBoundaries.map(b => b.length > 40 ? b.substring(0, 40) + '…' : b).join('; ')}`);
    }
    if (npc.softBoundaries?.length && fieldTagMatches('softBoundaries', npc.fieldTags, plannerTags)) {
        parts.push(`RESENTS: ${npc.softBoundaries.map(b => b.length > 40 ? b.substring(0, 40) + '…' : b).join('; ')}`);
    }

    if (npc.behavioralTriggers?.length && fieldTagMatches('behavioralTriggers', npc.fieldTags, plannerTags)) {
        for (const t of npc.behavioralTriggers) {
            parts.push(`ON "${t.keyword}": ${t.shift.length > 50 ? t.shift.substring(0, 50) + '…' : t.shift}`);
        }
    }

    if (npc.voice && fieldTagMatches('voice', npc.fieldTags, plannerTags)) {
        parts.push(`Voice: ${npc.voice.length > 60 ? npc.voice.substring(0, 60) + '…' : npc.voice}`);
    }
    if (npc.exampleOutput && fieldTagMatches('exampleOutput', npc.fieldTags, plannerTags)) {
        parts.push(`Example: ${npc.exampleOutput.length > 80 ? npc.exampleOutput.substring(0, 80) + '…' : npc.exampleOutput}`);
    }

    return parts.length > 0 ? parts.join(' | ') : '';
}

function selectActiveNPCs(opts: {
    npcLedger: NPCEntry[];
    mode: NpcSelectMode;
    recommendedNames?: string[];
    loreHeadersSet: Set<string>;
    scanHistory: string;
}): NPCEntry[] {
    const { npcLedger, mode, recommendedNames, loreHeadersSet, scanHistory } = opts;
    let activeNPCs: NPCEntry[];

    if (mode === 'recommended' && recommendedNames && recommendedNames.length > 0) {
        const recommendedSet = new Set(recommendedNames.map(n => n.toLowerCase()));
        activeNPCs = npcLedger.filter(npc => {
            if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
            const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
            const allNames = [npc.name.toLowerCase(), ...aliases];
            return allNames.some(n => recommendedSet.has(n));
        });
        const matched = activeNPCs.map(n => n.name);
        const omitted = npcLedger.length - activeNPCs.length;
        console.log(`[NPC] path=recommender total=${npcLedger.length} matched=[${matched.join(',')}] omitted=${omitted} (lore-collision)`);
    } else {
        activeNPCs = npcLedger.filter(npc => {
            if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
            const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
            const patterns = [npc.name.toLowerCase(), ...aliases];
            return patterns.some(p => scanHistory.toLowerCase().includes(p));
        });
        const matched = activeNPCs.map(n => n.name);
        const omitted = npcLedger.length - activeNPCs.length;
        console.log(`[NPC] path=fallback total=${npcLedger.length} matched=[${matched.join(',')}] omitted=${omitted} (lore-collision)`);
    }

    if (activeNPCs.length === 0) {
        const path = mode;
        console.log(`[NPC] no NPCs included this turn — path=${path} candidates=${npcLedger.length}`);
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
    const recalled: NPCEntry[] = [];
    for (const id of semanticallyRecalledNpcIds) {
        if (existingIds.has(id)) continue;
        if (activeNPCs.length + recalled.length >= MAX_TOTAL_NPCS) break;
        const npc = npcLedger.find(n => n.id === id);
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

/**
 * Compact name-uniqueness guard: every ledger name (including archived NPCs —
 * they still exist in canon), names only, no profiles. Prevents the story AI
 * from minting a new character with a name that's already taken.
 */
export function buildReservedNamesBlock(npcLedger: NPCEntry[]): string | null {
    const names = Array.from(new Set(
        npcLedger.map(n => n.name?.trim()).filter((n): n is string => !!n)
    ));
    if (names.length === 0) return null;
    return '[RESERVED CHARACTER NAMES]\n' +
        'Every name below already belongs to ONE established character. When you introduce a NEW character, ' +
        'do NOT reuse any of these names — give each new character a clearly distinct name. ' +
        'A shared family/clan/house surname is allowed ONLY when the relation is explicit in the story ' +
        '(e.g. siblings, a parent, a shared dojo name). NEVER reuse a first name.\n' +
        `Names: ${names.join(', ')}\n` +
        '[END RESERVED CHARACTER NAMES]';
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
    sealedChapters?: ArchiveChapter[];
    divergenceRegister?: DivergenceRegister;
    plannerEventTypes?: SceneEventType[];
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
        sealedChapters: sealedChaptersOverride,
        divergenceRegister,
        plannerEventTypes,
        addTrace,
    } = opts;

    const sealedChapters = sealedChaptersOverride ?? (chapters ? chapters.filter(c => c.sealedAt !== undefined) : undefined);

    const worldBlocks: WorldBlock[] = [];

    // First block = highest survival priority in trimWorldBlocks: name
    // uniqueness is a hard canon constraint, not droppable flavor.
    if (npcLedger && npcLedger.length > 0) {
        const reservedNames = buildReservedNamesBlock(npcLedger);
        if (reservedNames) {
            worldBlocks.push({
                source: 'Reserved Names',
                content: reservedNames,
                tokens: countTokens(reservedNames),
                reason: `Name-uniqueness guard (${npcLedger.length} ledger entries)`,
            });
        }
    }

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
            const npcNameById = new Map((npcLedger ?? []).map(n => [n.id, n.name]));

            const sceneSegments = filteredRecall.map(s => {
                const idxEntry = indexMap.get(s.sceneId);
                let header: string;
                if (idxEntry?.npcsWitnessed && idxEntry.npcsWitnessed.length > 0) {
                    const witnessNames = idxEntry.npcsWitnessed.map((id: string) => npcNameById.get(id)).filter((n: string | undefined): n is string => !!n);
                    if (witnessNames.length > 0) {
                        header = `[PAST SCENE | Witnessed by: ${witnessNames.join(', ')} — NPCs not listed were NOT present and do NOT know these events]`;
                    } else {
                        header = `[PAST SCENE]`;
                    }
                } else {
                    header = `[PAST SCENE]`;
                }
                const lines = [header];
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
            });

            const rewrapRecall = (kept: string[]) => `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${kept.join('\n\n')}\n[END ARCHIVE RECALL]`;
            const text = rewrapRecall(sceneSegments);
            worldBlocks.push({
                source: 'Archive Recall',
                content: text,
                tokens: countTokens(text),
                reason: `Verbatim history (${filteredRecall.length} scenes${archiveIndex?.some(e => e.npcsWitnessed !== undefined) ? ', perception-bounded' : ''})`,
                segments: sceneSegments,
                rewrap: rewrapRecall,
            });
        }
    }

    if (sealedChapters && sealedChapters.length > 0) {
        const openThreads = computeOpenThreads(sealedChapters);
        if (openThreads.length > 0) {
            const threadLines = openThreads.map(t => `• ${t.text} (${t.chapterId})`).join('\n');
            const content = `[OPEN THREADS — unresolved setups the story may pay off]\n${threadLines}\n[END OPEN THREADS]`;
            worldBlocks.push({ source: 'Open Threads', content, tokens: countTokens(content), reason: `${openThreads.length} unresolved threads` });
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
            const plannerTags = plannerEventTypes && plannerEventTypes.length > 0
                ? new Set(plannerEventTypes)
                : null;
            const reactionCtx = reactionContextFor(plannerTags);
            const npcSegments: { npcId: string; content: string; tokens: number }[] = [];

            for (const npc of activeNPCs) {
                const offStage = onStageSet.size > 0 && !onStageSet.has(npc.id);

                // Core tier — always injected.
                const coreParts: string[] = [minifyNPC(npc, offStage)];
                const coreDirective = buildCoreDirective(npc, reactionCtx);
                if (coreDirective) coreParts.push(coreDirective);
                const coreLine = coreParts.join(' | ');

                // Extended tier — scene-tagged.
                const extParts: string[] = [];
                const extDirective = buildExtendedDirective(npc, plannerTags);
                if (extDirective) extParts.push(extDirective);
                const drift = buildDriftAlert(npc);
                if (drift && fieldTagMatches('drift', npc.fieldTags, plannerTags)) extParts.push(drift);
                if (chapters && chapters.length > 0 && fieldTagMatches('innerState', npc.fieldTags, plannerTags)) {
                    for (let ci = chapters.length - 1; ci >= 0; ci--) {
                        const ch = chapters[ci];
                        if (ch.npcInnerState && ch.npcInnerState[npc.name]) {
                            const innerNote = ch.npcInnerState[npc.name];
                            extParts.push(`Inner: ${innerNote}`);
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
                const extLine = extParts.length > 0 ? extParts.join(' | ') : '';

                const fullLine = extLine ? `${coreLine} | ${extLine}` : coreLine;
                npcSegments.push({ npcId: npc.id, content: fullLine, tokens: countTokens(fullLine) });
            }

            // On-stage NPC↔NPC relations as words (sparse, directed). Only edges between NPCs
            // both present this scene reach the LLM — the graph's total size never matters here.
            const presentNPCs = onStageSet.size > 0
                ? activeNPCs.filter(n => onStageSet.has(n.id))
                : activeNPCs;
            const relationLines: string[] = [];
            for (const a of presentNPCs) {
                if (!a.relations) continue;
                for (const b of presentNPCs) {
                    if (a.id === b.id) continue;
                    const v = a.relations[b.id];
                    if (v === undefined || v === 0) continue;
                    relationLines.push(`${a.name} → ${b.name}: ${relationBand(v)}`);
                }
            }
            const relationBlock = relationLines.length > 0
                ? `\n[ON-STAGE RELATIONS]\n${relationLines.join('\n')}`
                : '';

            const npcText = `[ACTIVE NPC CONTEXT]\n${npcSegments.map(s => s.content).join('\n')}${relationBlock}\n[END NPC CONTEXT]`;
            // Each NPC is a segment so trimWorldBlocks can partially trim (drop
            // the lowest-priority NPCs first) instead of all-or-nothing dropping
            // the whole block. The rewrap fn rebuilds the block from kept segments.
            const npcSegStrings = npcSegments.map(s => s.content);
            const npcRewrap = (kept: string[]) =>
                `[ACTIVE NPC CONTEXT]\n${kept.join('\n')}${relationBlock}\n[END NPC CONTEXT]`;
            worldBlocks.push({
                source: 'Active NPCs',
                content: npcText,
                tokens: countTokens(npcText),
                reason: `NPCs detected in context (${activeNPCs.length}, tiered core+extended)`,
                npcIds: activeNPCs.map(n => n.id),
                segments: npcSegStrings,
                rewrap: npcRewrap,
            });
        }
    }

    // Per-turn scoped-knowledge block (the cage): facts whose knownBy is DEFINED render
    // here, never in the cached canon block. Only facts a present character knows are
    // shown, resolved against the on-stage cast. Cast-aware → must live below the cache
    // boundary (here), not in the cached [ESTABLISHED FACTS] block.
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        const onStage = onStageNpcIds ?? [];
        const ledger = npcLedger ?? [];
        const isActive = (e: DivergenceEntry): boolean => {
            if (e.enabled === false) return false;
            if (e.pinned) return true;
            const chapterOn = divergenceRegister.chapterToggles[e.chapterId] !== false;
            if (!chapterOn) return false;
            const catToggles = divergenceRegister.categoryToggles[e.chapterId];
            if (catToggles && catToggles[e.category] === false) return false;
            return true;
        };
        const labelKnowers = (knownBy: string[]): string => {
            const parts: string[] = [];
            for (const tok of knownBy) {
                const p = parseKnownByToken(tok);
                if (!p || p.kind === 'player') continue;
                if (p.kind === 'npc') {
                    const npc = ledger.find(n => n.id === p.id);
                    if (npc) parts.push(npc.name);
                } else {
                    parts.push(`${p.name} members`);
                }
            }
            return parts.join(', ');
        };
        const scoped = divergenceRegister.entries.filter(e =>
            e.knownBy !== undefined &&
            isActive(e) &&
            isKnownToAnyOnStage(e.knownBy, onStage, ledger)
        );
        if (scoped.length > 0) {
            const lines = scoped.map(e => {
                const who = labelKnowers(e.knownBy!);
                const whoStr = who ? ` (known to: ${who})` : '';
                return `• ${e.text}${whoStr} [#${e.sceneRef}]`;
            });
            const content = `[FACTS KNOWN TO ON-STAGE CHARACTERS]\n${lines.join('\n')}\n[END FACTS KNOWN TO ON-STAGE CHARACTERS]`;
            worldBlocks.push({
                source: 'Scoped Knowledge',
                content,
                tokens: countTokens(content),
                reason: `Per-fact knowledge bounded to present cast (${scoped.length})`,
            });
        }
    }

    // Phase-3 agency digest: word-band prose only, folded into existing GM call (+0 LLM).
    // No Goal fields except `text` reach this path (see guardrail audit).
    if (context.agencyDigest) {
        const digestContent = `[NPC AGENCY — recent off-screen actions]\n${context.agencyDigest}\n[END NPC AGENCY]`;
        worldBlocks.push({ source: 'Agency Digest', content: digestContent, tokens: countTokens(digestContent), reason: 'Player-visible NPC tick deltas' });
    }

    // Arc Engine (System 2 / Oracle): current-rung surface line(s), folded into the
    // existing GM call (+0 LLM). Word-band prose ONLY — each line is the rung label
    // tagged by surface tier ([WORLD/ambient|rumor|direct]); no raw rung index / tickDC
    // ever reaches the payload (see arcSurfaceLine; WO-06 no-raw-number audit).
    if (context.arcDigest) {
        const arcContent = `[WORLD PRESSURES — developing situations]\n${context.arcDigest}\n[END WORLD PRESSURES]`;
        worldBlocks.push({ source: 'Arc Digest', content: arcContent, tokens: countTokens(arcContent), reason: 'Indirect world-arc surfacing (current rung)' });
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
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: block.reason, included: true, position: 'system_dynamic', preview: block.content });
            continue;
        }

        // Block doesn't fit whole. If it's segmentable (Archive Recall), keep the
        // largest prefix of scenes that fits rather than dropping everything (AUDIT F5).
        const remaining = budget - currentWorldTokens;
        if (block.segments && block.rewrap && block.segments.length > 0 && remaining > 0) {
            const kept: string[] = [];
            for (const seg of block.segments) {
                const candidate = block.rewrap([...kept, seg]);
                if (countTokens(candidate) > remaining) break;
                kept.push(seg);
            }
            if (kept.length > 0) {
                const content = block.rewrap(kept);
                const tokens = countTokens(content);
                worldContent += (worldContent ? '\n\n' : '') + content;
                currentWorldTokens += tokens;
                const dropped = block.segments.length - kept.length;
                console.warn(`[Payload] ${block.source} truncated to fit world budget: kept ${kept.length}/${block.segments.length} scenes, dropped ${dropped}`);
                addTrace({ source: block.source, classification: 'world_context', tokens, reason: `${block.reason} (truncated: kept ${kept.length}/${block.segments.length})`, included: true, position: 'system_dynamic', preview: content });
                continue;
            }
        }

        console.warn(`[Payload] ${block.source} dropped — ${block.tokens}t exceeds remaining world budget (${remaining}t of ${budget}t)`);
        addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Dropped: Exceeds World budget (${budget} t)`, included: false, position: 'system_dynamic', preview: block.content });
    }
    return { worldContent, currentWorldTokens };
}