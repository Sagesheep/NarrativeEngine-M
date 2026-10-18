import type { NPCEntry, HexAxis } from '../../types';
import { relationBand, formatHexShift, formatRungShift } from './agencyBands';

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
