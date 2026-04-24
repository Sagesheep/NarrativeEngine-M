import type { NPCEntry } from '../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { generateNPCProfile, updateExistingNPCs } from './chatEngine';
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

    if (extractedNames.length > 0) {
        const provider = state.getFreshProvider();
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
}

async function handleSealChapter(state: TurnState, callbacks: TurnCallbacks, activeCampaignId: string) {
    const currentChapters = state.chapters;
    const headerIndex = state.context.headerIndex;

    if (currentChapters.length > 0 && shouldAutoSeal(currentChapters, headerIndex).shouldSeal) {
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

            const updatedChapters = await loadChapters(activeCampaignId);
            if (callbacks.setChapters) callbacks.setChapters(updatedChapters);
            toast.success('Chapter sealed');
        } catch (err) {
            toast.error('Failed to seal chapter');
        }
    }
}
