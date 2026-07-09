import type { NPCEntry, ArchiveChapter, ArchiveIndexEntry, LLMProvider, WitnessSource, SceneStakes, DivergenceEntry } from '../../types';
import { tierAllows, NPC_UPDATE_COOLDOWN } from './aiTier';
import type { TurnCallbacks, TurnState } from './turnTypes';
import { updateExistingNPCs, backfillNPCDrives, populateAgencyFields } from '../chatEngine';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates, filterUpdatableNPCs, isAgencyEligible, completeShortWant, drawShortWants } from '../npc';
import {
    rollHeartbeat,
    buildProximityRoster,
    upgradeWantsToGoals,
    chooseTick,
    rollGoal,
    applyBandToGoal,
    nextFailStreak,
    buildDigest,
    visibilityFromBand,
    detectTimeskip,
    runTimeskip,
    applyGoalOutcomeNudge,
    applyTierCross,
    selectTickTarget,
    activityBumpPatch,
    detectCollision,
    resolveTangle,
    buildTangleDeltas,
    HEARTBEAT_DC,
    GOAL_BASE_DC,
    COLLISION_TANGLE_PROB,
} from '../npc';
import type { TickDelta, Band } from '../npc';
import { api } from '../apiClient';
import { uid } from '../../utils/uid';
import { notify } from '../../ports/notification';
import { shouldAutoSeal, sealChapter, sealChapterCombined, type CombinedSealResult, rateImportance } from '../archive';
import { computeOpenThreads } from '../payload/payloadWorldContext';
import { fetchFacts, scanCharacterProfile, scanInventory, mergeSealEntries } from '../campaign-state';
import { chapterRepository } from '../../ports/chapterRepository';
import { scanPressure, buildPressurePatch, applyDecay } from '../npc';
import {
    rollArcTick,
    rollArcOutcome,
    advanceRung,
    arcSurfaceLine,
    scanArcStance,
} from '../arc';
import type { ArcRecord } from '../../types';
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
    } catch { /* malformed LLM JSON → no recallable ids */ }
    return [];
}

export async function runCombinedSeal(
    activeCampaignId: string,
    chapter: ArchiveChapter,
    provider: LLMProvider,
    npcLedger: NPCEntry[],
    archiveIndex?: ArchiveIndexEntry[],
    openThreads?: string[],
    existingSubjectTokens?: string[]
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

    return sealChapterCombined(provider, scenesContent, chapter.chapterId, chapter.title, sceneIds, npcInfo, indexEntries, 2, openThreads, existingSubjectTokens);
}

