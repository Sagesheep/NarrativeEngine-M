import './index.css';
import { useEffect, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import { CampaignHub } from './components/CampaignHub';
import { Header } from './components/Header';
import { ContextDrawer } from './components/ContextDrawer';
import { ChatArea } from './components/ChatArea';
import { SettingsModal } from './components/SettingsModal';
import { NPCLedgerModal } from './components/NPCLedgerModal';
import { BackupModal } from './components/BackupModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer } from './components/Toast';
import { MobileNavBar } from './components/MobileNavBar';
import {
  loadCampaignState, getLoreChunks, getNPCLedger, loadArchiveIndex,
  loadChapters, loadSemanticFacts,
} from './store/campaignStore';

const DEFAULT_CONDENSER = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };

export default function App() {
  const activeCampaignId = useAppStore((s) => s.activeCampaignId);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const loadSettings = useAppStore((s) => s.loadSettings);

  // True once campaign state has been hydrated into Zustand (or there's no campaign to hydrate)
  const [campaignLoaded, setCampaignLoaded] = useState(false);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (settingsLoaded) {
      const scale = useAppStore.getState().settings.uiScale ?? 1;
      const html = document.documentElement;
      html.style.setProperty('--ui-scale', String(scale));
      
      const root = document.getElementById('root');
      if (root) {
        // Clear old transform hacks permanently
        root.style.width = '';
        root.style.height = '';
        root.style.transform = '';
        root.style.transformOrigin = '';
        root.style.zoom = '';
      }
      // Apply clean global zoom at the highest DOM level
      html.style.zoom = scale !== 1 ? String(scale) : '';
    }
  }, [settingsLoaded]);

  // After settings load, if we already have an activeCampaignId (restored from a previous
  // session), we MUST load the campaign's data before rendering ChatArea.
  // Without this guard, the empty Zustand defaults would race against any auto-save
  // and silently overwrite the real saved data into the DB.
  useEffect(() => {
    if (!settingsLoaded) return;

    if (!activeCampaignId) {
      // No campaign active — hub will be shown, nothing to hydrate
      setCampaignLoaded(true);
      return;
    }

    let cancelled = false;
    setCampaignLoaded(false);

    (async () => {
      const [state, chunks, npcs, archiveIndex] = await Promise.all([
        loadCampaignState(activeCampaignId),
        getLoreChunks(activeCampaignId),
        getNPCLedger(activeCampaignId),
        loadArchiveIndex(activeCampaignId),
      ]);
      if (cancelled) return;

      const [chapters, facts] = await Promise.all([
        loadChapters(activeCampaignId).catch(() => []),
        loadSemanticFacts(activeCampaignId).catch(() => []),
      ]);
      if (cancelled) return;

      useAppStore.setState({
        context: state?.context ?? useAppStore.getState().context,
        messages: state?.messages ?? [],
        condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER), isCondensing: false },
        loreChunks: chunks,
        npcLedger: npcs,
        archiveIndex,
        chapters,
        semanticFacts: facts,
      });
      setCampaignLoaded(true);
    })();

    return () => { cancelled = true; };
    // Only re-run when the session first loads (settingsLoaded flips to true).
    // We don't re-run on activeCampaignId changes because CampaignHub.handleSelectCampaign
    // already handles hydration when the user picks a campaign manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  if (!settingsLoaded || !campaignLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        <div className="text-lg animate-pulse">Loading…</div>
      </div>
    );
  }

  if (!activeCampaignId) {
    return (
      <ErrorBoundary>
        <CampaignHub />
        <SettingsModal />
        <BackupModal />
        <ToastContainer />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <ContextDrawer />
        <ChatArea />
      </div>
      <MobileNavBar />
      <SettingsModal />
      <NPCLedgerModal />
      <BackupModal />
      <ToastContainer />
    </ErrorBoundary>
  );
}
