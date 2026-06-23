import type { NPCEntry, HexAxis } from '../../types';
import { relationBand, describeHex, formatHexShift, formatRungShift } from './agencyBands';
import { buildReactionMenu, type ReactionContext } from './reactionMenu';
import { applyRepressionToMenu } from './reactionRepression';

function affinityDescriptor(v: number): string {
    if (v <= 15) return 'Nemesis — actively hostile';
    if (v <= 30) return 'Distrustful — suspicious and cold';
    if (v <= 45) return 'Wary — cautious, guarded';
    if (v <= 55) return 'Neutral';
    if (v <= 70) return 'Warm — generally friendly';
    if (v <= 85) return 'Trusted ally';
    return 'Devoted — deep loyalty';
}

function truncate(s: string, max: number): string {
    if (!s || s.length <= max) return s;
    return s.substring(0, max) + '…';
}

export type BehaviorDirectiveOpts = {
    context?: ReactionContext; // Phase 2 §9.1 — peaceful/dangerous filters the reaction menu
    rng?: () => number;         // injected for deterministic tests
    matureMode?: boolean;       // mirrors agencyWantDraw mature gating
};

export function buildBehaviorDirective(npc: NPCEntry, opts: BehaviorDirectiveOpts = {}): string {
    const parts: string[] = [];

    // Prefer the re-homed PC edge (word-banded -3..+3); fall back to legacy affinity for
    // un-migrated NPCs. Numbers never reach the LLM — band words only.
    const affinityLabel = npc.pcRelation !== undefined
        ? relationBand(npc.pcRelation)
        : affinityDescriptor(npc.affinity);
    parts.push(`[Aff: ${affinityLabel}]`);

    if (npc.personalityHex) {
        parts.push(`Personality: ${describeHex(npc.personalityHex)}`);
    }

    // Agency wants (Phase 2) supersede the legacy drives display when present — a migrated NPC
    // carries both, and they hold the same seeded content, so show one to avoid duplication.
    if (npc.wants && (npc.wants.long || npc.wants.medium?.length || npc.wants.short?.length)) {
        if (npc.wants.long) parts.push(`GOAL: ${truncate(npc.wants.long, 80)}`);
        if (npc.wants.medium?.[0]) parts.push(`PURSUING: ${truncate(npc.wants.medium[0], 60)}`);
        if (npc.wants.short?.[0]) parts.push(`NOW: ${truncate(npc.wants.short[0], 40)}`);
    } else if (npc.drives) {
        const driveParts: string[] = [];
        if (npc.drives.sceneWant) driveParts.push(truncate(npc.drives.sceneWant, 80));
        if (npc.drives.sessionWant) driveParts.push(truncate(npc.drives.sessionWant, 80));
        if (npc.drives.coreWant) driveParts.push(truncate(npc.drives.coreWant, 80));
        if (driveParts.length > 0) parts.push(`WANTS: ${driveParts.join(' ← ')}`);
    }

    if (npc.hardBoundaries && npc.hardBoundaries.length > 0) {
        parts.push(`WON'T: ${npc.hardBoundaries.map(b => truncate(b, 40)).join('; ')}`);
    }

    if (npc.softBoundaries && npc.softBoundaries.length > 0) {
        parts.push(`RESENTS: ${npc.softBoundaries.map(b => truncate(b, 40)).join('; ')}`);
    }

    if (npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
        parts.push(`ON "${npc.behavioralTriggers[0].keyword}": ${truncate(npc.behavioralTriggers[0].shift, 50)}`);
        for (let i = 1; i < npc.behavioralTriggers.length; i++) {
            const t = npc.behavioralTriggers[i];
            parts.push(`ON "${t.keyword}": ${truncate(t.shift, 50)}`);
        }
    }

    const voice = npc.voice || '';
    if (voice) parts.push(`Voice: ${truncate(voice, 60)}`);

    const example = npc.exampleOutput || '';
    if (example) parts.push(`Example: ${truncate(example, 80)}`);

    // Phase 2 §9.1 — engine-built reaction menu. The engine scores REACTION_VOCAB against
    // the NPC's fixed hex+traits and surfaces rank-1 + 2 sampled alternatives. The story AI
    // may only pick ONE from the list — the load-bearing enforcement clause prevents it from
    // inventing a softer, out-of-character reaction (the sycophant-smoothing failure mode).
    // Skipped entirely for legacy hex-less NPCs or when the menu is empty.
    // NOTE: `context` defaults to 'peaceful'; wire it from encounter/combat state when
    // available at the call site (a later refinement). `matureMode` threads the same gate
    // the want/action draws use.
    if (npc.personalityHex) {
        const context = opts.context ?? 'peaceful';
        const rng = opts.rng ?? Math.random;
        const matureMode = opts.matureMode ?? false;
        const rawMenu = buildReactionMenu(npc, context, rng, matureMode);
        // Inner repression (peaceful only): if the NPC's top impulse is a hostile/self-interested
        // one, the engine rolls whether they hide it and rewrites that entry into a leak/mask
        // token. The `event` (pressure delta / catharsis) is intentionally discarded here —
        // payload assembly can re-run, so booking happens once-per-turn elsewhere, not in this
        // read path. See reactionRepression.ts.
        const { menu } = applyRepressionToMenu(rawMenu, npc, context, rng);
        if (menu.length > 0) {
            // NOTE: fallback switch point — if playtest shows the AI still always grabs the
            // gentlest, replace the menu with a single engine-picked reaction (rank-1 or
            // weighted-random among the surfaced set) asserted as fact. Same principle as the
            // dice forcing function. Ship AI-picks-from-menu first; keep engine-picks in reserve.
            parts.push(
                `REACTIONS (choose ONE and play it — do NOT invent a softer reaction; prefer the less obvious when several fit): ${menu.join(' | ')}`
            );
        }
    }

    return `PLAY AS: ${parts.join(' | ')}`;
}

