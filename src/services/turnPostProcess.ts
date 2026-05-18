import type { NPCEntry, ArchiveChapter, ArchiveIndexEntry, LLMProvider, WitnessSource } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { generateNPCProfile, updateExistingNPCs, backfillNPCDrives } from './chatEngine';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { api } from './apiClient';
import { uid } from '../utils/uid';
import { toast } from '../components/Toast';
import { shouldAutoSeal, sealChapter } from './archiveChapterEngine';
import { sealChapterCombined, type CombinedSealResult } from './saveFileEngine';
import { fetchFacts } from './semanticMemory';
import { loadChapters } from '../store/campaignStore';
import { backgroundQueue } from './backgroundQueue';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { rateImportance } from './importanceRater';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from './npcPressureTracker';
import { mergeSealEntries } from './divergenceRegister';
import { llmCall } from '../utils/llmCall';
import { extractJson } from './payloadBuilder';

const PRESENT_HEADER_RE = /👥\s*\[Present\]\s*[:\-–—]?\s*(.+?)(?:\n|$)/i;

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
    const prompt = `You are an NPC presence classifier. Given the GM narration below, list the canonical NPC IDs of characters who are PHYSICALLY PRESENT in the scene (not just mentioned).

NPC LEDGER:
${roster || '(none)'}

GM NARRATION:
${gmText.slice(0, 2000)}

Return ONLY a JSON array of NPC IDs, e.g. ["npc_1", "npc_3"]. If no NPCs are physically present, return [].`;

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

    const scenesContent = chapterScenes.map(s => ({ sceneId: s.sceneId, content: s.userSnippet || '' }));
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

    return sealChapterCombined(provider, scenesContent, chapter.chapterId, chapter.title, sceneIds, npcInfo, indexEntries);
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
            } catch {}
        }).catch((e) => console.warn('[TurnPostProcess] Refresh-Facts queue push failed:', e));
    }

    backgroundQueue.push('Seal-Chapter', () => handleSealChapter(state, callbacks, activeCampaignId))
        .catch((e) => console.warn('[TurnPostProcess] Seal-Chapter queue push failed:', e));

    if (appendedSceneId) {
        const sceneId = appendedSceneId;
        const userText = displayInput;
        const gmText = lastAssistantContent;
        const npcLedgerSnap = npcLedger;
        const cid = activeCampaignId;
        const ratingProvider = state.getFreshProvider();

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

            // (a) Importance rating
            if (ratingProvider) {
                try {
                    const recentMsgs = state.getMessages();
                    const llmImportance = await rateImportance(ratingProvider, userText, gmText, recentMsgs);
                    if (llmImportance !== entry.importance) {
                        entry.importance = llmImportance;
                        changed = true;
                        console.log(`[ImportanceRater] Scene #${sceneId}: heuristic→${entry.importance} → LLM→${llmImportance}`);
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

                const auxProvider = state.getFreshAuxiliaryProvider?.();
                if (auxProvider?.endpoint) {
                    try {
                        const auxIds = await auxWitnessFallback(gmText, npcLedgerSnap, auxProvider);
                        if (auxIds.length > 0) {
                            resolvedIds = auxIds;
                            source = 'aux_fallback';
                        }
                    } catch { /* aux failed, fall through */ }
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
                const { offlineStorage } = await import('./storage');
                await offlineStorage.archive.updateIndex(cid, index);
                callbacks.setArchiveIndex([...index]);
            }
        }).catch((e) => console.warn('[TurnPostProcess] Index-Patch queue push failed:', e));
    }

    if (extractedNames.length > 0) {
        backgroundQueue.push('NPC-Validate', async () => {
            const aux = state.getFreshAuxiliaryProvider?.();
            const provider = (aux && aux.modelName) ? aux : state.getFreshProvider();
            if (aux && !aux.modelName) {
                console.info('[NPC Validator] auxiliaryAI not configured — falling back to story provider. Configure a cheap model (e.g. Haiku/Flash) as Auxiliary AI for faster NPC validation.');
            }
            const validatedNames = provider ?
                await validateNPCCandidates(provider, extractedNames, lastAssistantContent) :
                extractedNames;

            if (validatedNames.length > 0) {
                const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger);
                const allMsgs = state.getMessages();

                for (const potentialName of newNames) {
                    console.log(`[NPC Auto-Gen] Spawning profile: "${potentialName}"`);
                    const genProvider = state.getFreshProvider();
                    if (genProvider) {
                        generateNPCProfile(genProvider, allMsgs, potentialName, callbacks.addNPC, npcLedger, activeCampaignId).catch((e) => console.warn(`[TurnPostProcess] NPC profile gen failed for "${potentialName}":`, e));
                    }
                }

                if (existingNpcsToUpdate.length > 0) {
                    const updateProvider = state.getFreshProvider();
                    if (updateProvider) {
                        updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, callbacks.updateNPC, activeCampaignId).catch((e) => console.warn('[TurnPostProcess] updateExistingNPCs failed:', e));
                    }

                    const npcsNeedingDrives = existingNpcsToUpdate.filter(n => !n.drives);
                    if (npcsNeedingDrives.length > 0) {
                        const backfillProvider = state.getFreshProvider();
                        if (backfillProvider) {
                            backgroundQueue.push('NPC-Drives-Backfill', () => backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, callbacks.updateNPC)).catch((e) => console.warn('[TurnPostProcess] NPC drives backfill failed:', e));
                        }
                    }
                }
            }
        }).catch((e) => console.warn('[TurnPostProcess] NPC-Validate queue push failed:', e));
    }

    const turnCount = state.incrementBookkeepingTurnCounter();
    if (turnCount >= state.autoBookkeepingInterval && appendedSceneId) {
        state.resetBookkeepingTurnCounter();
        const bkProvider = state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;
            const allMsgs = state.getMessages();
            backgroundQueue.push('Profile-Scan', async () => {
                const newProfile = await scanCharacterProfile(bkProvider, allMsgs, state.context.characterProfile);
                callbacks.updateContext({ characterProfile: newProfile, characterProfileLastScene: sceneId });
            }).catch((e) => console.warn('[TurnPostProcess] Profile scan failed:', e));

            backgroundQueue.push('Inventory-Scan', async () => {
                const newInventory = await scanInventory(bkProvider, allMsgs, state.context.inventory);
                callbacks.updateContext({ inventory: newInventory, inventoryLastScene: sceneId });
            }).catch((e) => console.warn('[TurnPostProcess] Inventory scan failed:', e));
        }
    }

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

            const provider = state.getFreshProvider();
            if (provider) {
                const sealResult = await runCombinedSeal(activeCampaignId, sealed, provider, state.npcLedger ?? [], state.archiveIndex);

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
                                const validIds = corrections.filter(id =>
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
                            const { offlineStorage } = await import('./storage');
                            await offlineStorage.archive.updateIndex(activeCampaignId, index);
                            callbacks.setArchiveIndex([...index]);
                            console.log(`[CombinedSeal] Applied witness corrections for ${Object.keys(sealResult.witnessCorrections).length} scenes`);
                        }
                    } catch (e) { console.warn('[CombinedSeal] Failed to apply witness corrections:', e); }
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
            toast.error('Failed to seal chapter');
        }
    }
}
