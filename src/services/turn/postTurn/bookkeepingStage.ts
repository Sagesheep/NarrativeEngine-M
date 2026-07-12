/**
 * Bookkeeping stage — extracted from turnPostProcess.ts (W10).
 */

import type { TurnState, TurnCallbacks } from '../turnTypes';
import { tierAllows } from '../aiTier';
import { scanCharacterProfile, scanInventory } from '../../campaign-state';
import { backgroundQueue } from '../../infrastructure';

export function runBookkeepingScans(state: TurnState, callbacks: TurnCallbacks, appendedSceneId: string | undefined): void {
    const turnCount = state.incrementBookkeepingTurnCounter();
    if (turnCount >= state.autoBookkeepingInterval && appendedSceneId) {
        state.resetBookkeepingTurnCounter();
        const bkProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;
            const allMsgs = state.getMessages();
            if (state.context.characterProfileActive && tierAllows(state.settings.aiTier, 'profileScan')) {
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
