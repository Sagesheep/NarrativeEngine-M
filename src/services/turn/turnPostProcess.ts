import type { NPCEntry, ArchiveChapter, ArchiveIndexEntry, LLMProvider, WitnessSource } from '../../types';
import { tierAllows, NPC_UPDATE_COOLDOWN } from './aiTier';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { generateNPCProfile, updateExistingNPCs, backfillNPCDrives } from '../chatEngine';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from '../npc';
import { api } from '../apiClient';
import { uid } from '../../utils/uid';
import { toast } from '../../components/Toast';
import { shouldAutoSeal, sealChapter, sealChapterCombined, type CombinedSealResult, rateImportance } from '../archive';
import { computeOpenThreads } from '../payload/payloadWorldContext';
import { fetchFacts, scanCharacterProfile, scanInventory, mergeSealEntries } from '../campaign-state';
import { loadChapters } from '../../store/campaignStore';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from '../npc';
import { llmCall } from '../../utils/llmCall';
import {
    backgroundQueue,
    extractJson,
    ANCHOR_BEFORE_INPUT,
    INPUT_DELIMITER,
    JSON_ARRAY_ONLY_FOOTER,
    TTRPG_PERSONA_GM_ASSISTANT,
    joinPromptSections,
} from '../infrastructure';

const PRESENT_HEADER_RE = /👥\s*\[Present\]\s*[:\-–—]?\s*(.+?)(?:\n|$)/i;

async function tryWithFallback<T>(
    label: string,
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
): Promise<T> {
    try { return await primary(); }
    catch (err) {
        console.warn(`[${label}] primary failed, falling back:`, err);
        return await fallback();
    }
}

export function parsePresentHeader(gmText: string): string[] {
    const match = gmText.match(PRESENT_HEADER_RE);
    if (!match) return [];
    const raw = match[1].trim();
    return raw
        .split(/[,;]\s*/)
        .map(n => n.trim())
        .filter(n => n.length > 0 && n.length < 40);
}

export function resolveNPCIds(names: string[], ledger: NPCEntry[]): string[] {
    const { existingNpcs } = classifyNPCNames(names, ledger);
    return existingNpcs.map(n => n.id);
}

async function auxWitnessFallback(gmText: string, ledger: NPCEntry[], provider: LLMProvider): Promise<string[]> {
    const roster = ledger.map(n => `- ${n.name} (id: ${n.id}${n.aliases ? ', aka: ' + n.aliases : ''})`).join('\n');
    const prompt = joinPromptSections(
        TTRPG_PERSONA_GM_ASSISTANT,

        `TASK: Given the GM narration below, list the canonical NPC IDs of characters who are PHYSICALLY PRESENT in the scene (not just mentioned).
Output schema: a JSON array of NPC ID strings, e.g. ["npc_1", "npc_3"]. If no NPCs are physically present, return [].`,

        JSON_ARRAY_ONLY_FOOTER,
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        `NPC LEDGER:\n${roster || '(none)'}`,
        `GM NARRATION:\n${gmText.slice(0, 2000)}`,
    );

    try {
        const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 200, thinkingEffort: 'off' });
        const cleaned = extractJson(raw.trim());
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) {
            const knownIds = new Set(ledger.map(n => n.id));
            return parsed.filter((id: unknown) => typeof id === 'string' && knownIds.has(id));
        }
    } catch {}
    return [];
}

