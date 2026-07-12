/**
 * NPC stage — extracted from turnPostProcess.ts (W10).
 * NPC pressure scan, agency tick, activity bump, timeskip path, arc tick.
 */

import type { NPCEntry, SceneStakes, DivergenceEntry, ArcRecord } from '../../../types';
import { tierAllows } from '../aiTier';
import type { TurnCallbacks, TurnState } from '../turnTypes';

import { uid } from '../../../utils/uid';
import { scanPressure, buildPressurePatch, applyDecay } from '../../npc';
import {
    rollHeartbeat, buildProximityRoster, upgradeWantsToGoals, chooseTick, rollGoal,
    applyBandToGoal, nextFailStreak, buildDigest, visibilityFromBand,
    detectTimeskip, runTimeskip, applyGoalOutcomeNudge, applyTierCross,
    selectTickTarget, activityBumpPatch, detectCollision, resolveTangle, buildTangleDeltas,
    HEARTBEAT_DC, GOAL_BASE_DC, COLLISION_TANGLE_PROB,
} from '../../npc';
import type { TickDelta, Band } from '../../npc';
import { rollArcTick, rollArcOutcome, advanceRung, arcSurfaceLine, scanArcStance } from '../../arc';
import { llmCall } from '../../../utils/llmCall';
import { isAgencyEligible } from "../../npc";
import { mergeSealEntries } from "../../campaign-state";

import { backgroundQueue, joinPromptSections, ANCHOR_BEFORE_INPUT, INPUT_DELIMITER, TTRPG_PERSONA_GM_ASSISTANT } from '../../infrastructure';

export function runNPCPressureScan(
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

export function runAgencyTick(
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
export function bumpOnStageActivity(
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
export function runTimeskipPath(
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