export async function handlePostTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    activeCampaignId: string,
    npcLedger: NPCEntry[],
    lastAssistantContent: string
): Promise<void> {
    // Clear the agency digest that was folded into the GM call just completed.
    // A new digest may be set below if the heartbeat fires this turn.
    if (state.context.agencyDigest) {
        callbacks.updateContext({ agencyDigest: '' });
    }
    // Arc Engine (System 2): mirror the agencyDigest clear. arcDigest was folded into
    // the GM call just completed; a new one may be set below if runArcTick fires.
    if (state.context.arcDigest) {
        callbacks.updateContext({ arcDigest: '' });
    }

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

    // B3 — a PC built in chat never flips characterProfileActive (only the PC Creation
    // Wizard did, in ChatArea.tsx). Auto-enable the moment a campaign has an isPC NPC,
    // and seed identity from it. See autoEnableCharacterProfile for the full contract.
    autoEnableCharacterProfile(state, callbacks, npcLedger);

    runBookkeepingScans(state, callbacks, appendedSceneId);

    runNPCPressureScan(state, callbacks, npcLedger, displayInput, lastAssistantContent);

    runAgencyTick(state, callbacks, npcLedger, displayInput);

    // Arc Engine (System 2 / Oracle Function) — WO-05. Sibling of runAgencyTick.
    // +0 LLM: pure dice (rollArcTick → rollArcOutcome → advanceRung), stance scan
    // (scanArcStance), and a digest fold (arcSurfaceLine → context.arcDigest). The
    // ONLY deliberate LLM cost is the gated spawn at the seal seam (handleSealChapter).
    runArcTick(state, callbacks, displayInput, lastAssistantContent);

    // WO-07 Piece D completion (Opus ratification 2026-06-18): bump activity for every NPC that
    // was on-stage last turn. The engine-only tick (runAgencyTick above) happens too rarely to
    // outrun ACTIVITY_DECAY — without this bump, every NPC drifts back to 0 and the deep tier
    // freezes onto 3 arbitrary NPCs. The on-stage signal is "who the player actually interacted
    // with" — the people you keep talking to rise to the top and stay; the ones you ignore fade.
    // Synchronous, pure, +0 LLM. `state.onStageNpcIds` is the previous turn's on-stage set (the
    // store update from setOnStageNpcIds above doesn't reflect into this turn's snapshot), which
    // is exactly the right signal: bump who you *were* interacting with, not who you *just* met.
    bumpOnStageActivity(state, callbacks, npcLedger);
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
            const index = await api.archive.getIndex(cid);
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

                // Auto-ADD removed: newly-detected names are surfaced as suggestions
                // for the player to promote (or dismiss) in the ledger — the player
                // is the significance gate. Auto-UPDATE of already-tracked NPCs
                // (below) is unchanged.
                if (newNames.length > 0) {
                    callbacks.addNpcSuggestions?.(newNames, lastAssistantContent);
                }

                // NPC Agency Phase 2 — short-want lifecycle (§9.2 #3, ZERO LLM): an on-stage NPC
                // "acts on" its current short want this turn, so close it and draw a replacement.
                // Deterministic rotation, no clock/heat. Runs regardless of the npcUpdate tier gate
                // since it costs no model calls; only touches already-populated, eligible NPCs.
                for (const npc of existingNpcsToUpdate) {
                    if (!isAgencyEligible(npc)) continue;
                    const short = npc.wants?.short;
                    if (!short || short.length === 0) continue;
                    const trimmed = completeShortWant(npc.wants!, short[0]);
                    const drawn = drawShortWants({ matureMode: state.settings.matureMode ?? false, traits: npc.traits ?? [], count: 4 });
                    const replenished = [...trimmed.short];
                    for (const w of drawn) {
                        if (replenished.length >= 4) break;
                        if (!replenished.includes(w)) replenished.push(w);
                    }
                    callbacks.updateNPC(npc.id, { wants: { ...npc.wants!, short: replenished } });
                }

                if (existingNpcsToUpdate.length > 0 && tierAllows(state.settings.aiTier, 'npcUpdate')) {
                    const archiveIndex = state.archiveIndex;
                    const sceneNow = archiveIndex.length > 0
                        ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
                        : 0;
                    const cooldown = NPC_UPDATE_COOLDOWN[state.settings.aiTier ?? 'pro'];
                    // Gate the candidate list through agency eligibility (drops PC/locked/dead) before
                    // the cooldown filter — stale/ineligible NPCs never get an update LLM call.
                    const onStageIds = existingNpcsToUpdate.map(n => n.id);
                    const npcsEligibleForUpdate = filterUpdatableNPCs(existingNpcsToUpdate, { recentlyMentionedIds: onStageIds })
                        .filter(npc => sceneNow - (npc.lastUpdateScene ?? -Infinity) >= cooldown);

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

                        // NPC Agency Phase 2: lazily populate agency fields (wants/hex/traits/region)
                        // for relevant, un-populated NPCs — only when they actually matter (cast set),
                        // never for fog/stale NPCs or the PC. Idempotent; safe to re-run.
                        const npcsNeedingAgency = existingNpcsToUpdate.filter(n => !n.populated && isAgencyEligible(n));
                        if (npcsNeedingAgency.length > 0) {
                            const agencyProvider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();
                            if (agencyProvider) {
                                backgroundQueue.push('NPC-Agency-Fill', () => populateAgencyFields(agencyProvider, allMsgs, npcsNeedingAgency, callbacks.updateNPC, state.settings.matureMode ?? false)).catch((e) => console.warn('[TurnPostProcess] NPC agency fill failed:', e));
                            }
                        }
                    }
                }
            }
        }).catch((e) => console.warn('[TurnPostProcess] NPC-Validate queue push failed:', e));
    }
}

// B3 — Auto-enable characterProfileActive for chat-made PCs. The flag was flipped true
// ONLY by the PC Creation Wizard (ChatArea.tsx), so PCs built conversationally never
// engaged the structured-profile subsystem (scan, payload injection, TokenGauge). This
// fires at a turn-pipeline seam with npcLedger in scope, before runBookkeepingScans so
// the scan can fire the same turn. Idempotent: once the gate at ~:464 is true, this is a
// no-op. Never clobbers an existing identity field (|| / ?? guards) — a profile the scan
// already built must survive. Only name and combat archetype are mappable from NPCEntry
// (isPC at types:562, archetype at :564; race/class/level are NOT on the entry); the rest
// is left for scanCharacterProfile, which preserves identity and enriches it.
export function autoEnableCharacterProfile(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
): void {
    if (state.context.characterProfileActive) return;
    if (state.context.characterProfileUserDisabled) return;
    const pc = npcLedger.find(n => n.isPC);
    if (!pc) return;
    const profile = state.context.characterProfile ?? { identity: {}, activeTraits: [] };
    const identity = profile.identity ?? {};
    const seededIdentity = {
        ...identity,
        name: identity.name || pc.name,
        archetype: identity.archetype ?? pc.archetype,
    };
    callbacks.updateContext({
        characterProfileActive: true,
        characterProfile: { ...profile, identity: seededIdentity },
    });
    console.log(`[B3] Auto-enabled characterProfileActive; seeded identity.name from PC "${pc.name}"`);
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

        const pressureMap = state.npcPressure ?? {};
        const pressureUpdates = scanPressure(displayInput, npcLedger, lastAssistantContent);
        const updatedIds = new Set<string>();
        if (pressureUpdates.length > 0) {
            for (const update of pressureUpdates) {
                const npc = npcLedger.find(n => n.id === update.npcId);
                if (!npc) continue;
                const newPressure = buildPressurePatch(pressureMap[npc.id], update, sceneNumber);
                callbacks.applyPressurePatch?.(npc.id, newPressure);
                updatedIds.add(npc.id);
                if (update.reasons.length > 0) {
                    console.log(`[PressureTracker] ${npc.name}: ignored=${newPressure.ignored.toFixed(1)}, engaged=${newPressure.engaged.toFixed(1)} — ${update.reasons.join(', ')}`);
                }
            }
        }

        // Passive decay: apply decay to all NPCs with pressure data that weren't updated this turn
        for (const [npcId, pressure] of Object.entries(pressureMap)) {
            if (updatedIds.has(npcId)) continue;
            const decayedIgnored = applyDecay(pressure.ignored, pressure.lastDecayTurn, sceneNumber);
            const decayedEngaged = applyDecay(pressure.engaged, pressure.lastDecayTurn, sceneNumber);
            if (decayedIgnored !== pressure.ignored || decayedEngaged !== pressure.engaged) {
                callbacks.applyPressurePatch?.(npcId, {
                    ignored: decayedIgnored,
                    engaged: decayedEngaged,
                    lastDecayTurn: sceneNumber,
                    history: pressure.history,
                });
            }
        }
    }
}