export function buildDriftAlert(npc: NPCEntry): string | null {
    if (!npc.previousSnapshot) return null;
    if (npc.shiftTurnCount !== undefined && npc.shiftTurnCount >= 3) return null;

    const shifts: string[] = [];
    const prev = npc.previousSnapshot;

    if (prev.affinity !== undefined && Math.abs(npc.affinity - prev.affinity) >= 10) {
        shifts.push(`affinity ${prev.affinity}→${npc.affinity}`);
    }

    const currentPersonality = npc.personality || npc.disposition || '';
    if (prev.personality !== undefined && prev.personality !== currentPersonality && prev.personality !== '' && currentPersonality !== '') {
        shifts.push('personality changed');
    }

    if (prev.voice !== undefined && prev.voice !== '' && npc.voice !== '' && prev.voice !== npc.voice) {
        shifts.push('voice changed');
    }

    // WO-05 §C — hex-axis drift surfaces as a word-band SHIFT (never the raw integer).
    // Only emit when the band word actually changes; a sub-band ±1 move that stays in the same
    // word isn't worth surfacing (formatHexShift returns '' in that case).
    if (prev.personalityHex && npc.personalityHex) {
        const axes: HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
        for (const axis of axes) {
            const line = formatHexShift(axis, prev.personalityHex[axis], npc.personalityHex[axis]);
            if (line) shifts.push(line.replace('SHIFT: ', ''));
        }
    }

    // WO-05 §A — pcRelation drift surfaces as a word-band SHIFT (never the raw −3..+3 integer).
    if (prev.pcRelation !== undefined && npc.pcRelation !== undefined
        && prev.pcRelation !== npc.pcRelation) {
        const fromWord = relationBand(prev.pcRelation);
        const toWord = relationBand(npc.pcRelation);
        if (fromWord !== toWord) {
            shifts.push(`feeling toward PC ${fromWord} → ${toWord}`);
        }
    }

    // WO-06 §2 — rung bump surfaces as a word-band SHIFT (never the integer 0..4).
    if (prev.skillRung !== undefined && npc.skillRung !== undefined
        && prev.skillRung !== npc.skillRung) {
        const rungShift = formatRungShift(prev.skillRung, npc.skillRung);
        if (rungShift) shifts.push(rungShift.replace('SHIFT: ', ''));
    }

    if (shifts.length === 0) return null;
    return `SHIFT: ${shifts.join(', ')}`;
}
