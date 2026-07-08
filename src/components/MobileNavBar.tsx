import { useAppStore } from '../store/useAppStore';
import { hapticLight } from '../utils/haptics';

const TABS = [
  { id: 'chat' as const,    label: 'Chat' },
  { id: 'context' as const, label: 'Context' },
  { id: 'npcs' as const,    label: 'NPCs' },
  { id: 'settings' as const,label: 'Settings' },
];

export function MobileNavBar() {
  const mobileView = useAppStore((s) => s.mobileView);
  const setMobileView = useAppStore((s) => s.setMobileView);
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);
  const drawerOpen = useAppStore((s) => s.drawerOpen);
  const npcLedger = useAppStore((s) => s.npcLedger);
  const npcPressure = useAppStore((s) => s.npcPressure);
  const debugMode = useAppStore((s) => s.settings.debugMode);
  const keyboardVisible = useAppStore((s) => s.keyboardVisible);

  const pressureCount = debugMode
    ? npcLedger.filter(n => n.drives || npcPressure[n.id]).length
    : 0;

  const handleTap = (tabId: typeof TABS[number]['id']) => {
    hapticLight();
    if (tabId === 'chat') {
      if (drawerOpen) toggleDrawer();
      useAppStore.setState({ settingsOpen: false, npcLedgerOpen: false });
      setMobileView('chat');
    } else if (tabId === 'context') {
      if (mobileView === 'context' && drawerOpen) {
        toggleDrawer();
        setMobileView('chat');
      } else {
        if (!drawerOpen) toggleDrawer();
        useAppStore.setState({ settingsOpen: false, npcLedgerOpen: false });
        setMobileView('context');
      }
    } else if (tabId === 'npcs') {
      useAppStore.setState({ npcLedgerOpen: true, settingsOpen: false });
      if (drawerOpen) toggleDrawer();
      setMobileView('npcs');
    } else if (tabId === 'settings') {
      useAppStore.setState({ settingsOpen: true, npcLedgerOpen: false });
      if (drawerOpen) toggleDrawer();
      setMobileView('settings');
    }
  };

  // While the soft keyboard is up, hide the nav so it doesn't ride on top of it
  // and the chat input can sit directly against the keyboard.
  if (keyboardVisible) return null;

  return (
    <nav className="mobile-nav md:hidden">
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          className={`mobile-nav-item ${mobileView === id ? 'active' : ''}`}
          onClick={() => handleTap(id)}
          aria-label={label}
        >
          <span className="text-[10px] font-black uppercase tracking-widest">{label}</span>
          {id === 'context' && pressureCount > 0 && (
            <span className="absolute -top-0.5 -right-1 min-w-[14px] h-3.5 bg-terminal text-void text-[8px] font-bold rounded-full flex items-center justify-center px-0.5">
              {pressureCount}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}