// ── Phase-3 agency heartbeat + timeskip wiring (§9.3, §9.5–9.8) ───────────
// Call budget: normal turn +0 LLM, seam +0, timeskip +1 batched.
// The digest folds into the EXISTING GM call via GameContext.agencyDigest (+0).

function runAgencyTick(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
    displayInput: string,
): void {
    if (!npcLedger || npcLedger.length === 0) return;

    const sceneStakes: SceneStakes = state.context.lastSceneStakes ?? 'calm';
    const currentTick = state.context.agencyTick ?? 0;
    const currentDc = state.context.agencyHeartbeatDC ?? HEARTBEAT_DC.initial;

    // ── Timeskip detection (§9.7 Piece D, +1 LLM) ──
    // Check player input for a time-skip phrase. Timeskip supersedes heartbeat.
    const timeskipResult = detectTimeskip(displayInput);
    if (timeskipResult && !('ambiguous' in timeskipResult) && timeskipResult.weeks > 0) {
        if (tierAllows(state.settings.aiTier, 'timeskipRun')) {
            runTimeskipPath(state, callbacks, npcLedger, timeskipResult.weeks, currentTick, sceneStakes);
            return;
        }
    }

    // ── Heartbeat trickle (§5/§9.3#1, +0 LLM) ──
    // Pure formula — no LLM. Only runs if the tier gate allows it.
    if (!tierAllows(state.settings.aiTier, 'heartbeatTick')) return;

    const heartbeat = rollHeartbeat({ dc: currentDc });
    // Persist the updated DC regardless of whether the heartbeat fires
    callbacks.updateContext({ agencyHeartbeatDC: heartbeat.nextDc });

    if (!heartbeat.fired) return;

    // Build proximity roster, excluding PC and ineligible NPCs
    const pc = npcLedger.find(n => n.isPC);
    const roster = buildProximityRoster(npcLedger, pc);
    if (roster.length === 0) return;

    // Pick the NPC to tick this beat. WO-07 Piece D: instead of uniform-random across the roster
    // (which bloated the cast as the ledger grew), tick a small "deep tier" of high-activity NPCs
    // preferentially, with a low-prob audition roll for background NPCs. Sustained picks accumulate
    // activity → promotion; dormancy decays → relegation. `now` must be computed BEFORE the pick
    // because selectTickTarget evaluates lazy-decay activity against the agency clock.
    const now = currentTick + 1;
    const { pick, isAudition, deepTier } = selectTickTarget(roster, now);
    if (!pick) return;
    if (isAudition) {
        console.log(`[AgencyTick] heartbeat tick=${now} audition pick=${pick.id} (deepTier=${deepTier.map(n => n.id).join(',')})`);
    }

    // ── Goal upgrade: idempotent wants→goalRecords migration (§9.6) ──
    let updatedNpc = { ...pick };
    if (!updatedNpc.goalRecords || updatedNpc.goalRecords.length === 0) {
        const goals = upgradeWantsToGoals(updatedNpc, now);
        if (goals.length > 0) {
            updatedNpc.goalRecords = goals;
            callbacks.updateNPC(updatedNpc.id, { goalRecords: goals });
        }
    }

    // ── Choose tick (§9.5) ──
    const tickChoice = chooseTick(updatedNpc, now, sceneStakes);
    if (tickChoice.kind === 'idle') return;

    // ── Hard gate: pre-roll check, no karma (§9.6 exception 1) ──
    // If the chosen goal is blocked by scene stakes, write 'blocked' and stop.
    if (tickChoice.kind === 'goal') {
        const goal = tickChoice.goal;
        // contextAllow is checked inside chooseTick (goals blocked by stakes are excluded)
        // but double-check: if somehow a blocked goal got through, skip it
        if (goal.state !== 'active') return;

        // ── WO-08 Piece E: event collision detection ──
        // Among the NPCs active this beat (deepTier ∪ {pick}, minus pick), find at most ONE partner
        // whose top active goal coincides with pick's chosen goal (same region OR shared keyword).
        // If found AND rng < COLLISION_TANGLE_PROB, resolve as a tangle (one shared beat, two NPCs);
        // else fall through to the solo path below. Proximity-only, two-at-a-time max, +0 LLM.
        const collisionCandidates = [...deepTier, pick].filter(n => n.id !== pick.id);
        const collision = detectCollision(pick, goal, collisionCandidates, sceneStakes);
        if (collision && Math.random() < COLLISION_TANGLE_PROB) {
            const partner = collision.partner;
            const partnerGoal = collision.partnerGoal;

            // Resolve the tangle: ally→cooperate (share band), rival→contest (loser feeds winner
            // via COLLISION_OPPORTUNITY_BONUS as rollGoal extraMods this beat), neutral→mild contest.
            const outcome = resolveTangle(pick, goal, partner, partnerGoal, collision.tone);

            // ── Apply both NPCs' resolutions ──
            // Pick (NPC a)
            const aUpdatedGoal = applyBandToGoal(goal, outcome.aBand, now);
            const aNewFailStreak = nextFailStreak(goal.failStreak, outcome.aBand);
            const aResolvedGoal = { ...aUpdatedGoal, failStreak: aNewFailStreak };
            const aGoalRecords = (updatedNpc.goalRecords ?? []).map(g =>
                g.text === goal.text && g.horizon === goal.horizon ? aResolvedGoal : g
            );
            callbacks.updateNPC(updatedNpc.id, { goalRecords: aGoalRecords });

            // Partner (NPC b) — spread a fresh copy so we don't mutate the ledger ref
            const updatedPartner = { ...partner };
            const bUpdatedGoal = applyBandToGoal(partnerGoal, outcome.bBand, now);
            const bNewFailStreak = nextFailStreak(partnerGoal.failStreak, outcome.bBand);
            const bResolvedGoal = { ...bUpdatedGoal, failStreak: bNewFailStreak };
            const bGoalRecords = (updatedPartner.goalRecords ?? []).map(g =>
                g.text === partnerGoal.text && g.horizon === partnerGoal.horizon ? bResolvedGoal : g
            );
            callbacks.updateNPC(updatedPartner.id, { goalRecords: bGoalRecords });

            // Advance tick counter (one tick for the shared beat, not two)
            callbacks.updateContext({ agencyTick: now });

            // Build the two shared-beat deltas (note names the partner → renders as ONE combined beat)
            const tangleDeltas = buildTangleDeltas(
                updatedNpc, goal, outcome.aBand,
                updatedPartner, partnerGoal, outcome.bBand,
                collision.tone,
            );

            // Fold into player digest (npcName populated → proseLine uses names, not ids)
            const existingDigest = state.context.agencyDigest ?? '';
            const newDigest = buildDigest(tangleDeltas, 'player');
            if (newDigest) {
                const combined = existingDigest ? existingDigest + '\n' + newDigest : newDigest;
                callbacks.updateContext({ agencyDigest: combined });
            }
            const debugDigest = buildDigest(tangleDeltas, 'debug');
            if (debugDigest) {
                console.log(`[AgencyTick] heartbeat tick=${now} tangle ${collision.tone} npc=${updatedNpc.id}+${updatedPartner.id}\n${debugDigest}`);
            }
            return;  // tangle handled — skip the solo path below
        }

        // ── Solo path (today's behavior, unchanged) ──

        // Roll the goal (Piece B, §9.6). Fixed base DC — karma inside rollGoal eases the roll;
        // difficulty must NOT scale with failStreak or it cancels the anti-deadlock nudge.
        const result = rollGoal(goal, GOAL_BASE_DC);
        const band: Band = result.band;

        // Apply progress (Piece C, §9.7)
        const updatedGoal = applyBandToGoal(goal, band, now);

        // Update failStreak (Piece B karma rule)
        const newFailStreak = nextFailStreak(goal.failStreak, band);

        // The single resolved goal for this beat — progress (applyBandToGoal) AND failStreak together.
        // `applyTierCross` MUST receive THIS (not the bare `updatedGoal`), or the cross-turn write below
        // would clobber `newFailStreak` with the stale value. (The timeskip path already passes the
        // merged goal into applyTierCross; this keeps both resolution paths consistent.)
        const resolvedGoal = { ...updatedGoal, failStreak: newFailStreak };

        // Write state deltas via updateNPC
        const goalRecords = (updatedNpc.goalRecords ?? []).map(g =>
            g.text === goal.text && g.horizon === goal.horizon
                ? resolvedGoal
                : g
        );
        callbacks.updateNPC(updatedNpc.id, { goalRecords });

        // WO-05 §D + WO-06 §1 — engine-resolve nudge (hex drift, +0 LLM) AND rung-ladder tier-cross
        // on the SAME resolved goal. Both are pure; we batch them into ONE `updateNPC` call so the
        // `previousSnapshot` is captured once (pre-nudge hex, pre-bump rung) and a single SHIFT
        // surfacing pass on the next payload read sees both drifts. `canCrossTier` (inside
        // `applyTierCross`) enforces the §9.7 both-conditions rule — grind-only never crosses.
        const nudge = applyGoalOutcomeNudge(updatedNpc, goal, band);
        const tierCross = applyTierCross(updatedNpc, resolvedGoal);
        if (nudge.hexPatch || tierCross) {
            const patch: Partial<NPCEntry> = {};
            // If the tier-cross fired, write the consumed goal (flag cleared, progress 0) back.
            if (tierCross) {
                patch.goalRecords = goalRecords.map(g =>
                    g.text === updatedGoal.text && g.horizon === updatedGoal.horizon
                        ? tierCross.updatedGoal
                        : g
                );
            }
            if (nudge.hexPatch) patch.personalityHex = nudge.hexPatch;
            if (tierCross && tierCross.rungPatch !== undefined) patch.skillRung = tierCross.rungPatch;
            // Single snapshot capturing the PRE-change state for every drifted field. The hex
            // snapshot is the pre-nudge hex (so the hex SHIFT surfaces); the rung snapshot is the
            // pre-bump rung. Both are read by `buildDriftAlert` on the next payload read.
            patch.previousSnapshot = {
                personality: updatedNpc.personality || updatedNpc.disposition || '',
                voice: updatedNpc.voice || '',
                affinity: updatedNpc.affinity,
                personalityHex: updatedNpc.personalityHex,  // pre-nudge
                pcRelation: updatedNpc.pcRelation,
                skillRung: updatedNpc.skillRung,            // pre-bump
            };
            patch.shiftTurnCount = 0;
            callbacks.updateNPC(updatedNpc.id, patch);
            if (nudge.shiftLine) console.log(`[AgencyTick] hex nudge npc=${updatedNpc.id} ${nudge.shiftLine}`);
            if (tierCross && tierCross.rungShiftLine) console.log(`[AgencyTick] rung cross npc=${updatedNpc.id} ${tierCross.rungShiftLine}`);
        }

        // Advance tick counter
        callbacks.updateContext({ agencyTick: now });

        // Build and emit TickDelta for the digest
        const visibility = visibilityFromBand(band, goal.horizon);
        const delta: TickDelta = {
            npcId: updatedNpc.id,
            npcName: updatedNpc.name,  // WO-08: name not id (id-leak fix)
            goalText: goal.text,
            horizon: goal.horizon,
            band,
            visibility,
            note: '',
        };

        // Build player digest and fold into GameContext for the next GM call
        const existingDigest = state.context.agencyDigest ?? '';
        const newDigest = buildDigest([delta], 'player');
        if (newDigest) {
            const combined = existingDigest ? existingDigest + '\n' + newDigest : newDigest;
            callbacks.updateContext({ agencyDigest: combined });
        }

        // Build debug digest and log it
        const debugDigest = buildDigest([delta], 'debug');
        if (debugDigest) {
            console.log(`[AgencyTick] heartbeat tick=${now} npc=${updatedNpc.id} band=${band} vis=${visibility}\n${debugDigest}`);
        }
    } else if (tickChoice.kind === 'color') {
        // Color tick: no goal resolution, just note it for the digest
        callbacks.updateContext({ agencyTick: now });
        console.log(`[AgencyTick] heartbeat tick=${now} npc=${updatedNpc.id} kind=color (novelty whiplash — no goal delta)`);
    } else if (tickChoice.kind === 'need') {
        // Need tick: all goals blocked, surfaced a pool need — no goal delta
        callbacks.updateContext({ agencyTick: now });
        console.log(`[AgencyTick] heartbeat tick=${now} npc=${updatedNpc.id} kind=need (all goals blocked)`);
    }

    // WO-07 Piece D: activity bump on every non-idle, non-blocked tick (Opus §5 — bump BOTH the
    // real-time pick and the audition pick). `idle` returns early at line 548; a blocked `goal`
    // returns early at line 556; so reaching here means the NPC actually ticked. The bump uses
    // `updatedNpc` (which carries the pre-bump agencyActivity via the spread at line 537), not
    // `pick`, so the lazy-decay current is computed against the right baseline.
    callbacks.updateNPC(updatedNpc.id, activityBumpPatch(updatedNpc, now));
}

