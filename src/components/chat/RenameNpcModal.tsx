import { useEffect, useRef, useState } from 'react';
import { X, Replace, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { archiveStorage } from '../../services/storage/archiveStorage';
import { useBackHandler } from '../../hooks/useBackHandler';
import { toast } from '../Toast';

/**
 * Manual, user-driven name fix. Replaces a highlighted name with a new one across
 * the loaded chat, the sealed archive (scene prose + index), and reconciles the
 * ledger (merge into an existing same-name NPC, else rename the matching entry).
 * Replaces the removed automatic name-swap — the user is always in control here.
 *
 * Triggered from the header Rename icon (which captures the current text
 * selection), NOT a long-press toolbar — long-press collides with Android's
 * native selection handles, same reason pin/Lore-Check are header icons.
 */
export function RenameNpcModal() {
    const npcLedger = useAppStore(s => s.npcLedger);
    const open = useAppStore(s => s.renameModalOpen);
    const fromText = useAppStore(s => s.renameModalText);
    const onClose = useAppStore(s => s.closeRenameModal);
    const [to, setTo] = useState('');
    const [busy, setBusy] = useState(false);
    const openedAtRef = useRef(0);

    useEffect(() => { if (open) { setTo(''); setBusy(false); openedAtRef.current = Date.now(); } }, [open, fromText]);

    useBackHandler(open && !busy, onClose);

    if (!open) return null;

    const from = fromText.trim();
    const targetName = to.trim();
    const canApply = !!from && !!targetName && from.toLowerCase() !== targetName.toLowerCase();

    const apply = async () => {
        if (!canApply || busy) return;
        setBusy(true);
        try {
            const state = useAppStore.getState();
            const cid = state.activeCampaignId;
            const turn = state.archiveIndex.length > 0
                ? parseInt(state.archiveIndex[state.archiveIndex.length - 1].sceneId, 10) || 0
                : 0;

            const msgCount = state.renameAcrossMessages(from, targetName);
            const firstNameCount = state.renameFirstNameInLatestAssistant(from, targetName);
            const ledger = state.mergeOrRenameNpc(from, targetName, turn);

            let archiveCount = 0;
            if (cid) {
                archiveCount = await archiveStorage.renameText(cid, from, targetName);
                // refresh in-memory index so snippets/recall reflect the rename
                const fresh = await archiveStorage.getIndex(cid);
                state.setArchiveIndex(fresh);
            }

            const parts = [`${msgCount} message${msgCount === 1 ? '' : 's'}`];
            if (firstNameCount > 0) parts.push(`${firstNameCount} current-scene first-name fix`);
            if (archiveCount > 0) parts.push(`${archiveCount} archived scene${archiveCount === 1 ? '' : 's'}`);
            if (ledger === 'merged') parts.push('merged NPC');
            else if (ledger === 'renamed') parts.push('renamed NPC');
            toast.success(`"${from}" → "${targetName}": ${parts.join(', ')}`);
            onClose();
        } catch (e) {
            console.error('[Rename] failed:', e);
            toast.error('Rename failed — see console');
            setBusy(false);
        }
    };

    const handleBackdropClick = () => {
        if (busy) return;
        // Ignore the ghost-click that follows the touchstart/mousedown which opened
        // this modal — otherwise it lands on the backdrop and closes us instantly.
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-black/60 animate-in fade-in duration-200" onClick={handleBackdropClick}>
            <div className="bg-surface border border-border rounded-t-lg md:rounded-lg w-full md:max-w-sm md:mx-4 max-h-[calc(85*var(--app-vh))] overflow-y-auto flex flex-col animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Replace size={14} /> Rename Name
                    </h2>
                    <button onClick={onClose} disabled={busy} className="text-text-dim hover:text-text-primary disabled:opacity-40">
                        <X size={18} />
                    </button>
                </div>

                <div className="p-4 space-y-3">
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">From</div>
                        <div className="text-[13px] font-mono text-text-primary bg-void border border-border rounded px-2 py-1.5 truncate">{from || '—'}</div>
                    </div>
                    <div>
                        <div className="text-[9px] text-text-dim uppercase tracking-wider mb-1">To</div>
                        <input
                            autoFocus
                            value={to}
                            onChange={e => setTo(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') apply(); }}
                            list="npc-rename-targets"
                            placeholder="New name (or an existing NPC to merge into)"
                            className="w-full bg-void border border-border focus:border-terminal text-[13px] text-text-primary rounded px-2 py-1.5 outline-none"
                        />
                        <datalist id="npc-rename-targets">
                            {npcLedger.map(n => <option key={n.id} value={n.name} />)}
                        </datalist>
                    </div>
                    <p className="text-[10px] text-text-dim/70 leading-relaxed">
                        Replaces every whole-word "{from}" in the chat and the sealed archive. If "{targetName || '…'}" already
                        belongs to another NPC, this one is merged into it (archived); otherwise the matching ledger entry is renamed.
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} disabled={busy} className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded disabled:opacity-40">Cancel</button>
                    <button
                        onClick={apply}
                        disabled={!canApply || busy}
                        className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                        {busy && <Loader2 size={12} className="animate-spin" />}
                        Rename
                    </button>
                </div>
            </div>
        </div>
    );
}
