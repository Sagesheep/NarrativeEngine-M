/**
 * turnPostProcess.ts — orchestrator + barrel (W10 God File split).
 *
 * Stage functions extracted to postTurn/:
 * - witnessStage.ts: parsePresentHeader, resolveNPCIds, auxWitnessFallback, tryWithFallback
 * - sealStage.ts: runCombinedSeal, handleSealChapter
 * - archiveStage.ts: queueIndexPatch, queueNPCValidation, autoEnableCharacterProfile
 * - bookkeepingStage.ts: runBookkeepingScans
 * - npcStage.ts: runNPCPressureScan, runAgencyTick, bumpOnStageActivity, runTimeskipPath, runArcTick
 *
 * This file contains only handlePostTurn (the orchestrator entry point).
 */

import type { NPCEntry, ArchiveChapter } from '../../types';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { api } from '../apiClient';
import { uid } from '../../utils/uid';
import { backgroundQueue } from '../infrastructure';
import { fetchFacts } from '../campaign-state';
import { extractNPCNames, classifyNPCNames } from '../npc';
import { parsePresentHeader, resolveNPCIds } from './postTurn/witnessStage';
import { handleSealChapter } from './postTurn/sealStage';
import { queueIndexPatch, queueNPCValidation, autoEnableCharacterProfile } from './postTurn/archiveStage';
import { runBookkeepingScans } from './postTurn/bookkeepingStage';
import { runNPCPressureScan, runAgencyTick, bumpOnStageActivity, runArcTick } from './postTurn/npcStage';

// Re-export for backward compat
export { parsePresentHeader, resolveNPCIds } from './postTurn/witnessStage';
export { runCombinedSeal } from './postTurn/sealStage';
export { autoEnableCharacterProfile } from './postTurn/archiveStage';
export { runArcTick } from './postTurn/npcStage';

export async function handlePostTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    activeCampaignId: string,
    npcLedger: NPCEntry[],
    lastAssistantContent: string,
    loadChapters: (campaignId: string) => Promise<ArchiveChapter[]>,
): Promise<void> {
    if (state.context.agencyDigest) { callbacks.updateContext({ agencyDigest: '' }); }
    if (state.context.arcDigest) { callbacks.updateContext({ arcDigest: '' }); }

    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent);
    const appendedSceneId = appendData?.sceneId;

    if (appendData) {
        const freshIndex = await api.archive.getIndex(activeCampaignId);
        callbacks.setArchiveIndex(freshIndex);
        callbacks.addMessage({ id: uid(), role: 'system', name: 'scene-marker', content: `Scene ${appendedSceneId}`, timestamp: Date.now() });
    }

    const extractedNames = extractNPCNames(lastAssistantContent);
    const presentHeaderNames = parsePresentHeader(lastAssistantContent);
    if (presentHeaderNames.length > 0) {
        const onStageIds = resolveNPCIds(presentHeaderNames, npcLedger);
        callbacks.setOnStageNpcIds?.(onStageIds);
    } else {
        const { existingNpcs: bodyNpcs } = classifyNPCNames(extractedNames, npcLedger);
        if (bodyNpcs.length > 0) { callbacks.setOnStageNpcIds?.(bodyNpcs.map(n => n.id)); }
    }

    if (callbacks.setSemanticFacts) {
        const cid = activeCampaignId; const cb = callbacks;
        backgroundQueue.push('Refresh-Facts', async () => {
            try { const freshFacts = await fetchFacts(cid); cb.setSemanticFacts!(freshFacts); }
            catch (err) { console.warn('[TurnPostProcess] Refresh-Facts failed:', err); }
        }).catch((e) => console.warn('[TurnPostProcess] Refresh-Facts queue push failed:', e));
    }

    backgroundQueue.push('Seal-Chapter', () => handleSealChapter(state, callbacks, activeCampaignId, loadChapters))
        .catch((e) => console.warn('[TurnPostProcess] Seal-Chapter queue push failed:', e));

    queueIndexPatch(state, callbacks, appendedSceneId, displayInput, lastAssistantContent, npcLedger, activeCampaignId);
    queueNPCValidation(state, callbacks, extractedNames, npcLedger, lastAssistantContent, activeCampaignId);
    autoEnableCharacterProfile(state, callbacks, npcLedger);
    runBookkeepingScans(state, callbacks, appendedSceneId);
    runNPCPressureScan(state, callbacks, npcLedger, displayInput, lastAssistantContent);
    runAgencyTick(state, callbacks, npcLedger, displayInput);
    runArcTick(state, callbacks, displayInput, lastAssistantContent);
    bumpOnStageActivity(state, callbacks, npcLedger);
}