export async function runCombinedSeal(
    activeCampaignId: string,
    chapter: ArchiveChapter,
    provider: LLMProvider,
    npcLedger: NPCEntry[],
    archiveIndex?: ArchiveIndexEntry[],
    openThreads?: string[]
): Promise<CombinedSealResult> {
    const allScenes = await api.archive.getIndex(activeCampaignId);
    const startNum = parseInt(chapter.sceneRange[0], 10);
    const endNum = parseInt(chapter.sceneRange[1], 10);
    const chapterScenes = allScenes.filter(s => {
        const sn = parseInt(s.sceneId);
        return sn >= startNum && sn <= endNum;
    });
    if (chapterScenes.length === 0) {
        return { summary: null, divergences: [] };
    }

    // Seal from full verbatim scene content (user + GM), not the 120-char index
    // snippet — the chapter summary, divergence facts, witness corrections and
    // scene events all derive from GM narration, which lives only in the scene
    // record, never the index entry (AUDIT F3). Falls back to the snippet only
    // for any scene the store can't return.
    const chapterSceneIds = chapterScenes.map(s => s.sceneId);
    const fullScenes = await api.archive.getScenes(activeCampaignId, chapterSceneIds);
    const contentById = new Map(fullScenes.map(s => [s.sceneId, s.content]));
    const scenesContent = chapterScenes.map(s => ({
        sceneId: s.sceneId,
        content: contentById.get(s.sceneId) ?? s.userSnippet ?? '',
    }));
    const sceneIds = chapter.sceneIds?.length
        ? chapter.sceneIds
        : Array.from({ length: endNum - startNum + 1 }, (_, i) => String(startNum + i).padStart(3, '0'));
    const npcInfo = npcLedger.map(n => ({
        id: n.id,
        name: n.name,
        aliases: n.aliases ?? '',
    }));

    // Build witness data for the seal prompt
    const indexEntries = archiveIndex
        ? archiveIndex.filter(e => {
            const sn = parseInt(e.sceneId);
            return sn >= startNum && sn <= endNum;
        }).map(e => ({ sceneId: e.sceneId, npcsWitnessed: e.npcsWitnessed }))
        : undefined;

    return sealChapterCombined(provider, scenesContent, chapter.chapterId, chapter.title, sceneIds, npcInfo, indexEntries, 2, openThreads);
}

export async function handlePostTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    activeCampaignId: string,
    npcLedger: NPCEntry[],
    lastAssistantContent: string
): Promise<void> {
    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent);
    const appendedSceneId = appendData?.sceneId;

    if (appendData) {
        const freshIndex = await api.archive.getIndex(activeCampaignId);
        callbacks.setArchiveIndex(freshIndex);
        console.log(`[Archive] Appended scene #${appendedSceneId}`);
        callbacks.addMessage({
            id: uid(),
            role: 'system',
            name: 'scene-marker',
            content: `Scene ${appendedSceneId}`,
            timestamp: Date.now(),
        });
    }

    const extractedNames = extractNPCNames(lastAssistantContent);

    // ── Update on-stage NPC tracking from 👥 [Present] header ──
    const presentHeaderNames = parsePresentHeader(lastAssistantContent);
    if (presentHeaderNames.length > 0) {
        const onStageIds = resolveNPCIds(presentHeaderNames, npcLedger);
        callbacks.setOnStageNpcIds?.(onStageIds);
        console.log(`[NPC] present-header parsed=[${onStageIds.join(',')}] source=header`);
        console.log(`[OnStage] Updated from 👥 header: ${onStageIds.join(', ')}`);
    } else {
        // Header empty — derive from body extract for continuity
        const { existingNpcs: bodyNpcs } = classifyNPCNames(extractedNames, npcLedger);
        if (bodyNpcs.length > 0) {
            const bodyIds = bodyNpcs.map(n => n.id);
            callbacks.setOnStageNpcIds?.(bodyIds);
            console.log(`[NPC] present-header parsed=[${bodyIds.join(',')}] source=body_fallback`);
        } else {
            console.log(`[NPC] present-header parsed=[] source=empty`);
        }
    }

    if (callbacks.setSemanticFacts) {
        const cid = activeCampaignId;
        const cb = callbacks;
        backgroundQueue.push('Refresh-Facts', async () => {
            try {
                const freshFacts = await fetchFacts(cid);
                cb.setSemanticFacts!(freshFacts);
            } catch (err) {
                console.warn('[TurnPostProcess] Refresh-Facts failed:', err);
            }
        }).catch((e) => console.warn('[TurnPostProcess] Refresh-Facts queue push failed:', e));
    }

    backgroundQueue.push('Seal-Chapter', () => handleSealChapter(state, callbacks, activeCampaignId))
        .catch((e) => console.warn('[TurnPostProcess] Seal-Chapter queue push failed:', e));

    queueIndexPatch(state, callbacks, appendedSceneId, displayInput, lastAssistantContent, npcLedger, activeCampaignId);

    queueNPCValidation(state, callbacks, extractedNames, npcLedger, lastAssistantContent, activeCampaignId);

    runBookkeepingScans(state, callbacks, appendedSceneId);

    runNPCPressureScan(state, callbacks, npcLedger, displayInput, lastAssistantContent);
}

