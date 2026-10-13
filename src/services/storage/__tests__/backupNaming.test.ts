import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { set as idbSet, clear as idbClear } from 'idb-keyval';
import { backupStorage } from '../backupStorage';

const CID = 'camp';
let tick = 1_000_000;

/** Each backup needs different content (unchanged auto backups are skipped) and a distinct timestamp. */
async function changeAndBackup(n: number, opts: { isAuto: boolean; label?: string }): Promise<{ timestamp: number }> {
    await idbSet(`${CID}_scenes`, [{ sceneId: String(n).padStart(3, '0'), userContent: `u${n}`, assistantContent: `a${n}`, timestamp: n }]);
    vi.setSystemTime(++tick);
    const result = await backupStorage.create(CID, { trigger: opts.isAuto ? 'auto' : 'manual', ...opts });
    if (result.skipped) throw new Error('backup unexpectedly skipped');
    return result;
}

describe('named backups', () => {
    beforeEach(async () => {
        await idbClear();
        vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renames any backup', async () => {
        const created = await changeAndBackup(1, { isAuto: false, label: 'Before the duel' });
        const meta = await backupStorage.updateLabel(CID, created.timestamp, '  After the duel ');
        expect(meta?.label).toBe('After the duel');
        expect((await backupStorage.list(CID))[0].label).toBe('After the duel');
        expect(await backupStorage.updateLabel(CID, 42, 'x')).toBeNull();
    });

    it('keeps only the newest 10 unnamed auto backups, but never a named one', async () => {
        const first = await changeAndBackup(1, { isAuto: true });
        await backupStorage.updateLabel(CID, first.timestamp, 'Keep me');
        for (let n = 2; n <= 14; n++) await changeAndBackup(n, { isAuto: true });

        const list = await backupStorage.list(CID);
        expect(list.filter(b => !b.label)).toHaveLength(10);
        expect(list.some(b => b.label === 'Keep me')).toBe(true);
    });

    it('manual backups are never pruned', async () => {
        await changeAndBackup(1, { isAuto: false, label: 'Manual' });
        for (let n = 2; n <= 13; n++) await changeAndBackup(n, { isAuto: true });
        expect((await backupStorage.list(CID)).some(b => b.label === 'Manual')).toBe(true);
    });
});
