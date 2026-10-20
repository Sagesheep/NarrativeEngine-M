/**
 * Bookkeeping stage — extracted from turnPostProcess.ts (W10).
 */

import type { NPCEntry } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnTypes';
import { tierAllows } from '../aiTier';
import { scanCharacterProfileWithPcState, scanInventory } from '../../campaign-state';
import { backgroundQueue } from '../../infrastructure';
import {
    isFactMaintenanceEligible, resolvePcStateUpdate, buildPcStateSection, hasPcFactCue, withCommittedReply,
    PC_FACT_FIELDS, type PcFactPatch,
} from '../../npc';

/**
 * Periodic profile + inventory scans (every `autoBookkeepingInterval` commits).
 * The profile scan also maintains the PC's current facts (appearance, equipment,
 * powers, condition — see npc/pcFactMaintenance.ts), and runs early on a commit
 * whose exchange carries a change/correction cue.
 *
 * Scans read the COMMITTED view: the turn snapshot froze swipe 1's text, so the
 * latest reply is replaced by the committed variant (`lastAssistantContent`).
 */
export function runBookkeepingScans(
    state: TurnState,
    callbacks: TurnCallbacks,
    appendedSceneId: string | undefined,
    lastAssistantContent?: string,
    displayInput: string = '',
    npcLedger: NPCEntry[] = state.npcLedger,
): void {
    const turnCount = state.incrementBookkeepingTurnCounter();
    if (!appendedSceneId) return;

    const tier = state.settings.aiTier;
    const pc = tierAllows(tier, 'pcFactScan') ? npcLedger.find(isFactMaintenanceEligible) : undefined;
    const intervalDue = turnCount >= state.autoBookkeepingInterval;
    const cueDue = !!pc && hasPcFactCue(`${displayInput}\n${lastAssistantContent ?? ''}`);
    if (!intervalDue && !cueDue) return;
    if (intervalDue) state.resetBookkeepingTurnCounter();

    const bkProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
    if (!bkProvider) return;
    const sceneId = appendedSceneId;
    const allMsgs = withCommittedReply(state.getMessages(), lastAssistantContent);

    // autoEnableCharacterProfile (same commit) flips characterProfileActive via the
    // store, but this state is the turn snapshot — so a PC that is not user-disabled
    // counts as active here too.
    const profileOn = state.context.characterProfileActive || (!!pc && !state.context.characterProfileUserDisabled);
    // Profile traits are written only where the tier runs the profile scan (max).
    // PC facts ride the same call; on pro they run it on a cue, facts only.
    const writeProfile = profileOn && tierAllows(tier, 'profileScan');
    if (writeProfile || pc) {
        backgroundQueue.push('Profile-Scan', async () => {
            const { profile, pcStateUpdate } = await scanCharacterProfileWithPcState(
                bkProvider, allMsgs, state.context.characterProfile, pc ? buildPcStateSection(pc) : undefined);
            if (writeProfile) callbacks.updateContext({ characterProfile: profile, characterProfileLastScene: sceneId });
            if (pc) applyPcFactPatch(pc, resolvePcStateUpdate(pcStateUpdate, pc, allMsgs), callbacks);
        }).catch((e) => console.warn('[TurnPostProcess] Profile scan failed:', e));
    }
    if (intervalDue && tierAllows(state.settings.aiTier, 'inventoryScan')) {
        backgroundQueue.push('Inventory-Scan', async () => {
            const newInventory = await scanInventory(bkProvider, allMsgs, state.context.inventory);
            callbacks.updateContext({ inventory: newInventory, inventoryLastScene: sceneId });
        }).catch((e) => console.warn('[TurnPostProcess] Inventory scan failed:', e));
    }
}

/**
 * Write the validated PC fact patch. Compare-and-set per field: if the player
 * edited a field while the scan ran, their edit wins and that field is skipped.
 */
export function applyPcFactPatch(scannedPc: NPCEntry, patch: PcFactPatch, callbacks: TurnCallbacks): void {
    const live = callbacks.getNpc?.(scannedPc.id) ?? scannedPc;
    if (!isFactMaintenanceEligible(live)) return;
    const safe: PcFactPatch = {};
    for (const f of PC_FACT_FIELDS) {
        if (!(f in patch)) continue;
        if (JSON.stringify(live[f]) !== JSON.stringify(scannedPc[f])) {
            console.log(`[PcFacts] ${f} edited during scan — keeping the player's edit`);
            continue;
        }
        (safe as Record<string, unknown>)[f] = patch[f];
    }
    if (Object.keys(safe).length === 0) return;
    console.log(`[PcFacts] updated ${Object.keys(safe).join(', ')} for ${live.name}`);
    callbacks.updateNPC(live.id, safe);
}