function queueIndexPatch(
    state: TurnState,
    callbacks: TurnCallbacks,
    appendedSceneId: string | undefined,
    displayInput: string,
    lastAssistantContent: string,
    npcLedger: NPCEntry[],
    activeCampaignId: string
): void {
    if (appendedSceneId) {
        const sceneId = appendedSceneId;
        const userText = displayInput;
        const gmText = lastAssistantContent;
        const npcLedgerSnap = npcLedger;
        const cid = activeCampaignId;
        const summarizerProvider = state.getFreshSummarizerProvider?.();
        const storyProvider = state.getFreshProvider();

        // Pre-compute witness data synchronously so it's captured before the
        // background task fires — avoids racing against message state changes.
        const headerNames = parsePresentHeader(gmText);
        const headerIds = resolveNPCIds(headerNames, npcLedgerSnap);

        // ── Fused index patch (importance + witness in one read/write) ──
        backgroundQueue.push('Index-Patch', async () => {
            let changed = false;
            let index = await api.archive.getIndex(cid);
            const entry = index.find(e => e.sceneId === sceneId);
            if (!entry) return;

            // (a) Importance rating — summarizer-primary, story fallback (Max tier only)
            const ratingProvider = summarizerProvider ?? storyProvider;
            if (ratingProvider && tierAllows(state.settings.aiTier, 'importanceRating')) {
                try {
                    const recentMsgs = state.getMessages();
                    const llmImportance = await tryWithFallback(
                        'ImportanceRater',
                        () => rateImportance(ratingProvider, userText, gmText, recentMsgs),
                        () => storyProvider ? rateImportance(storyProvider, userText, gmText, recentMsgs) : Promise.resolve(3),
                    );
                    if (llmImportance !== entry.importance) {
                        entry.importance = llmImportance;
                        changed = true;
                        console.log(`[ImportanceRater] Scene #${sceneId}: → ${llmImportance}`);
                    }
                } catch (e) { console.warn('[TurnPostProcess] Importance rating failed:', e); }
            }

            // (b) Witness capture
            if (headerIds.length > 0) {
                entry.npcsWitnessed = headerIds;
                entry.witnessSource = 'header' as WitnessSource;
                changed = true;
                console.log(`[Witness] Scene #${sceneId}: header parse → ${headerIds.join(', ')}`);
            } else {
                let resolvedIds: string[] = [];
                let source: WitnessSource = 'empty';

                const extractionProvider = state.getExtractionProvider?.();
                if (tierAllows(state.settings.aiTier, 'witnessAux') && extractionProvider?.endpoint) {
                    try {
                        const auxIds = await auxWitnessFallback(gmText, npcLedgerSnap, extractionProvider);
                        if (auxIds.length > 0) {
                            resolvedIds = auxIds;
                            source = 'aux_fallback';
                        }
                    } catch { /* extraction failed, fall through */ }
                }

                if (resolvedIds.length === 0) {
                    const bodyNames = extractNPCNames(gmText);
                    const { existingNpcs } = classifyNPCNames(bodyNames, npcLedgerSnap);
                    resolvedIds = existingNpcs.map(n => n.id);
                    source = resolvedIds.length > 0 ? 'body_fallback' : 'empty';
                }

                entry.npcsWitnessed = resolvedIds.length > 0 ? resolvedIds : undefined;
                entry.witnessSource = source;
                changed = true;
                console.log(`[Witness] Scene #${sceneId}: ${source} → ${resolvedIds.join(', ') || '(empty)'}`);
            }

            if (changed) {
                const { offlineStorage } = await import('../storage');
                await offlineStorage.archive.updateIndex(cid, index);
                callbacks.setArchiveIndex([...index]);
            }
        }).catch((e) => console.warn('[TurnPostProcess] Index-Patch queue push failed:', e));
    }
}

