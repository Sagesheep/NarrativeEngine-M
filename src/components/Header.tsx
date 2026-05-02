import { useEffect, useState } from 'react';
import { Settings, PanelLeftOpen, PanelLeftClose, Trash2, LogOut, Users, Save, Archive, ScanSearch, BookCheck } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { saveCampaignState, saveDivergenceRegister } from '../store/campaignStore';
import { api } from '../services/apiClient';

type LoreSelectionSnapshot = {
    messageId: string;
    text: string;
    start: number;
    end: number;
    bubbleText: string;
};

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        toggleBackupModal,
        drawerOpen,
        clearChat,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
        deepArmed,
        toggleDeepArmed,
        settings,
        openLoreCheck,
    } = useAppStore();

    const [loreSel, setLoreSel] = useState<LoreSelectionSnapshot | null>(null);

    useEffect(() => {
        const handle = () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
                setLoreSel(null);
                return;
            }
            const range = sel.getRangeAt(0);
            const node = range.commonAncestorContainer;
            const el = (node.nodeType === 1 ? node as Element : node.parentElement);
            const bubble = el?.closest('[data-lore-checkable="true"]') as HTMLElement | null;
            if (!bubble) {
                setLoreSel(null);
                return;
            }
            const messageId = bubble.dataset.messageId;
            const text = sel.toString().trim();
            if (!messageId || text.length < 3) {
                setLoreSel(null);
                return;
            }
            const bubbleText = bubble.textContent ?? '';
            const start = bubbleText.indexOf(text);
            if (start === -1) {
                setLoreSel(null);
                return;
            }
            setLoreSel({ messageId, text, start, end: start + text.length, bubbleText });
        };
        document.addEventListener('selectionchange', handle);
        return () => document.removeEventListener('selectionchange', handle);
    }, []);

    const handleLoreCheck = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        if (!loreSel) return;
        const before = loreSel.bubbleText.slice(Math.max(0, loreSel.start - 200), loreSel.start);
        const after = loreSel.bubbleText.slice(loreSel.end, Math.min(loreSel.bubbleText.length, loreSel.end + 200));
        openLoreCheck({
            messageId: loreSel.messageId,
            selectedText: loreSel.text,
            start: loreSel.start,
            end: loreSel.end,
            surroundingContext: `${before}[[HIGHLIGHTED]]${loreSel.text}[[/HIGHLIGHTED]]${after}`,
        });
        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
    };

    const handleClearChat = async () => {
        if (activeCampaignId) {
            await api.backup.create(activeCampaignId, { trigger: 'pre-clear', isAuto: true }).catch(() => {});
        }
        clearChat();
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
            <button
                onClick={toggleDrawer}
                className="text-text-dim hover:text-terminal transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0"
                title={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
                aria-label={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
            >
                {drawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>

            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <button
                onClick={handleClearChat}
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
                onMouseDown={handleLoreCheck}
                onTouchStart={handleLoreCheck}
                disabled={!loreSel}
                className={`transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0 ml-1 ${
                    loreSel
                        ? 'text-terminal animate-pulse'
                        : 'text-text-dim/40 cursor-not-allowed'
                }`}
                title={loreSel ? 'Lore Check selection' : 'Highlight text in a GM message first'}
                aria-label="Lore Check selection"
            >
                <BookCheck size={16} />
            </button>

            <button
                onClick={handleExit}
                className="text-text-dim hover:text-ember transition-colors p-1 touch-btn md:p-1 md:min-h-0 md:min-w-0 ml-1"
                title="Exit campaign"
                aria-label="Exit campaign"
            >
                <LogOut size={16} />
            </button>
        </header>
    );
}

