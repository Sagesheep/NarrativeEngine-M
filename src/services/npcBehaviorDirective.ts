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

export function buildBehaviorDirective(npc: NPCEntry): string {
    const affinityLabel = affinityDescriptor(npc.affinity);
    const parts: string[] = [`[Affinity: ${affinityLabel}]`];

    const personality = npc.personality || npc.disposition || '';
    if (personality) parts.push(personality);

    const voice = npc.voice || '';
    if (voice) parts.push(`Voice: ${voice}`);

    const example = npc.exampleOutput || '';
    if (example) parts.push(`Example: ${example}`);

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