/**
 * WO-07 Piece D completion (Opus ratification 2026-06-18): bump activity for every NPC that was
 * on-stage last turn. Without this, the engine-only tick (one NPC per heartbeat) is too rare to
 * outrun ACTIVITY_DECAY (0.5/beat), so every NPC drifts to 0 and the deep tier freezes onto 3
 * arbitrary NPCs — the "cast tracks who you care about" behaviour doesn't happen.
 *
 * The on-stage signal is the real driver: ALL on-stage NPCs get +1 per turn, vs one NPC per
 * heartbeat via the tick. With 3 on-stage NPCs, that's +3/turn total vs +1/heartbeat — sustained
 * on-stage presence reaches ACTIVITY_PROMOTE in ~5 turns; off-stage NPCs decay to 0 in ~6 beats.
 * The deep tier naturally tracks the player's active social circle and rotates between scenes.
 *
 * Pure, synchronous, +0 LLM. Runs unconditionally (not tier-gated) — same pattern as the short-want
 * lifecycle at line 353. `state.onStageNpcIds` is the previous turn's on-stage set (set via
 * callbacks.setOnStageNpcIds during the previous turn's post-processing).
 */
function bumpOnStageActivity(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
): void {
    const onStageIds = state.onStageNpcIds;
    if (!onStageIds || onStageIds.length === 0) return;

    // Clock matches the heartbeat's `now` (currentTick + 1) so decay math stays consistent.
    const now = (state.context.agencyTick ?? 0) + 1;

    const npcById = new Map<string, NPCEntry>();
    for (const npc of npcLedger) npcById.set(npc.id, npc);

    for (const id of onStageIds) {
        const npc = npcById.get(id);
        if (!npc) continue;
        if (!isAgencyEligible(npc)) continue;  // skip PC, locked, dead — same gate as the tick
        callbacks.updateNPC(id, activityBumpPatch(npc, now));
    }
}