function queueNPCValidation(
    state: TurnState,
    callbacks: TurnCallbacks,
    extractedNames: string[],
    npcLedger: NPCEntry[],
    lastAssistantContent: string,
    activeCampaignId: string
): void {
    if (extractedNames.length > 0 && tierAllows(state.settings.aiTier, 'npcValidate')) {
        backgroundQueue.push('NPC-Validate', async () => {
            const provider = state.getExtractionProvider?.() ?? state.getFreshProvider();
            const validatedNames = provider ?
                await validateNPCCandidates(provider, extractedNames, lastAssistantContent) :
                extractedNames;

            if (validatedNames.length > 0) {
                const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger);
                const allMsgs = state.getMessages();

                for (const potentialName of newNames) {
                    if (!tierAllows(state.settings.aiTier, 'npcProfileGen')) break;
                    console.log(`[NPC Auto-Gen] Spawning profile: "${potentialName}"`);
                    const storyProvider = state.getFreshProvider();
                    const summarizerProvider = state.getFreshSummarizerProvider?.();
                    if (storyProvider) {
                        const genTask = summarizerProvider
                            ? tryWithFallback(
                                `NPC-Profile-${potentialName}`,
                                () => generateNPCProfile(storyProvider, allMsgs, potentialName, callbacks.addNPC, npcLedger, activeCampaignId, state.items, callbacks.addItemDef, state.skills, callbacks.addSkillDef),
                                () => generateNPCProfile(summarizerProvider, allMsgs, potentialName, callbacks.addNPC, npcLedger, activeCampaignId, state.items, callbacks.addItemDef, state.skills, callbacks.addSkillDef),
                              )
                            : generateNPCProfile(storyProvider, allMsgs, potentialName, callbacks.addNPC, npcLedger, activeCampaignId, state.items, callbacks.addItemDef, state.skills, callbacks.addSkillDef);
                        genTask.catch((e) => console.warn(`[TurnPostProcess] NPC profile gen failed for "${potentialName}":`, e));
                    }
                }

                if (existingNpcsToUpdate.length > 0 && tierAllows(state.settings.aiTier, 'npcUpdate')) {
                    const archiveIndex = state.archiveIndex;
                    const sceneNow = archiveIndex.length > 0
                        ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
                        : 0;
                    const cooldown = NPC_UPDATE_COOLDOWN[state.settings.aiTier ?? 'pro'];
                    const npcsEligibleForUpdate = existingNpcsToUpdate.filter(npc =>
                        sceneNow - (npc.lastUpdateScene ?? -Infinity) >= cooldown
                    );

                    if (npcsEligibleForUpdate.length > 0) {
                        const updateProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
                        if (updateProvider) {
                            updateExistingNPCs(updateProvider, allMsgs, npcsEligibleForUpdate, callbacks.updateNPC, activeCampaignId)
                                .then(() => {
                                    for (const npc of npcsEligibleForUpdate) {
                                        callbacks.updateNPC(npc.id, { lastUpdateScene: sceneNow });
                                    }
                                })
                                .catch((e) => console.warn('[TurnPostProcess] updateExistingNPCs failed:', e));
                        }
                    }

                    if (tierAllows(state.settings.aiTier, 'drivesBackfill')) {
                        const npcsNeedingDrives = existingNpcsToUpdate.filter(n => !n.drives);
                        if (npcsNeedingDrives.length > 0) {
                            const backfillProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
                            if (backfillProvider) {
                                backgroundQueue.push('NPC-Drives-Backfill', () => backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, callbacks.updateNPC)).catch((e) => console.warn('[TurnPostProcess] NPC drives backfill failed:', e));
                            }
                        }
                    }
                }
            }
        }).catch((e) => console.warn('[TurnPostProcess] NPC-Validate queue push failed:', e));
    }
}

function runBookkeepingScans(
    state: TurnState,
    callbacks: TurnCallbacks,
    appendedSceneId: string | undefined
): void {
    const turnCount = state.incrementBookkeepingTurnCounter();
    if (turnCount >= state.autoBookkeepingInterval && appendedSceneId) {
        state.resetBookkeepingTurnCounter();
        const bkProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;
            const allMsgs = state.getMessages();
            if (tierAllows(state.settings.aiTier, 'profileScan')) {
                backgroundQueue.push('Profile-Scan', async () => {
                    const newProfile = await scanCharacterProfile(bkProvider, allMsgs, state.context.characterProfile);
                    callbacks.updateContext({ characterProfile: newProfile, characterProfileLastScene: sceneId });
                }).catch((e) => console.warn('[TurnPostProcess] Profile scan failed:', e));
            }

            if (tierAllows(state.settings.aiTier, 'inventoryScan')) {
                backgroundQueue.push('Inventory-Scan', async () => {
                    const newInventory = await scanInventory(bkProvider, allMsgs, state.context.inventory);
                    callbacks.updateContext({ inventory: newInventory, inventoryLastScene: sceneId });
                }).catch((e) => console.warn('[TurnPostProcess] Inventory scan failed:', e));
            }
        }
    }
}

