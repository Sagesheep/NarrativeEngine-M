import { MessageSquare, Layers, Users, Settings } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

const TABS = [
  { id: 'chat' as const,    icon: MessageSquare, label: 'Chat' },
  { id: 'context' as const, icon: Layers,        label: 'Context' },
  { id: 'npcs' as const,    icon: Users,         label: 'NPCs' },
  { id: 'settings' as const,icon: Settings,      label: 'Settings' },
];

export function MobileNavBar() {
  const mobileView = useAppStore((s) => s.mobileView);
  const setMobileView = useAppStore((s) => s.setMobileView);
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);
  const drawerOpen = useAppStore((s) => s.drawerOpen);

  const handleTap = (tabId: typeof TABS[number]['id']) => {
    if (tabId === 'chat') {
      // Close any open panels and return to chat
      if (drawerOpen) toggleDrawer();
      useAppStore.setState({ settingsOpen: false, npcLedgerOpen: false });
      setMobileView('chat');
    } else if (tabId === 'context') {
      // Toggle bottom sheet
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

  return (
    <nav className="mobile-nav md:hidden">
      {TABS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          className={`mobile-nav-item ${mobileView === id ? 'active' : ''}`}
          onClick={() => handleTap(id)}
          aria-label={label}
        >
          <Icon size={24} strokeWidth={2.5} />
          <span className="text-[10px] font-black uppercase tracking-widest mt-1">{label}</span>
        </button>
      ))}
    </nav>
  );
}