// ── Timeskip path (+1 batched LLM for narration, engine state only otherwise) ──
function runTimeskipPath(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
    weeks: number,
    currentTick: number,
    sceneStakes: SceneStakes,
): void {
    const pc = npcLedger.find(n => n.isPC);
    const roster = buildProximityRoster(npcLedger, pc);

    // Upgrade wants→goals for all roster NPCs idempotently before simulation
    const upgradedRoster = roster.map(npc => {
        if (!npc.goalRecords || npc.goalRecords.length === 0) {
            const goals = upgradeWantsToGoals(npc, currentTick);
            if (goals.length > 0) {
                const upgraded = { ...npc, goalRecords: goals };
                callbacks.updateNPC(npc.id, { goalRecords: goals });
                return upgraded;
            }
        }
        return npc;
    });

    const provider = state.getFreshSummarizerProvider?.() ?? state.getFreshProvider();

    const result = runTimeskip({
        provider,
        roster: upgradedRoster,
        weeks,
        now: currentTick,
        sceneStakes,
        advanceTick: (by: number) => {
            const newTick = currentTick + by;
            callbacks.updateContext({ agencyTick: newTick });
            return newTick;
        },
    });

    // Persist NPC state deltas from the timeskip simulation.
    // WO-05 §D / WO-06: the nudge + tier-cross mutate `updatedNPCs` copies in place. We detect a
    // changed NPC by `previousSnapshot` being set (only the nudge/tier-cross branches set it;
    // a pure spread copy carries no `previousSnapshot`). goalRecords always persist as before.
    for (const npc of result.updatedNPCs) {
        const changed = !!npc.previousSnapshot;
        if (npc.goalRecords && !changed) {
            callbacks.updateNPC(npc.id, { goalRecords: npc.goalRecords });
        } else if (changed) {
            const patch: Partial<NPCEntry> = {};
            if (npc.goalRecords) patch.goalRecords = npc.goalRecords;
            if (npc.personalityHex !== undefined) patch.personalityHex = npc.personalityHex;
            if (npc.skillRung !== undefined) patch.skillRung = npc.skillRung;
            if (npc.previousSnapshot) patch.previousSnapshot = npc.previousSnapshot;
            if (npc.shiftTurnCount !== undefined) patch.shiftTurnCount = npc.shiftTurnCount;
            callbacks.updateNPC(npc.id, patch);
        }
    }

    // Advance the tick counter
    callbacks.updateContext({ agencyTick: currentTick + result.ticksConsumed });

    // Build and store the digest (player-visible deltas, folded into next GM call, +0)
    if (result.deltas.length > 0) {
        const digestText = buildDigest(result.deltas, 'player');
        if (digestText) {
            const existing = state.context.agencyDigest ?? '';
            const combined = existing ? existing + '\n' + digestText : digestText;
            callbacks.updateContext({ agencyDigest: combined });
        }

        const debugText = buildDigest(result.deltas, 'debug');
        if (debugText) {
            console.log(`[AgencyTick] timeskip weeks=${weeks} ticks=${result.ticksConsumed}\n${debugText}`);
        }
    }

    // Timeskip narration: +1 LLM call (the ONLY additional LLM cost).
    // The narration is appended as a system message at the seam.
    if (result.narration && provider) {
        backgroundQueue.push('Timeskip-Narration', async () => {
            try {
                const narrationPrompt = joinPromptSections(
                    TTRPG_PERSONA_GM_ASSISTANT,
                    `Write the "what you return to" beat after a time-skip of about ${weeks.toFixed(1)} weeks.`,
                    `While the player was away, the world kept moving. Below are the off-screen developments that are now visible to the player — already decided, NOT for you to change. Weave them into a single cohesive in-fiction paragraph that lands when the player steps back into the scene: the sense that time genuinely passed and people pursued their own lives.`,
                    `RULES:
- 2-4 sentences, second person ("you return to find…"), present the changes as discovered, not narrated as a report.
- Dramatize ONLY the developments listed. Do NOT invent new characters, events, deaths, or plot twists beyond them.
- Use the characters' names exactly as given. Keep each development recognizable.
- No game mechanics, numbers, dice, percentages, or meta language — pure fiction.
- If the developments conflict in tone, hold them side by side; do not resolve or editorialize.`,
                    ANCHOR_BEFORE_INPUT,
                    INPUT_DELIMITER,
                    `OFF-SCREEN DEVELOPMENTS:\n${result.narration}`,
                );
                const narrationText = await llmCall(provider, narrationPrompt, { priority: 'low', maxTokens: 300, thinkingEffort: 'off' });
                if (narrationText && narrationText.trim()) {
                    callbacks.addMessage({
                        id: uid(),
                        role: 'system',
                        name: 'timeskip-seam',
                        content: `[Time passes] ${narrationText.trim()}`,
                        timestamp: Date.now(),
                    });
                }
            } catch (err) {
                console.warn('[AgencyTick] Timeskip narration failed, using deterministic fallback:', err);
                if (result.narration) {
                    callbacks.addMessage({
                        id: uid(),
                        role: 'system',
                        name: 'timeskip-seam',
                        content: `[Time passes] ${result.narration}`,
                        timestamp: Date.now(),
                    });
                }
            }
        }).catch((e) => console.warn('[AgencyTick] Timeskip-Narration queue push failed:', e));
    }
}