function runNPCPressureScan(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
    displayInput: string,
    lastAssistantContent: string
): void {
    if (npcLedger && npcLedger.length > 0) {
        const archiveIndex = state.archiveIndex;
        const sceneNumber = archiveIndex.length > 0
            ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
            : 0;

        const archivedNPCs = npcLedger.filter(n => n.archived);
        const activeNPCs = npcLedger.filter(n => !n.archived);

        // Auto-restore archived NPCs whose names are mentioned in player input or GM response
        if (archivedNPCs.length > 0 && callbacks.restoreNPC) {
            const toRestoreFromPlayer = findArchivedToRestore(displayInput, archivedNPCs);
            const toRestoreFromGM = lastAssistantContent ? findArchivedToRestore(lastAssistantContent, archivedNPCs) : [];
            const toRestore = [...new Set([...toRestoreFromPlayer, ...toRestoreFromGM])];
            for (const id of toRestore) {
                callbacks.restoreNPC(id);
                const npc = archivedNPCs.find(n => n.id === id);
                console.log(`[NPC Archive] Restored "${npc?.name}" (mentioned in conversation)`);
            }
        }

        const pressureUpdates = scanPressure(displayInput, activeNPCs, lastAssistantContent);
        if (pressureUpdates.length > 0) {
            for (const update of pressureUpdates) {
                const npc = activeNPCs.find(n => n.id === update.npcId);
                if (!npc) continue;
                const patch = buildPressurePatch(npc, update, sceneNumber);
                callbacks.updateNPC(npc.id, patch);
                if (update.reasons.length > 0) {
                    console.log(`[PressureTracker] ${npc.name}: ignored=${patch.pressure?.ignored?.toFixed(1)}, engaged=${patch.pressure?.engaged?.toFixed(1)} — ${update.reasons.join(', ')}`);
                }
            }
        }

        // Auto-archive stale NPCs (cheap decay math, no LLM)
        if (callbacks.archiveNPC) {
            const threshold = state.settings.autoArchiveStaleNPCsTurns ?? 15;
            if (threshold > 0) {
                for (const npc of activeNPCs) {
                    const { shouldArchive, turnsSince } = shouldArchiveNPC(npc, sceneNumber, threshold);
                    if (shouldArchive) {
                        callbacks.archiveNPC(npc.id, sceneNumber, `stale: no engagement for ${turnsSince} turns`);
                        console.log(`[NPC Archive] Auto-archived "${npc.name}" (${turnsSince} turns since last engagement)`);
                    }
                }
            }
        }
    }
}

