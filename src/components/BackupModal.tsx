import { useState, useEffect } from 'react';
import { X, RotateCcw, Trash2, Save, Clock, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/apiClient';
import type { BackupMeta } from '../types';
import { toast } from './Toast';

export function BackupModal() {
    const { backupModalOpen, toggleBackupModal, activeCampaignId } = useAppStore();
    const [backups, setBackups] = useState<BackupMeta[]>([]);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [restoringTs, setRestoringTs] = useState<number | null>(null);
    const [label, setLabel] = useState('');

    useEffect(() => {
        if (backupModalOpen && activeCampaignId) loadBackups();
    }, [backupModalOpen, activeCampaignId]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && backupModalOpen) toggleBackupModal();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [backupModalOpen, toggleBackupModal]);

    if (!backupModalOpen) return null;

    async function loadBackups() {
        if (!activeCampaignId) return;
        setLoading(true);
        const list = await api.backup.list(activeCampaignId);
        setBackups(list);
        setLoading(false);
    }

    async function handleCreateManual() {
        if (!activeCampaignId) return;
        setCreating(true);
        const result = await api.backup.create(activeCampaignId, {
            trigger: 'manual',
            label: label.trim() || 'Manual backup',
            isAuto: false,
        });
        if (result?.skipped) {
            toast.info('No changes since last backup');
        } else if (result?.timestamp) {
            toast.success('Manual backup created');
            setLabel('');
            await loadBackups();
        } else {
            toast.error('Failed to create backup');
        }
        setCreating(false);
    }

    async function handleRestore(ts: number) {
        if (!activeCampaignId) return;
        const backup = backups.find(b => b.timestamp === ts);
        const lbl = backup ? new Date(backup.timestamp).toLocaleString() : String(ts);
        if (!window.confirm(`Restore from "${lbl}"?\n\nYour current state will be saved as a backup first.`)) return;

        setRestoringTs(ts);
        const ok = await api.backup.restore(activeCampaignId, ts);
        if (ok) {
            toast.success('Restored from backup');
        } else {
            toast.error('Restore failed');
        }
        setRestoringTs(null);
    }

    async function handleDelete(ts: number) {
        if (!activeCampaignId) return;
        if (!window.confirm('Delete this backup permanently?')) return;
        await api.backup.delete(activeCampaignId, ts);
        toast.success('Backup deleted');
        await loadBackups();
    }

    function triggerBadge(trigger: string) {
        const colors: Record<string, string> = {
            manual: 'bg-terminal/10 text-terminal',
            auto: 'bg-terminal/10 text-terminal-dim',
            'pre-clear': 'bg-amber-500/10 text-amber-500',
            'pre-rollback': 'bg-amber-500/10 text-amber-500',
            'pre-delete-npc': 'bg-amber-500/10 text-amber-500',
            'pre-clear-archive': 'bg-amber-500/10 text-amber-500',
            'pre-delete-campaign': 'bg-amber-500/10 text-amber-500',
            'pre-restore': 'bg-terminal/10 text-terminal-dim',
        };
        const color = colors[trigger] || 'bg-void-lighter text-text-dim';
        return (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${color}`}>
                {trigger}
            </span>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={toggleBackupModal}>
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-lg max-h-[85vh] flex flex-col mx-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase">Campaign Backups</h2>
                    <button onClick={toggleBackupModal} className="touch-btn text-text-dim hover:text-text-primary transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <div className="p-3 border-b border-border flex gap-2">
                    <input
                        type="text"
                        placeholder="Backup label..."
                        className="flex-1 bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:outline-none focus:border-terminal"
                        value={label}
                        onChange={e => setLabel(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleCreateManual(); }}
                    />
                    <button
                        onClick={handleCreateManual}
                        disabled={creating}
                        className="touch-btn flex items-center gap-1 px-3 py-2 bg-terminal/20 text-terminal rounded hover:bg-terminal/30 transition-colors text-xs font-semibold disabled:opacity-50"
                    >
                        {creating ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                        Create
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-text-dim">
                            <Loader2 size={20} className="animate-spin mr-2" />
                            Loading...
                        </div>
                    ) : backups.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-text-dim">
                            <Clock size={32} className="mb-3 opacity-30" />
                            <p className="text-sm">No backups yet</p>
                            <p className="text-xs opacity-60 mt-1">Create your first backup above</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {backups.map((b) => (
                                <div
                                    key={b.timestamp}
                                    className="flex items-center gap-3 p-3 rounded hover:bg-void-lighter transition-colors"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                            <span className="text-xs text-text-dim font-mono">
                                                {new Date(b.timestamp).toLocaleString()}
                                            </span>
                                            {triggerBadge(b.trigger)}
                                            {b.isAuto && (
                                                <span className="text-[10px] text-blue-400/60">auto</span>
                                            )}
                                        </div>
                                        {b.label && (
                                            <p className="text-xs text-text truncate">{b.label}</p>
                                        )}
                                        <p className="text-[10px] text-text-dim/60">
                                            {b.fileCount} files · {b.campaignName}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => handleRestore(b.timestamp)}
                                            disabled={restoringTs === b.timestamp}
                                            className="touch-btn flex items-center gap-1 px-2 py-1 text-xs rounded bg-terminal/20 text-terminal hover:bg-terminal/30 transition-colors disabled:opacity-50"
                                        >
                                            {restoringTs === b.timestamp ? (
                                                <Loader2 size={12} className="animate-spin" />
                                            ) : (
                                                <RotateCcw size={12} />
                                            )}
                                            Restore
                                        </button>
                                        <button
                                            onClick={() => handleDelete(b.timestamp)}
                                            className="touch-btn p-1 text-text-dim hover:text-danger transition-colors"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {backups.length > 0 && (
                    <div className="px-4 py-2 border-t border-border text-[10px] text-text-dim/60">
                        {backups.filter(b => b.isAuto).length} auto · {backups.filter(b => !b.isAuto).length} manual
                    </div>
                )}
            </div>
        </div>
    );
}