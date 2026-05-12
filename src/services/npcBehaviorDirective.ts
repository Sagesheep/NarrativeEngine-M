import type { NPCEntry } from '../types';

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

export function buildBehaviorDirective(npc: NPCEntry): string {
    const parts: string[] = [];

    const affinityLabel = affinityDescriptor(npc.affinity);
    parts.push(`[Aff: ${affinityLabel}]`);

    if (npc.drives) {
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

    if (shifts.length === 0) return null;
    return `SHIFT: ${shifts.join(', ')}`;
}
