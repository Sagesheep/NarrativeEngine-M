import { useState } from 'react';
import { X, ArrowLeft } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useBackHandler } from '../hooks/useBackHandler';
import { ProvidersPanel } from './settings/ProvidersPanel';
import { PresetsPanel } from './settings/PresetsPanel';
import { GlobalSettingsPanel } from './settings/GlobalSettingsPanel';
import { AdvancedEmbeddingPanel } from './settings/AdvancedEmbeddingPanel';
import { DebugPanel } from './settings/DebugPanel';

type PanelKey = 'providers' | 'presets' | 'global' | 'advanced' | 'debug';

const PANELS: { key: PanelKey; label: string }[] = [
    { key: 'providers', label: 'Providers' },
    { key: 'presets', label: 'Presets' },
    { key: 'global', label: 'Global' },
    { key: 'advanced', label: 'Advanced' },
    { key: 'debug', label: 'Debug' },
];

export function SettingsModal() {
    const [activePanel, setActivePanel] = useState<PanelKey>('providers');
    const settingsOpen = useAppStore(s => s.settingsOpen);
    const toggleSettings = useAppStore(s => s.toggleSettings);
    const setMobileView = useAppStore(s => s.setMobileView);

    const handleClose = () => {
        toggleSettings();
        setMobileView('chat');
    };
    useBackHandler(settingsOpen, handleClose);

    if (!settingsOpen) return null;

    return (
        <div className={`mobile-page md:fixed md:inset-0 md:z-[100] md:flex md:items-center md:justify-center ${settingsOpen ? 'open' : ''}`} role="dialog" aria-modal="true" aria-label="Settings">
            <div className="hidden md:absolute md:inset-0 md:bg-ember/40 md:backdrop-blur-sm" onClick={handleClose} />

            <div className="relative bg-surface border-border w-full h-full md:h-[calc(85*var(--app-vh))] md:max-w-xl md:mx-4 md:border md:shadow-2xl flex flex-col overflow-hidden">
                <div className="mobile-page-header safe-top md:hidden px-4 py-3 border-b border-border bg-void">
                    <button onClick={handleClose} className="back-btn -ml-2">
                        <ArrowLeft size={24} />
                    </button>
                    <span className="page-title">Settings</span>
                </div>

                <div className="hidden md:flex items-center justify-between p-6 border-b border-border shrink-0 bg-void z-10">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase glow-green">
                        ⚙ SETTINGS
                    </h2>
                    <button onClick={handleClose} className="text-text-dim hover:text-danger">
                        <X size={18} />
                    </button>
                </div>

                <div className="flex border-b border-border shrink-0 bg-void">
                    {PANELS.map(({ key, label }) => (
                        <button
                            key={key}
                            onClick={() => setActivePanel(key)}
                            className={`flex-1 px-3 py-3 md:py-2 text-xs md:text-[11px] uppercase tracking-wider transition-all border-b-2 -mb-px ${
                                activePanel === key
                                    ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                                    : 'text-text-dim border-transparent hover:text-text-primary'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                <div className="flex-1 overflow-y-auto p-4 md:p-6 nav-clearance md:pb-6 relative">
                    <div className={activePanel !== 'providers' ? 'hidden' : ''}><ProvidersPanel /></div>
                    <div className={activePanel !== 'presets' ? 'hidden' : ''}><PresetsPanel /></div>
                    <div className={activePanel !== 'global' ? 'hidden' : ''}><GlobalSettingsPanel /></div>
                    <div className={activePanel !== 'advanced' ? 'hidden' : ''}><AdvancedEmbeddingPanel /></div>
                    <div className={activePanel !== 'debug' ? 'hidden' : ''}><DebugPanel /></div>
                </div>
            </div>
        </div>
    );
}