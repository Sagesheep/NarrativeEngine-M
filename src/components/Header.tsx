import { useEffect, useState } from 'react';
import { Settings, Trash2, LogOut, Users, Save, Archive, ScanSearch, BookCheck, Pin, Replace } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { AiTier } from '../types';

const TIER_CYCLE: Record<AiTier, AiTier> = { lite: 'pro', pro: 'max', max: 'lite' };
const TIER_NEXT_LABEL: Record<AiTier, string> = { lite: 'Switch to Pro', pro: 'Switch to Max', max: 'Switch to Lite' };
import { TokenGauge } from './TokenGauge';
import { saveCampaignState, saveDivergenceRegister } from '../store/campaignStore';
import { api } from '../services/apiClient';
import { toast } from './Toast';

type SelectionSnapshot = {
    messageId: string;
    text: string;
    start: number;
    end: number;
    bubbleText: string;
};

export function Header() {
    const toggleSettings = useAppStore(s => s.toggleSettings);
    const toggleNPCLedger = useAppStore(s => s.toggleNPCLedger);
    const toggleBackupModal = useAppStore(s => s.toggleBackupModal);
    const clearChat = useAppStore(s => s.clearChat);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const setActiveCampaign = useAppStore(s => s.setActiveCampaign);
    const context = useAppStore(s => s.context);
    const messages = useAppStore(s => s.messages);
    const condenser = useAppStore(s => s.condenser);
    const deepArmed = useAppStore(s => s.deepArmed);
    const toggleDeepArmed = useAppStore(s => s.toggleDeepArmed);
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);
    const openLoreCheck = useAppStore(s => s.openLoreCheck);
    const addPinnedExcerpt = useAppStore(s => s.addPinnedExcerpt);
    const openRenameModal = useAppStore(s => s.openRenameModal);

    const [loreSel, setLoreSel] = useState<SelectionSnapshot | null>(null);
    const [pinSel, setPinSel] = useState<SelectionSnapshot | null>(null);
    const [renameSel, setRenameSel] = useState<SelectionSnapshot | null>(null);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    const [clearConfirmText, setClearConfirmText] = useState('');

    const captureFromBubble = (selector: string): SelectionSnapshot | null => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = (node.nodeType === 1 ? node as Element : node.parentElement);
        const bubble = el?.closest(selector) as HTMLElement | null;
        if (!bubble) return null;
        const messageId = bubble.dataset.messageId;
        const text = sel.toString().trim();
        if (!messageId || text.length < 1) return null;
        const bubbleText = bubble.textContent ?? '';
        const start = bubbleText.indexOf(text);
        if (start === -1) return null;
        return { messageId, text, start, end: start + text.length, bubbleText };
    };

    useEffect(() => {
        const handle = () => {
            const lore = captureFromBubble('[data-lore-checkable="true"]');
            setLoreSel(lore);
            const pin = captureFromBubble('[data-message-id]');
            setPinSel(pin);
            setRenameSel(pin);
        };
        document.addEventListener('selectionchange', handle);
        return () => document.removeEventListener('selectionchange', handle);
    }, []);

    const handleLoreCheck = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? loreSel;
        if (!snap) return;
        const before = snap.bubbleText.slice(Math.max(0, snap.start - 200), snap.start);
        const after = snap.bubbleText.slice(snap.end, Math.min(snap.bubbleText.length, snap.end + 200));
        openLoreCheck({
            messageId: snap.messageId,
            selectedText: snap.text,
            start: snap.start,
            end: snap.end,
            surroundingContext: `${before}[[HIGHLIGHTED]]${snap.text}[[/HIGHLIGHTED]]${after}`,
        });
        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
        setPinSel(null);
    };

    const handlePinSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? pinSel;
        if (!snap) return;
        const result = addPinnedExcerpt(snap.messageId, snap.text, false);
        if (result.ok) {
            window.getSelection()?.removeAllRanges();
            setPinSel(null);
            setLoreSel(null);
        } else {
            toast.warning(result.reason);
        }
    };

    const handleRenameSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? renameSel;
        if (!snap) return;
        openRenameModal(snap.text);
        window.getSelection()?.removeAllRanges();
        setRenameSel(null);
        setPinSel(null);
        setLoreSel(null);
    };

    const handleClearChat = async () => {
        if (clearConfirmText.toLowerCase() === 'delete') {
            if (activeCampaignId) {
                await api.backup.create(activeCampaignId, { trigger: 'pre-clear', isAuto: true }).catch(() => {});
            }
            clearChat();
            setShowClearConfirm(false);
            setClearConfirmText('');
        }
    };

    const handleExit = async () => {
        if (activeCampaignId) {
            await saveCampaignState(activeCampaignId, { context, messages, condenser });
            const divReg = useAppStore.getState().divergenceRegister;
            await saveDivergenceRegister(activeCampaignId, divReg);
        }
        setActiveCampaign(null);
    };

    return (
        <header className="bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 shrink-0 safe-top min-h-9 md:min-h-10 py-0">
            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <button
                onClick={() => { setShowClearConfirm(true); setClearConfirmText(''); }}
                className="text-text-dim hover:text-danger transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0"
                title="Clear chat history"
                aria-label="Clear chat history"
            >
                <Trash2 size={16} />
            </button>

            <button
                onClick={() => { if (activeCampaignId) api.backup.create(activeCampaignId, { trigger: 'manual', isAuto: false }); }}
                className="hidden md:inline-flex text-text-dim hover:text-terminal transition-colors p-1 touch-btn"
                title="Create Backup"
                aria-label="Create Backup"
            >
                <Save size={16} />
            </button>

            <button
                onClick={toggleBackupModal}
                className="hidden md:inline-flex text-text-dim hover:text-terminal transition-colors p-1 touch-btn"
                title="Manage Backups"
                aria-label="Manage Backups"
            >
                <Archive size={16} />
            </button>

            <button
                onClick={toggleNPCLedger}
                className="hidden md:inline-flex text-text-dim hover:text-terminal transition-colors p-1"
                title="NPC Ledger"
                aria-label="Open NPC Ledger"
            >
                <Users size={18} />
            </button>

            <button
                onClick={toggleSettings}
                className="hidden md:inline-flex text-text-dim hover:text-terminal transition-colors p-1"
                title="Settings"
                aria-label="Open settings"
            >
                <Settings size={18} />
            </button>

            {settings.enableDeepArchiveSearch && (
                <button
                    onClick={toggleDeepArmed}
                    className={`transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0 ${
                        deepArmed
                            ? 'text-amber-400 animate-pulse'
                            : 'text-text-dim hover:text-terminal'
                    }`}
                    title={deepArmed ? 'Deep Search armed — send to activate' : 'Arm Deep Archive Search'}
                    aria-label="Toggle Deep Archive Search"
                >
                    <ScanSearch size={16} />
                </button>
            )}

            <button
                onMouseDown={handlePinSelection}
                onTouchStart={handlePinSelection}
                className={`transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0 ml-1 ${
                    pinSel
                        ? 'text-terminal animate-pulse'
                        : 'text-text-dim hover:text-terminal'
                }`}
                title="Pin selected text as memory"
                aria-label="Pin selection"
            >
                <Pin size={16} />
            </button>

            <button
                onMouseDown={handleLoreCheck}
                onTouchStart={handleLoreCheck}
                className={`transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0 ml-1 ${
                    loreSel
                        ? 'text-terminal animate-pulse'
                        : 'text-text-dim hover:text-terminal'
                }`}
                title="Lore Check selection (highlight text in a GM message first)"
                aria-label="Lore Check selection"
            >
                <BookCheck size={16} />
            </button>

            <button
                onMouseDown={handleRenameSelection}
                onTouchStart={handleRenameSelection}
                className={`transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0 ml-1 ${
                    renameSel
                        ? 'text-terminal animate-pulse'
                        : 'text-text-dim hover:text-terminal'
                }`}
                title="Rename selected name everywhere (highlight a name first)"
                aria-label="Rename selection"
            >
                <Replace size={16} />
            </button>

            <button
                onClick={() => {
                    const current = settings.aiTier ?? 'pro';
                    updateSettings({ aiTier: TIER_CYCLE[current] });
                }}
                className="hidden md:inline-flex text-text-dim hover:text-terminal transition-colors p-1 ml-1 text-[10px] font-bold font-mono uppercase tracking-widest"
                title={TIER_NEXT_LABEL[settings.aiTier ?? 'pro']}
                aria-label={`AI tier: ${settings.aiTier ?? 'pro'}. ${TIER_NEXT_LABEL[settings.aiTier ?? 'pro']}`}
            >
                {(settings.aiTier ?? 'pro').toUpperCase()}
            </button>

            <button
                onClick={handleExit}
                className="text-text-dim hover:text-ember transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0 ml-1"
                title="Exit campaign"
                aria-label="Exit campaign"
            >
                <LogOut size={16} />
            </button>
            {showClearConfirm && (
                <div className="fixed inset-0 bg-ember/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setShowClearConfirm(false)}>
                    <div className="bg-surface border border-danger rounded-lg p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
                        <p className="text-text-primary text-sm mb-2 font-bold">Clear all chat history?</p>
                        <p className="text-text-dim text-xs mb-4">This will permanently delete all messages, pinned excerpts, and stored images. A backup will be created automatically.</p>
                        <label className="block text-text-dim text-xs mb-1">Type <span className="text-danger font-bold">delete</span> to confirm:</label>
                        <input
                            value={clearConfirmText}
                            onChange={(e) => setClearConfirmText(e.target.value)}
                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary mb-4 focus:outline-none focus:border-danger"
                            autoFocus
                        />
                        <div className="flex gap-3 justify-end">
                            <button onClick={() => setShowClearConfirm(false)} className="px-4 py-2 text-xs text-text-dim hover:text-text-primary border border-border rounded transition-colors">
                                Cancel
                            </button>
                            <button
                                onClick={handleClearChat}
                                disabled={clearConfirmText.toLowerCase() !== 'delete'}
                                className="px-4 py-2 text-xs text-void bg-danger rounded transition-colors font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
                            >
                                Clear Chat
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </header>
    );
}

