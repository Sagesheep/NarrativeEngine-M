import type { ChatMessage } from '../types';
import { useAppStore } from '../store/useAppStore';
import { api } from './apiClient';
import { offlineStorage } from './offlineStorage';
import { rateImportance } from './importanceRater';
import { generateChapterSummary } from './saveFileEngine';
import { backgroundQueue } from './backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { generateNPCProfile, updateExistingNPCs } from './chatEngine';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { toast } from '../components/Toast';
import { CHAPTER_SCENE_SOFT_CAP } from '../types';

export type TurnState = {
    activeCampaignId: string | null;
    displayInput: string;
    npcLedger: ChatMessage[] extends unknown ? import('../types').NPCEntry[] : never;
    getFreshProvider: () => import('../types').EndpointConfig | import('../types').ProviderConfig | null;
    getMessages: () => ChatMessage[];
    getFreshContext: () => import('../types').GameContext;
    setChapters: (chapters: import('../types').ArchiveChapter[]) => void;
    setArchiveIndex: (entries: import('../types').ArchiveIndexEntry[]) => void;
    setTimeline: (events: import('../types').TimelineEvent[]) => void;
    incrementBookkeepingTurnCounter: () => number;
    autoBookkeepingInterval: number;
    resetBookkeepingTurnCounter: () => void;
};

export type TurnCallbacks = {
    addNPC: (npc: import('../types').NPCEntry) => void;
    updateNPC: (id: string, patch: Partial<import('../types').NPCEntry>) => void;
    updateContext: (patch: Partial<import('../types').GameContext>) => void;
    setArchiveIndex: (entries: import('../types').ArchiveIndexEntry[]) => void;
    setTimeline?: (events: import('../types').TimelineEvent[]) => void;
    setChapters?: (chapters: import('../types').ArchiveChapter[]) => void;
};

export async function runPostTurnPipeline(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[]
): Promise<void> {
    const activeCampaignId = state.activeCampaignId!;
    const { displayInput, npcLedger } = state;

    let sceneImportance: number | undefined;
    const importanceProvider = state.getFreshProvider();
    if (importanceProvider) {
        try {
            sceneImportance = await rateImportance(importanceProvider, displayInput, lastAssistantContent, allMsgs);
            console.log(`[ImportanceRater] Scene rated: ${sceneImportance}/5`);
        } catch (err) {
            console.warn('[ImportanceRater] Failed (non-fatal):', err);
        }
    }

    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent);
    const appendedSceneId = appendData?.sceneId;
    if (!appendData) return;

    const freshIndex = await api.archive.getIndex(activeCampaignId);
    callbacks.setArchiveIndex(freshIndex);
    const freshTimeline = await api.timeline.get(activeCampaignId);
    callbacks.setTimeline?.(freshTimeline);
    console.log(`[Archive] Appended scene #${appendedSceneId}`);

    const freshChapters = await api.chapters.list(activeCampaignId);
    if (callbacks.setChapters) callbacks.setChapters(freshChapters);
    const openChapter = freshChapters.find(c => !c.sealedAt);
    if (openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP) {
        console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes — sealing...`);
        backgroundQueue.push('Chapter-AutoSeal', async () => {
            const sealResult = await api.chapters.seal(activeCampaignId);
            if (!sealResult) return;
            const sealedChapters = await api.chapters.list(activeCampaignId);
            if (callbacks.setChapters) callbacks.setChapters(sealedChapters);
            toast.info(`Chapter "${sealResult.sealedChapter?.title}" auto-sealed`);

            const sealProvider = state.getFreshProvider();
            if (sealProvider && sealResult.sealedChapter) {
                const ch = sealResult.sealedChapter;
                const startNum = parseInt(ch.sceneRange[0], 10);
                const endNum = parseInt(ch.sceneRange[1], 10);
                const sIds = Array.from({ length: endNum - startNum + 1 }, (_, i) =>
                    String(startNum + i).padStart(3, '0')
                );
                const chScenes = await offlineStorage.archive.getScenes(activeCampaignId, sIds);
                const summaryPatch = await generateChapterSummary(sealProvider, chScenes, ch.title);
                if (summaryPatch) {
                    await api.chapters.update(activeCampaignId, ch.chapterId, { ...summaryPatch, invalidated: false });
                    const latestChapters = await api.chapters.list(activeCampaignId);
                    if (callbacks.setChapters) callbacks.setChapters(latestChapters);
                    console.log(`[Auto-Seal] Summary generated for "${ch.title}"`);
                }
            }
        }).catch(err => console.warn('[Auto-Seal] Failed:', err));
    }

    const extractedNames = extractNPCNames(lastAssistantContent);
    if (extractedNames.length > 0) {
        const freshProvider = state.getFreshProvider();
        const validatedNames = freshProvider
            ? await validateNPCCandidates(freshProvider, extractedNames, lastAssistantContent)
            : extractedNames;

        if (validatedNames.length > 0) {
            const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger as any);

            const guardedAddNPC = (npc: Parameters<typeof callbacks.addNPC>[0]) => {
                const currentId = useAppStore.getState().activeCampaignId;
                if (currentId !== activeCampaignId) return;
                callbacks.addNPC(npc);
            };

            const guardedUpdateNPC = (id: string, patch: Parameters<typeof callbacks.updateNPC>[1]) => {
                const currentId = useAppStore.getState().activeCampaignId;
                if (currentId !== activeCampaignId) return;
                callbacks.updateNPC(id, patch);
            };

            for (const potentialName of newNames) {
                console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — queuing background profile generation...`);
                const genProvider = state.getFreshProvider();
                if (genProvider) {
                    backgroundQueue.push(
                        `NPC-Gen:${potentialName}`,
                        () => generateNPCProfile(genProvider, allMsgs, potentialName, guardedAddNPC)
                    ).catch(err => console.warn(`[NPC Auto-Gen] Background generation failed for "${potentialName}":`, err));
                }
            }

            if (existingNpcsToUpdate.length > 0) {
                const updateProvider = state.getFreshProvider();
                if (updateProvider) {
                    backgroundQueue.push(
                        `NPC-Update:${existingNpcsToUpdate.map(n => n.name).join(',')}`,
                        () => updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, guardedUpdateNPC)
                    ).catch(err => console.warn('[NPC Update] Background update failed:', err));
                }
            }
        }
    }

    const turnCount = state.incrementBookkeepingTurnCounter();
    const interval = state.autoBookkeepingInterval;
    if (turnCount >= interval && appendedSceneId) {
        console.log(`[Auto Bookkeeping] Turn ${turnCount} >= interval ${interval} — queuing profile + inventory scan`);
        state.resetBookkeepingTurnCounter();

        const bkProvider = state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;

            backgroundQueue.push('Profile-Scan', async () => {
                const newProfile = await scanCharacterProfile(bkProvider, state.getMessages(), state.getFreshContext().characterProfile);
                callbacks.updateContext({
                    characterProfile: newProfile,
                    characterProfileLastScene: sceneId,
                });
                console.log(`[Auto Bookkeeping] Profile updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));

            backgroundQueue.push('Inventory-Scan', async () => {
                const newInventory = await scanInventory(bkProvider, state.getMessages(), state.getFreshContext().inventory);
                callbacks.updateContext({
                    inventory: newInventory,
                    inventoryLastScene: sceneId,
                });
                console.log(`[Auto Bookkeeping] Inventory updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Inventory scan failed:', err));
        }
    }
}
