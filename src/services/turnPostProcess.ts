import type { NPCEntry } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { generateNPCProfile, updateExistingNPCs, backfillNPCDrives } from './chatEngine';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { api } from './apiClient';
import { toast } from '../components/Toast';
import { shouldAutoSeal, sealChapter } from './archiveChapterEngine';
import { generateChapterSummary } from './saveFileEngine';
import { fetchFacts } from './semanticMemory';
import { loadChapters } from '../store/campaignStore';
import { backgroundQueue } from './backgroundQueue';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { rateImportance } from './importanceRater';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from './npcPressureTracker';
import { extractDivergences, mergeEntries, pruneChapterEntries, EMPTY_REGISTER } from './divergenceRegister';

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
    }

    const extractedNames = extractNPCNames(lastAssistantContent);

    if (callbacks.setSemanticFacts) {
        try {
            const freshFacts = await fetchFacts(activeCampaignId);
            callbacks.setSemanticFacts(freshFacts);
        } catch {}
    }

    await handleSealChapter(state, callbacks, activeCampaignId);

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

    if (appendedSceneId && state.settings.autoExtractDivergences !== false) {
        const divProvider = state.getFreshProvider();
        if (divProvider && callbacks.setDivergenceRegister) {
            const sid = appendedSceneId;
            const userText = displayInput;
            const gmText = lastAssistantContent;
            const currentRegister = state.divergenceRegister || EMPTY_REGISTER;
            backgroundQueue.push('Divergence-Extract', async () => {
                try {
                    const sceneText = `[User]: ${userText.slice(0, 600)}\n[GM]: ${gmText.slice(0, 1200)}`;
                    const { entries } = await extractDivergences(divProvider, sceneText, sid, currentRegister);
                    if (entries.length > 0) {
                        const merged = mergeEntries(currentRegister, entries, sid);
                        callbacks.setDivergenceRegister!(merged);
                        const msgId = state.getMessages().slice().reverse().find(m => m.role === 'assistant')?.id;
                        if (msgId && callbacks.updateMessageDivergence) {
                            callbacks.updateMessageDivergence(msgId, entries.map(e => e.id));
                        }
                        console.log(`[DivergenceRegister] Scene #${sid}: ${entries.length} entries extracted`);
                    }
                } catch (e) { console.warn('[TurnPostProcess] Divergence extraction failed:', e); }
            }).catch((e) => console.warn('[TurnPostProcess] Divergence queue push failed:', e));
        }
    }

    if (extractedNames.length > 0) {
        const provider = state.getFreshAuxiliaryProvider?.() ?? state.getFreshProvider();
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
    const currentChapters = state.chapters;

    if (currentChapters.length > 0 && shouldAutoSeal(currentChapters).shouldSeal) {
        try {
            const result = await sealChapter(currentChapters);
            if (!result) return;

            const sealed = { ...result.sealedChapter, sealedAt: Date.now() };
            await api.chapters.update(activeCampaignId, sealed.chapterId, sealed);
            await api.chapters.create(activeCampaignId);

            const provider = state.getFreshProvider();
            if (provider) {
                const allScenes = await api.archive.getIndex(activeCampaignId);
                const chapterScenes = allScenes.filter(s => {
                    const sn = parseInt(s.sceneId);
                    return sn >= parseInt(sealed.sceneRange[0]) && sn <= parseInt(sealed.sceneRange[1]);
                });
                if (chapterScenes.length > 0) {
                    const scenesContent = chapterScenes.map(s => ({ sceneId: s.sceneId, content: s.userSnippet || '' }));
                    const summary = await generateChapterSummary(provider, scenesContent, sealed.title);
                    if (summary) {
                        await api.chapters.update(activeCampaignId, sealed.chapterId, {
                            title: summary.title,
                            summary: summary.summary,
                            keywords: summary.keywords,
                            npcs: summary.npcs,
                            majorEvents: summary.majorEvents,
                            unresolvedThreads: summary.unresolvedThreads,
                            tone: summary.tone,
                            themes: summary.themes,
                        });
                    }
                }
            }

            // Prune divergence register entries from the sealed chapter
            const liveRegister = state.divergenceRegister;
            if (liveRegister && liveRegister.entries.length > 0 && callbacks.setDivergenceRegister) {
                try {
                    const allChaptersNow = await loadChapters(activeCampaignId);
                    const sealProvider = state.getFreshProvider();
                    if (sealProvider) {
                        const pruned = await pruneChapterEntries(sealProvider, sealed, liveRegister, allChaptersNow);
                        callbacks.setDivergenceRegister(pruned);
                        console.log(`[DivergenceRegister] Chapter ${sealed.chapterId} sealed: ${liveRegister.entries.length} → ${pruned.entries.length} entries`);
                    }
                } catch (e) { console.warn('[TurnPostProcess] Chapter divergence prune failed:', e); }
            }

            const updatedChapters = await loadChapters(activeCampaignId);
            if (callbacks.setChapters) callbacks.setChapters(updatedChapters);
            toast.success('Chapter sealed');
        } catch (err) {
            toast.error('Failed to seal chapter');
        }
    }
}
