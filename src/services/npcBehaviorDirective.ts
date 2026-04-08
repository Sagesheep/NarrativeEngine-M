import type { NPCEntry } from '../types';

function natureDescriptor(v: number): string | null {
    if (v <= 3) return 'pacifist, avoids conflict';
    if (v >= 9) return 'feral, violent, predatory';
    if (v >= 7) return 'aggressive, quick to fight';
    return null;
}

function trainingDescriptor(v: number): string | null {
    if (v <= 3) return 'unskilled, clumsy';
    if (v >= 9) return 'legendary, masterful';
    if (v >= 7) return 'highly trained, disciplined';
    return null;
}

function emotionDescriptor(v: number): string | null {
    if (v <= 3) return 'emotionally flat, cold';
    if (v >= 9) return 'volatile, hysterical';
    if (v >= 7) return 'passionate, expressive';
    return null;
}

function socialDescriptor(v: number): string | null {
    if (v <= 3) return 'terse, avoids conversation';
    if (v >= 9) return 'manipulative, silver-tongued';
    if (v >= 7) return 'charismatic, persuasive';
    return null;
}

function beliefDescriptor(v: number): string | null {
    if (v <= 3) return 'cynical, nihilistic';
    if (v >= 9) return 'zealous, messianic';
    if (v >= 7) return 'devout, principled';
    return null;
}

function egoDescriptor(v: number): string | null {
    if (v <= 3) return 'selfless, humble';
    if (v >= 9) return 'god-complex, refuses equals';
    if (v >= 7) return 'proud, self-important';
    return null;
}

function affinityDescriptor(v: number): string {
    if (v <= 15) return 'Nemesis — actively hostile';
    if (v <= 30) return 'Distrustful — suspicious and cold';
    if (v <= 45) return 'Wary — cautious, guarded';
    if (v <= 55) return 'Neutral';
    if (v <= 70) return 'Warm — generally friendly';
    if (v <= 85) return 'Trusted ally';
    return 'Devoted — deep loyalty';
}

export function buildBehaviorDirective(npc: NPCEntry): string {
    const traits: string[] = [];

    const nd = natureDescriptor(npc.nature);
    if (nd) traits.push(nd);
    const td = trainingDescriptor(npc.training);
    if (td) traits.push(td);
    const ed = emotionDescriptor(npc.emotion);
    if (ed) traits.push(ed);
    const sd = socialDescriptor(npc.social);
    if (sd) traits.push(sd);
    const bd = beliefDescriptor(npc.belief);
    if (bd) traits.push(bd);
    const egod = egoDescriptor(npc.ego);
    if (egod) traits.push(egod);

    const affinityLabel = affinityDescriptor(npc.affinity);
    const traitPart = traits.length > 0 ? ` | ${traits.join(', ')}` : '';
    return `PLAY AS: [Affinity: ${affinityLabel}]${traitPart}`;
}

export function buildDriftAlert(npc: NPCEntry): string | null {
    if (!npc.previousAxes) return null;
    if (npc.shiftTurnCount !== undefined && npc.shiftTurnCount >= 3) return null;

    const axisFields = ['nature', 'training', 'emotion', 'social', 'belief', 'ego'] as const;
    const shifts: string[] = [];

    for (const f of axisFields) {
        const prev = npc.previousAxes[f];
        if (prev === undefined) continue;
        const curr = npc[f] as number;
        if (Math.abs(curr - prev) >= 2) {
            shifts.push(`${f} ${prev}→${curr}`);
        }
    }

    if (npc.previousAxes.affinity !== undefined) {
        const prevAff = npc.previousAxes.affinity;
        const currAff = npc.affinity;
        if (Math.abs(currAff - prevAff) >= 10) {
            shifts.push(`affinity ${prevAff}→${currAff}`);
        }
    }

    if (shifts.length === 0) return null;
    return `⚠ SHIFT: ${shifts.join(', ')}`;
}