async function handleSealChapter(state: TurnState, callbacks: TurnCallbacks, activeCampaignId: string) {
    const currentChapters = await loadChapters(activeCampaignId);

    if (currentChapters.length > 0 && shouldAutoSeal(currentChapters).shouldSeal) {
        try {
            const result = sealChapter(currentChapters);
            if (!result) return;

            const sealed = result.sealedChapter;
            await api.chapters.update(activeCampaignId, sealed.chapterId, sealed);
            await api.chapters.create(activeCampaignId);

            if (sealed.invalidated) {
                console.warn(`[SealChapter] Chapter ${sealed.chapterId} is marked invalidated — proceeding with seal normally`);
            }

            const summarizerProvider = state.getFreshSummarizerProvider?.();
            const storyProvider = state.getFreshProvider();
            const sealProvider = summarizerProvider ?? storyProvider;
            if (sealProvider && tierAllows(state.settings.aiTier, 'sealChapter')) {
                const alreadySealedChapters = currentChapters.filter(c => c.sealedAt && c.chapterId !== sealed.chapterId);
                const openThreadsList = computeOpenThreads(alreadySealedChapters).map(t => t.text);
                const sealResult = await tryWithFallback(
                    'SealChapter',
                    () => runCombinedSeal(activeCampaignId, sealed, summarizerProvider ?? storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreadsList),
                    () => runCombinedSeal(activeCampaignId, sealed, storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreadsList),
                );

                if (sealResult.summary) {
                    await api.chapters.update(activeCampaignId, sealed.chapterId, {
                        title: sealResult.summary.title,
                        summary: sealResult.summary.summary,
                        keywords: sealResult.summary.keywords,
                        npcs: sealResult.summary.npcs,
                        majorEvents: sealResult.summary.majorEvents,
                        unresolvedThreads: sealResult.summary.unresolvedThreads,
                        tone: sealResult.summary.tone,
                        themes: sealResult.summary.themes,
                        ...(sealResult.summary.npcInnerState && { npcInnerState: sealResult.summary.npcInnerState }),
                        ...(sealResult.resolvedThreads && sealResult.resolvedThreads.length > 0 && { resolvedThreads: sealResult.resolvedThreads }),
                    });
                }

                // ── Apply witness corrections from seal audit ──
                if (sealResult.witnessCorrections && Object.keys(sealResult.witnessCorrections).length > 0) {
                    try {
                        const index = await api.archive.getIndex(activeCampaignId);
                        let corrected = false;
                        for (const entry of index) {
                            const corrections = sealResult.witnessCorrections[entry.sceneId];
                            if (corrections) {
                                const npcLedger = state.npcLedger ?? [];
                                const validIds = corrections.filter((id: string) =>
                                    npcLedger.some(n => n.id === id)
                                );
                                if (validIds.length > 0) {
                                    entry.npcsWitnessed = validIds;
                                    entry.witnessSource = 'seal_correction' as WitnessSource;
                                    corrected = true;
                                }
                            }
                        }
                        if (corrected) {
                            const { offlineStorage } = await import('../storage');
                            await offlineStorage.archive.updateIndex(activeCampaignId, index);
                            callbacks.setArchiveIndex([...index]);
                            console.log(`[CombinedSeal] Applied witness corrections for ${Object.keys(sealResult.witnessCorrections).length} scenes`);
                        }
                    } catch (e) { console.warn('[CombinedSeal] Failed to apply witness corrections:', e); }
                }

                // ── Persist scene events from combined seal ──
                if (sealResult.sceneEventMap && Object.keys(sealResult.sceneEventMap).length > 0) {
                    try {
                        const index = await api.archive.getIndex(activeCampaignId);
                        let eventCount = 0;
                        for (const entry of index) {
                            const events = sealResult.sceneEventMap[entry.sceneId];
                            if (events && events.length > 0) {
                                entry.events = events;
                                eventCount++;
                            }
                        }
                        if (eventCount > 0) {
                            const { offlineStorage } = await import('../storage');
                            await offlineStorage.archive.updateIndex(activeCampaignId, index);
                            callbacks.setArchiveIndex([...index]);
                            console.log(`[Seal] Persisted scene events for ${eventCount} scenes`);
                        }
                    } catch (e) { console.warn('[Seal] Failed to persist scene events:', e); }
                }

                const liveRegister = state.divergenceRegister;
                if (sealResult.divergences.length > 0 && liveRegister && callbacks.setDivergenceRegister) {
                    const sceneIds = sealed.sceneIds?.length
                        ? sealed.sceneIds
                        : [sealed.sceneRange[1]];
                    const merged = mergeSealEntries(liveRegister, sealResult.divergences, sceneIds[sceneIds.length - 1] ?? '000');
                    callbacks.setDivergenceRegister(merged);
                    console.log(`[CombinedSeal] Chapter ${sealed.chapterId}: ${sealResult.divergences.length} entries extracted`);
                } else if (sealResult.divergenceParseError) {
                    toast.warning('Chapter sealed but divergence facts failed to parse');
                }
            }

            const updatedChapters = await loadChapters(activeCampaignId);
            if (callbacks.setChapters) callbacks.setChapters(updatedChapters);
            toast.success('Chapter sealed');
        } catch (err) {
            console.error('[SealChapter] Failed to seal chapter:', err);
            toast.error('Failed to seal chapter');
        }
    }
}