// ── Arc Engine (System 2 / Oracle Function) — WO-05 tick + surface (+0 LLM) ──
// Sibling of runAgencyTick. For each active arc: roll the tempo (rollArcTick), and
// when it fires roll the outcome (rollArcOutcome) and advance the rung (advanceRung,
// bent by the stance from scanArcStance). On a 'direct'/boiled_over rung with
// ignored/fled stance, write the rung label as a FACT into divergenceRegister (the
// "world moved without you" consequence — never a score/penalty counter). Then fold
// arcSurfaceLine into context.arcDigest (mirror the agencyDigest fold at ~629).
// Pure dice + deterministic scan; ZERO LLM. The ONLY deliberate cost is the gated
// spawn at the seal seam (handleSealChapter).
export function runArcTick(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    lastAssistantContent: string,
): void {
    if (!tierAllows(state.settings.aiTier, 'arcTick')) return;
    const arcs = state.context.arcs;
    if (!arcs || arcs.length === 0) return;

    const archiveIndex = state.archiveIndex;
    const sceneId = archiveIndex.length > 0
        ? archiveIndex[archiveIndex.length - 1].sceneId
        : '000';

    // Stance scan — deterministic, +0. Returns only arcs whose stance is determinable
    // this turn; we merge those onto the working copies and persist them. Arcs not
    // returned keep their prior stance (the default at spawn is 'unaware').
    const activeArcs = arcs.filter(a => a.status === 'active');
    if (activeArcs.length === 0) return;

    const stanceUpdates = scanArcStance(displayInput, lastAssistantContent, activeArcs);
    const stanceById = new Map(stanceUpdates.map(u => [u.arcId, u.stance]));

    let arcsChanged = false;
    const nextArcs: ArcRecord[] = [];
    const digestLines: string[] = [];
    const divergenceFacts: DivergenceEntry[] = [];

    for (const arc of arcs) {
        if (arc.status !== 'active') {
            nextArcs.push(arc);
            continue;
        }

        // Apply stance update if one was determined this turn.
        const newStance = stanceById.get(arc.id) ?? arc.stance;
        const stanceChanged = newStance !== arc.stance;
        let working = stanceChanged ? { ...arc, stance: newStance } : arc;

        // Tempo roll — mirrors rollHeartbeat. DC persists regardless of fire.
        const tick = rollArcTick(working);
        if (tick.fired) {
            // Outcome roll — d20 + stance mod vs base DC, reusing the agency band mapper.
            const outcome = rollArcOutcome(working);
            const advanced = advanceRung(working, outcome.band);
            // lastTickScene marks "this arc moved this scene" — the recency signal
            // arcWorldState reads to decide 'live' vs 'stalled'.
            working = { ...advanced, lastTickScene: sceneId };
            arcsChanged = true;

            // Avoidance/consequence rule (contract §5): on a 'direct' rung (or
            // boiled_over) with ignored/fled stance, write the rung label as a FACT
            // into divergenceRegister. The world moved without the player — never a
            // score/penalty counter. 'opposed' that regresses to rung 0 sets 'defused'.
            const currentRung = working.ladder[working.currentRung];
            const isDirectOrBoiled = currentRung?.surface === 'direct' || working.status === 'boiled_over';
            const isAvoidant = working.stance === 'ignored' || working.stance === 'fled';
            if (isDirectOrBoiled && isAvoidant) {
                divergenceFacts.push({
                    id: uid(),
                    chapterId: `arc:${working.id}`,
                    category: 'world_state',
                    text: currentRung?.label ?? working.seed,
                    sceneRef: sceneId,
                    npcIds: [],
                    pinned: false,
                    source: 'auto',
                });
                console.log(`[ArcTick] arc=${working.id} stance=${working.stance} rung=${working.currentRung} → divergence fact written`);
            }

            // Defused: opposed stance + outcome regressed the arc to rung 0.
            if (working.stance === 'opposed' && working.currentRung === 0 && outcome.band === 'critFail') {
                working = { ...working, status: 'defused' };
                console.log(`[ArcTick] arc=${working.id} defused (opposed + regress to rung 0)`);
            }

            console.log(`[ArcTick] tick fired arc=${working.id} band=${outcome.band} rung=${working.currentRung} status=${working.status}`);
        } else {
            // Miss — persist the reduced DC (pity timer). If only the DC moved (no
            // rung change) we still need to write it back so the next seam sees it.
            if (tick.nextDc !== working.tickDC) {
                working = { ...working, tickDC: tick.nextDc };
                arcsChanged = true;
            }
            if (stanceChanged) arcsChanged = true;
        }

        // Surface line — the current rung → one digest line, tagged by surface tier.
        // No raw rung/tickDC ever reaches the payload, only this text.
        const line = arcSurfaceLine(working);
        if (line) digestLines.push(line);

        nextArcs.push(working);
    }

    if (arcsChanged) {
        callbacks.updateContext({ arcs: nextArcs });
    }

    // Fold the surface lines into context.arcDigest for the next GM call (+0, mirrors
    // the agencyDigest fold at ~629).
    if (digestLines.length > 0) {
        // Rebuild fresh from THIS tick's surface lines — never concat the prior digest
        // (stale rung lines were piling up across ticks). Dedupe as a safety net.
        const fresh = Array.from(new Set(digestLines)).join('\n');
        callbacks.updateContext({ arcDigest: fresh });
    }

    // Write avoidance facts to divergenceRegister (mergeSealEntries appends, same as
    // the seal-audit path at ~line 1016). A world fact, never a penalty counter.
    if (divergenceFacts.length > 0) {
        const liveRegister = state.divergenceRegister;
        if (liveRegister && callbacks.setDivergenceRegister) {
            const merged = mergeSealEntries(liveRegister, divergenceFacts, sceneId);
            callbacks.setDivergenceRegister(merged);
            console.log(`[ArcTick] ${divergenceFacts.length} arc divergence fact(s) written`);
        } else {
            // No live register / callback this turn — surface the facts as a system
            // marker so they aren't lost (rare; the seal seam usually has the register).
            for (const f of divergenceFacts) {
                callbacks.addMessage({
                    id: uid(),
                    role: 'system',
                    name: 'arc-fact',
                    content: `[World moved] ${f.text}`,
                    timestamp: Date.now(),
                });
            }
        }
    }
}

