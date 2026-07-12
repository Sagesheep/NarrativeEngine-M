/**
 * Archive stage — extracted from turnPostProcess.ts (W10).
 * Index patching, NPC validation, auto-enable character profile.
 */

import type { NPCEntry, WitnessSource } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnTypes';
import { tierAllows, NPC_UPDATE_COOLDOWN } from '../aiTier';
import { api } from '../../apiClient';
import { updateExistingNPCs, backfillNPCDrives, populateAgencyFields } from '../../chatEngine';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates, filterUpdatableNPCs, isAgencyEligible, completeShortWant, drawShortWants } from '../../npc';
import { backgroundQueue } from '../../infrastructure';
import { rateImportance } from '../../archive';
import { parsePresentHeader, resolveNPCIds, auxWitnessFallback, tryWithFallback } from './witnessStage';

export function queueIndexPatch(state: TurnState, callbacks: TurnCallbacks, appendedSceneId: string | undefined, displayInput: string, lastAssistantContent: string, npcLedger: NPCEntry[], activeCampaignId: string): void {
    if (!appendedSceneId) return;
    const sceneId = appendedSceneId;
    const userText = displayInput;
    const gmText = lastAssistantContent;
    const npcLedgerSnap = npcLedger;
    const cid = activeCampaignId;
    const summarizerProvider = state.getFreshSummarizerProvider?.();
    const storyProvider = state.getFreshProvider();
    const headerNames = parsePresentHeader(gmText);
    const headerIds = resolveNPCIds(headerNames, npcLedgerSnap);
    backgroundQueue.push('Index-Patch', async () => {
        let changed = false;
        const index = await api.archive.getIndex(cid);
        const entry = index.find(e => e.sceneId === sceneId);
        if (!entry) return;
        const ratingProvider = summarizerProvider ?? storyProvider;
        if (ratingProvider && tierAllows(state.settings.aiTier, 'importanceRating')) {
            try {
                const recentMsgs = state.getMessages();
                const llmImportance = await tryWithFallback('ImportanceRater',
                    () => rateImportance(ratingProvider, userText, gmText, recentMsgs),
                    () => storyProvider ? rateImportance(storyProvider, userText, gmText, recentMsgs) : Promise.resolve(3));
                if (llmImportance !== entry.importance) { entry.importance = llmImportance; changed = true; }
            } catch (e) { console.warn('[TurnPostProcess] Importance rating failed:', e); }
        }
        if (headerIds.length > 0) {
            entry.npcsWitnessed = headerIds; entry.witnessSource = 'header' as WitnessSource; changed = true;
        } else {
            let resolvedIds: string[] = []; let source: WitnessSource = 'empty';
            const extractionProvider = state.getExtractionProvider?.();
            if (tierAllows(state.settings.aiTier, 'witnessAux') && extractionProvider?.endpoint) {
                try { const auxIds = await auxWitnessFallback(gmText, npcLedgerSnap, extractionProvider); if (auxIds.length > 0) { resolvedIds = auxIds; source = 'aux_fallback'; } } catch { }
            }
            if (resolvedIds.length === 0) {
                const bodyNames = extractNPCNames(gmText);
                const { existingNpcs } = classifyNPCNames(bodyNames, npcLedgerSnap);
                resolvedIds = existingNpcs.map(n => n.id);
                source = resolvedIds.length > 0 ? 'body_fallback' : 'empty';
            }
            entry.npcsWitnessed = resolvedIds.length > 0 ? resolvedIds : undefined;
            entry.witnessSource = source; changed = true;
        }
        if (changed) {
            const { offlineStorage } = await import('../../storage');
            await offlineStorage.archive.updateIndex(cid, index);
            callbacks.setArchiveIndex([...index]);
        }
    }).catch((e) => console.warn('[TurnPostProcess] Index-Patch queue push failed:', e));
}

