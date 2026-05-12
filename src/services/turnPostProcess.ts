import type { NPCEntry, ArchiveChapter, DivergenceEntry, LLMProvider } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { generateNPCProfile, updateExistingNPCs, backfillNPCDrives } from './chatEngine';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { api } from './apiClient';
import { uid } from '../utils/uid';
import { toast } from '../components/Toast';
import { shouldAutoSeal, sealChapter } from './archiveChapterEngine';
import { sealChapterCombined, type ChapterSummaryOutput } from './saveFileEngine';
import { fetchFacts } from './semanticMemory';
import { loadChapters } from '../store/campaignStore';
import { backgroundQueue } from './backgroundQueue';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { rateImportance } from './importanceRater';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from './npcPressureTracker';
import { mergeSealEntries } from './divergenceRegister';

export type CombinedSealResult = {
    summary: ChapterSummaryOutput | null;
    divergences: DivergenceEntry[];
    divergenceParseError?: boolean;
};

export async function runCombinedSeal(
    activeCampaignId: string,
    chapter: ArchiveChapter,
    provider: LLMProvider,
    npcLedger: NPCEntry[],
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

    return sealChapterCombined(provider, scenesContent, chapter.chapterId, chapter.title, sceneIds, npcInfo);
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
        const ratingProvider = state.getFreshProvider();
        if (ratingProvider) {
            const sceneId = appendedSceneId;
            const userText = displayInput;
            const gmText = lastAssistantContent;
            const recentMsgs = state.getMessages();
            const cid = activeCampaignId;
            backgroundQueue.push('Importance-Rate', async () => {
                try {
                    const llmImportance = await rateImportance(ratingProvider, userText, gmText, recentMsgs);
                    const index = await api.archive.getIndex(cid);
                    const entry = index.find(e => e.sceneId === sceneId);
                    if (entry && llmImportance !== entry.importance) {
                        entry.importance = llmImportance;
                        const { offlineStorage } = await import('./storage');
                        await offlineStorage.archive.updateIndex(cid, index);
                        callbacks.setArchiveIndex([...index]);
                        console.log(`[ImportanceRater] Scene #${sceneId}: heuristic→${entry.importance} → LLM→${llmImportance}`);
                    }
                } catch (e) { console.warn('[TurnPostProcess] Importance rating failed:', e); }
            }).catch((e) => console.warn('[TurnPostProcess] backgroundQueue push failed:', e));
        }
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
                        generateNPCProfile(genProvider, allMsgs, potentialName, callbacks.addNPC).catch((e) => console.warn(`[TurnPostProcess] NPC profile gen failed for "${potentialName}":`, e));
                    }
                }

                if (existingNpcsToUpdate.length > 0) {
                    const updateProvider = state.getFreshProvider();
                    if (updateProvider) {
                        updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, callbacks.updateNPC).catch((e) => console.warn('[TurnPostProcess] updateExistingNPCs failed:', e));
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
                const sealResult = await runCombinedSeal(activeCampaignId, sealed, provider, state.npcLedger ?? []);

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