async function handleSealChapter(state: TurnState, callbacks: TurnCallbacks, activeCampaignId: string) {
    const currentChapters = await chapterRepository.loadChapters(activeCampaignId);

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
                // WO2: feed existing subjectTokens to the seal call so the LLM reuses them for
                // facts about the same subject (token consistency across chapters). Tens of slugs only.
                const existingTokens = state.divergenceRegister
                    ? Array.from(new Set(
                        state.divergenceRegister.entries
                            .map(e => e.subjectToken)
                            .filter((t): t is string => typeof t === 'string' && t.length > 0)
                        ))
                    : undefined;
                const sealResult = await tryWithFallback(
                    'SealChapter',
                    () => runCombinedSeal(activeCampaignId, sealed, summarizerProvider ?? storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreadsList, existingTokens),
                    () => runCombinedSeal(activeCampaignId, sealed, storyProvider!, state.npcLedger ?? [], state.archiveIndex, openThreadsList, existingTokens),
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
                    notify.warning('Chapter sealed but divergence facts failed to parse');
                }

                // Arc Engine spawn is MANUAL — fired by the Arc Injector button, never
                // automatically at the seam. The player pressing the button is the spawn
                // signal ("nothing more reliable than the user"), so no arcWorldState
                // gate is needed. runArcTick below still ticks/surfaces existing arcs.
            }

            const updatedChapters = await chapterRepository.loadChapters(activeCampaignId);
            if (callbacks.setChapters) callbacks.setChapters(updatedChapters);
            notify.success('Chapter sealed');
        } catch (err) {
            console.error('[SealChapter] Failed to seal chapter:', err);
            notify.error('Failed to seal chapter');
        }
    }
}