export function queueNPCValidation(state: TurnState, callbacks: TurnCallbacks, extractedNames: string[], npcLedger: NPCEntry[], lastAssistantContent: string, activeCampaignId: string): void {
    if (extractedNames.length === 0 || !tierAllows(state.settings.aiTier, 'npcValidate')) return;
    backgroundQueue.push('NPC-Validate', async () => {
        const provider = state.getExtractionProvider?.() ?? state.getFreshProvider();
        const validatedNames = provider ? await validateNPCCandidates(provider, extractedNames, lastAssistantContent) : extractedNames;
        if (validatedNames.length === 0) return;
        const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger);
        const allMsgs = state.getMessages();
        if (newNames.length > 0) callbacks.addNpcSuggestions?.(newNames, lastAssistantContent);
        for (const npc of existingNpcsToUpdate) {
            if (!isAgencyEligible(npc)) continue;
            const short = npc.wants?.short;
            if (!short || short.length === 0) continue;
            const trimmed = completeShortWant(npc.wants!, short[0]);
            const drawn = drawShortWants({ matureMode: state.settings.matureMode ?? false, traits: npc.traits ?? [], count: 4 });
            const replenished = [...trimmed.short];
            for (const w of drawn) { if (replenished.length >= 4) break; if (!replenished.includes(w)) replenished.push(w); }
            callbacks.updateNPC(npc.id, { wants: { ...npc.wants!, short: replenished } });
        }
        if (existingNpcsToUpdate.length > 0 && tierAllows(state.settings.aiTier, 'npcUpdate')) {
            const archiveIndex = state.archiveIndex;
            const sceneNow = archiveIndex.length > 0 ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0 : 0;
            const cooldown = NPC_UPDATE_COOLDOWN[state.settings.aiTier ?? 'pro'];
            const onStageIds = existingNpcsToUpdate.map(n => n.id);
            const npcsEligibleForUpdate = filterUpdatableNPCs(existingNpcsToUpdate, { recentlyMentionedIds: onStageIds }).filter(npc => sceneNow - (npc.lastUpdateScene ?? -Infinity) >= cooldown);
            if (npcsEligibleForUpdate.length > 0) {
                const updateProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
                if (updateProvider) {
                    updateExistingNPCs(updateProvider, allMsgs, npcsEligibleForUpdate, callbacks.updateNPC, activeCampaignId)
                        .then(() => { for (const npc of npcsEligibleForUpdate) callbacks.updateNPC(npc.id, { lastUpdateScene: sceneNow }); })
                        .catch((e) => console.warn('[TurnPostProcess] updateExistingNPCs failed:', e));
                }
            }
            if (tierAllows(state.settings.aiTier, 'drivesBackfill')) {
                const npcsNeedingDrives = existingNpcsToUpdate.filter(n => !n.drives);
                if (npcsNeedingDrives.length > 0) {
                    const backfillProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
                    if (backfillProvider) backgroundQueue.push('NPC-Drives-Backfill', () => backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, callbacks.updateNPC)).catch((e) => console.warn('[TurnPostProcess] NPC drives backfill failed:', e));
                }
                const npcsNeedingAgency = existingNpcsToUpdate.filter(n => !n.populated && isAgencyEligible(n));
                if (npcsNeedingAgency.length > 0) {
                    const agencyProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
                    if (agencyProvider) backgroundQueue.push('NPC-Agency-Fill', () => populateAgencyFields(agencyProvider, allMsgs, npcsNeedingAgency, callbacks.updateNPC, state.settings.matureMode ?? false)).catch((e) => console.warn('[TurnPostProcess] NPC agency fill failed:', e));
                }
            }
        }
    }).catch((e) => console.warn('[TurnPostProcess] NPC-Validate queue push failed:', e));
}

export function autoEnableCharacterProfile(state: TurnState, callbacks: TurnCallbacks, npcLedger: NPCEntry[]): void {
    if (state.context.characterProfileActive) return;
    if (state.context.characterProfileUserDisabled) return;
    const pc = npcLedger.find(n => n.isPC);
    if (!pc) return;
    const profile = state.context.characterProfile ?? { identity: {}, activeTraits: [] };
    const identity = profile.identity ?? {};
    const seededIdentity = { ...identity, name: identity.name || pc.name, archetype: identity.archetype ?? pc.archetype };
    callbacks.updateContext({ characterProfileActive: true, characterProfile: { ...profile, identity: seededIdentity } });
    console.log(`[B3] Auto-enabled characterProfileActive; seeded identity.name from PC "${pc.name}"`);
}
