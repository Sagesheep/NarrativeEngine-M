import { Settings, PanelLeftOpen, PanelLeftClose, Trash2, LogOut, Users, Save, Archive } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { saveCampaignState } from '../store/campaignStore';
import { api } from '../services/apiClient';

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
    } = useAppStore();

    const handleClearChat = async () => {
        if (activeCampaignId) {
            await api.backup.create(activeCampaignId, { trigger: 'pre-clear', isAuto: true }).catch(() => {});
        }
        clearChat();
    };

    const handleExit = async () => {
        // Save current state before exiting
        if (activeCampaignId) {
            await saveCampaignState(activeCampaignId, { context, messages, condenser });
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

