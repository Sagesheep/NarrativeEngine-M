import type { GameContext, NPCEntry, NPCPressure } from '../../types';
import { turnSnapshotStorage } from '../storage/turnSnapshotStorage';
import { embeddingStorage } from '../storage/embeddingStorage';
import { embedText, getCurrentModelId } from '../embedding';
import { buildNPCEmbeddingText } from '../npc';

export type TurnRewindTargets = {
    npcLedger: NPCEntry[];
    updateContext: (patch: Partial<GameContext>) => void;
    setNPCLedger: (npcs: NPCEntry[]) => void;
    setNpcPressure: (map: Record<string, NPCPressure>) => void;
    setOnStageNpcIds: (ids: string[]) => void;
};

/**
 * Put the turn-driven state (NPC ledger, pressure, inventory, profile, notebook,
 * agency/arc state, engine DCs) back to how it stood before `messageId`'s turn.
 * Returns false when no snapshot was kept for that turn (older than the cap, or
 * played before snapshots existed) — the state is then left as is.
 */
export async function rewindTurnState(
    campaignId: string,
    messageId: string,
    fromTimestamp: number,
    t: TurnRewindTargets,
): Promise<boolean> {
    const snap = await turnSnapshotStorage.takeFrom(campaignId, messageId, fromTimestamp);
    if (!snap) return false;

    t.updateContext(snap.context);
    t.setNpcPressure(snap.npcPressure);
    t.setOnStageNpcIds(snap.onStageNpcIds);
    syncNpcVectors(campaignId, t.npcLedger, snap.npcLedger);
    t.setNPCLedger(snap.npcLedger);
    return true;
}

// setNPCLedger doesn't touch vectors: drop the ones for NPCs the rewound turns
// introduced and re-embed NPCs whose description they changed (or that were
// removed since, and come back without a vector).
function syncNpcVectors(campaignId: string, current: NPCEntry[], restored: NPCEntry[]): void {
    const restoredById = new Map(restored.map(n => [n.id, n]));
    for (const n of current) {
        if (!restoredById.has(n.id)) {
            embeddingStorage.deleteByTypeAndId(campaignId, 'npc', n.id)
                .catch(e => console.warn('[Rewind] NPC vector delete failed:', e));
        }
    }
    const currentById = new Map(current.map(n => [n.id, n]));
    for (const n of restored) {
        const was = currentById.get(n.id);
        const text = buildNPCEmbeddingText(n);
        if (!text || (was && buildNPCEmbeddingText(was) === text)) continue;
        embedText(text)
            .then(vec => vec && embeddingStorage.store(campaignId, n.id, Array.from(vec), 'npc', getCurrentModelId()))
            .catch(e => console.warn(`[Rewind] Re-embed failed for ${n.name}:`, e));
    }
}
