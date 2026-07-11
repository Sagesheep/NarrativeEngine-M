import './index.css';
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { Keyboard } from '@capacitor/keyboard';
import { useAppStore } from './store/useAppStore';
import { popBackHandler } from './services/backHandler';
import { CampaignHub } from './components/CampaignHub';
import { Header } from './components/Header';
import { ContextDrawer } from './components/ContextDrawer';
import { ChatArea } from './components/ChatArea';
import { SettingsModal } from './components/SettingsModal';
import { LoreCheckModal } from './components/chat/LoreCheckModal';
import { LootRollModal } from './components/chat/LootRollModal';
import { DiceRollModal } from './components/chat/DiceRollModal';
import { NPCLedgerModal } from './components/NPCLedgerModal';
import { BackupModal } from './components/BackupModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer, toast } from './components/Toast';
import { setNotifyImpl } from './services/ports/notify';
import { setStoreAccess } from './services/ports/store';
import { ConfirmSheet } from './components/ConfirmSheet';
import { MobileNavBar } from './components/MobileNavBar';
import { useRulesIndexer } from './hooks/useRulesIndexer';
import { useLoreIndexer } from './hooks/useLoreIndexer';
import { initVoices } from './services/tts/speech';
import {
    loadCampaignState, getLoreChunks, getNPCLedger, loadArchiveIndex,
  loadChapters, loadSemanticFacts, loadDivergenceRegister,
} from './store/campaignStore';
import { reconcilePendingCommitOnLaunch } from './services/turn';

const DEFAULT_CONDENSER = { condensedUpToIndex: -1 };

export default function App() {
  const activeCampaignId = useAppStore((s) => s.activeCampaignId);
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const keyboardVisible = useAppStore((s) => s.keyboardVisible);

  // True once campaign state has been hydrated into Zustand (or there's no campaign to hydrate)
  const [campaignLoaded, setCampaignLoaded] = useState(false);

  useEffect(() => {
    loadSettings();
    initVoices();
  }, [loadSettings]);

  // Wire the notification port (composition root). UI → services/ports is the
  // allowed direction; services/ and store/ never import components/Toast.
  useEffect(() => {
    setNotifyImpl({
      success: toast.success,
      error:   toast.error,
      warning: toast.warning,
      info:    toast.info,
    });
    setStoreAccess({
      getState: useAppStore.getState,
      setState: useAppStore.setState,
    });
  }, []);

  // Hardware back button (Android): dismiss the top-most open overlay; else
  // fall back from a non-chat tab to chat; else background the app. Never exit.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handle = CapApp.addListener('backButton', () => {
      if (popBackHandler()) return;
      const s = useAppStore.getState();
      if (s.mobileView !== 'chat') {
        if (s.drawerOpen) s.toggleDrawer();
        useAppStore.setState({ settingsOpen: false, npcLedgerOpen: false });
        s.setMobileView('chat');
        return;
      }
      void CapApp.minimizeApp();
    });
    return () => { void handle.then((h) => h.remove()); };
  }, []);

  // Track the soft keyboard so the chat can hide the bottom nav bar and let the
  // input sit directly on the keyboard instead of floating above a dead nav row.
  // Capture the keyboard height from the OS event (device-agnostic, no hardcode)
  // so ChatInput can be lifted above it only while the keyboard is visible.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const setKeyboardVisible = useAppStore.getState().setKeyboardVisible;
    const setKeyboardHeight = useAppStore.getState().setKeyboardHeight;
    const showP = Keyboard.addListener('keyboardWillShow', (info) => {
      setKeyboardHeight(info.keyboardHeight);
      setKeyboardVisible(true);
    });
    const hideP = Keyboard.addListener('keyboardWillHide', () => {
      setKeyboardVisible(false);
      setKeyboardHeight(0);
    });
    return () => {
      void showP.then((h) => h.remove());
      void hideP.then((h) => h.remove());
    };
  }, []);

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
      const [state, chunks, npcs, archiveIndex, divReg] = await Promise.all([
        loadCampaignState(activeCampaignId),
        getLoreChunks(activeCampaignId),
        getNPCLedger(activeCampaignId),
        loadArchiveIndex(activeCampaignId),
        loadDivergenceRegister(activeCampaignId),
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
        condenser: state?.condenser ?? DEFAULT_CONDENSER,
        pinnedExcerpts: state?.pinnedExcerpts ?? [],
        loreChunks: chunks,
        npcLedger: npcs,
        archiveIndex,
        chapters,
        semanticFacts: facts,
        divergenceRegister: divReg ?? { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 as const },
      });
      setCampaignLoaded(true);

      // Swipe Generation v1: crash-safety reconciliation. If the app died
      // mid-browse with a pendingCommit marker, fire the deferred handlePostTurn
      // with the then-visible variant's text, then clear the marker. WebView
      // renderer death is a known real-world event; without this the chat and
      // archive silently diverge. Runs after state hydration so the store is
      // ready. Fire-and-forget — the user shouldn't wait on a toast.
      reconcilePendingCommitOnLaunch().catch(e => console.warn('[Reconcile] failed:', e));
    })();

    return () => { cancelled = true; };
    // Only re-run when the session first loads (settingsLoaded flips to true).
    // We don't re-run on activeCampaignId changes because CampaignHub.handleSelectCampaign
    // already handles hydration when the user picks a campaign manually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  if (!settingsLoaded || !campaignLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-void text-text-dim">
        <div className="text-lg animate-pulse">Loading…</div>
      </div>
    );
  }

  if (!activeCampaignId) {
    return (
      <ErrorBoundary>
        <CampaignHub />
        <SettingsModal />
        <LoreCheckModal />
        <BackupModal />
        <ToastContainer />
        <ConfirmSheet />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Header />
      <div className={`flex flex-1 overflow-hidden ${keyboardVisible ? '' : 'nav-clearance'}`}>
        <ContextDrawer />
        <ChatArea />
      </div>
      <MobileNavBar />
      <RulesIndexerWrapper />
      <SettingsModal />
      <LoreCheckModal />
      <LootRollModal />
      <DiceRollModal />
      <NPCLedgerModal />
      <BackupModal />
      <ToastContainer />
      <ConfirmSheet />
    </ErrorBoundary>
  );
}

function RulesIndexerWrapper() {
  useRulesIndexer();
  useLoreIndexer();
  return null;
}
