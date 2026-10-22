import type { GameContext, NPCEntry, NPCPressure } from '../../types';
import { getList, setList, k } from './_helpers';

// State a turn mutates outside the archive. Snapshotted before each turn so a
// rewind (edit/regenerate an older user message) can put it back — the archive,
// timeline and facts are rolled back by scene id; this covers everything else.
// Only engine-driven context fields: player settings, notes and lore stay as the
// player left them.
export const TURN_CONTEXT_FIELDS = [
    'inventory', 'inventoryLastScene',
    'characterProfile', 'characterProfileLastScene', 'characterProfileActive',
    'surpriseDC', 'encounterDC', 'worldEventDC', 'npcIntroDC',
    'agencyTick', 'agencyHeartbeatDC', 'agencyDigest',
    'arcs', 'arcDigest',
    'notebook', 'lastSceneStakes',
] as const satisfies readonly (keyof GameContext)[];

export type TurnContextFields = Pick<GameContext, typeof TURN_CONTEXT_FIELDS[number]>;

export type TurnSnapshot = {
    /** Id of the user message whose turn this snapshot precedes. */
    messageId: string;
    timestamp: number;
    context: Partial<TurnContextFields>;
    npcLedger: NPCEntry[];
    npcPressure: Record<string, NPCPressure>;
    onStageNpcIds: string[];
};

/** Rewinds further back than this restore nothing (the archive still rolls back). */
export const MAX_TURN_SNAPSHOTS = 30;

export function pickTurnContext(context: GameContext): Partial<TurnContextFields> {
    const out: Partial<TurnContextFields> = {};
    for (const f of TURN_CONTEXT_FIELDS) {
        if (f in context) (out as Record<string, unknown>)[f] = context[f];
    }
    return out;
}

const key = (cid: string) => k(cid, 'turn_snapshots');

// Writes are chained per campaign so a capture and a rewind can't interleave
// their read-modify-write of the list.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
}

export const turnSnapshotStorage = {
    save(cid: string, snap: TurnSnapshot): Promise<void> {
        return serial(async () => {
            const list = await getList<TurnSnapshot>(key(cid));
            const kept = list.filter(s => s.messageId !== snap.messageId);
            kept.push(snap);
            await setList(key(cid), kept.slice(-MAX_TURN_SNAPSHOTS));
        });
    },

    /** Returns the snapshot taken before `messageId`'s turn (if kept) and drops
     *  every snapshot from that turn on — those turns no longer exist. */
    takeFrom(cid: string, messageId: string, fromTimestamp: number): Promise<TurnSnapshot | null> {
        return serial(async () => {
            const list = await getList<TurnSnapshot>(key(cid));
            const hit = list.find(s => s.messageId === messageId) ?? null;
            const kept = list.filter(s => s.timestamp < fromTimestamp && s.messageId !== messageId);
            if (kept.length !== list.length) await setList(key(cid), kept);
            return hit;
        });
    },

    clear(cid: string): Promise<void> {
        return serial(() => setList(key(cid), []));
    },
};
