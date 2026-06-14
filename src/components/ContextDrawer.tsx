import { useState, useRef, useCallback } from 'react';
import { X, ScrollText, Globe, Zap, BookOpen, Bookmark, Brain, Sliders, Library, Images } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { RulesTab } from './context-drawer/RulesTab';
import { RulesManagerTab } from './context-drawer/RulesManagerTab';
import { LoreTab } from './context-drawer/LoreTab';
import { EnginesTab } from './context-drawer/EnginesTab';
import { ChapterTab } from './context-drawer/ChapterTab';
import { BookkeepingTab } from './context-drawer/BookkeepingTab';
import { ResolvedStatePanel } from './context-drawer/ResolvedStatePanel';
import { MemoryTab } from './context-drawer/MemoryTab';
import { CompendiumTab } from './context-drawer/CompendiumTab';
import { GalleryTab } from './context-drawer/GalleryTab';

const TABS = [
  { id: 'sys',      label: 'System',   icon: ScrollText },
  { id: 'rules-mgr', label: 'RuleMgr', icon: Sliders },
  { id: 'world',    label: 'World',    icon: Globe },
  { id: 'mem',      label: 'Memory',   icon: Brain },
  { id: 'eng',      label: 'Engines',  icon: Zap },
  { id: 'comp',     label: 'Compendium', icon: Library },
  { id: 'gallery',  label: 'Gallery',  icon: Images },
  { id: 'chapters', label: 'Chapters', icon: BookOpen },
  { id: 'chr',      label: 'Bookkeep', icon: Bookmark },
] as const;

type TabId = typeof TABS[number]['id'];

export function ContextDrawer() {
  const drawerOpen = useAppStore((s) => s.drawerOpen);
  const toggleDrawer = useAppStore((s) => s.toggleDrawer);
  const setMobileView = useAppStore((s) => s.setMobileView);
  const [activeTab, setActiveTab] = useState<TabId>('sys');

  const combatModeActive = useAppStore((s) => s.context.combatModeActive ?? false);
  const activeCampaignId = useAppStore((s) => s.activeCampaignId);

  // Compendium is combat-only; if it's active when combat mode turns off, fall back to sys
  if (activeTab === 'comp' && (!activeCampaignId || !combatModeActive)) {
    setActiveTab('sys');
  }

  const visibleTabs = TABS.filter(tab => {
    if (tab.id === 'comp') {
      return !!activeCampaignId && combatModeActive;
    }
    return true;
  });

  // ── Swipe-to-dismiss logic ──
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentY = useRef(0);
  const dragging = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
    currentY.current = startY.current;
    dragging.current = true;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragging.current || !sheetRef.current) return;
    currentY.current = e.touches[0].clientY;
    const diff = currentY.current - startY.current;
    if (diff > 0) {
      sheetRef.current.style.transform = `translateY(${diff}px)`;
      sheetRef.current.style.transition = 'none';
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!dragging.current || !sheetRef.current) return;
    dragging.current = false;
    const diff = currentY.current - startY.current;
    sheetRef.current.style.transition = '';
    sheetRef.current.style.transform = '';
    if (diff > 100) {
      toggleDrawer();
      setMobileView('chat');
    }
  }, [toggleDrawer, setMobileView]);

  const handleClose = () => {
    toggleDrawer();
    setMobileView('chat');
  };

  const tabContent = (
    <>
      {activeTab === 'sys' && <RulesTab onOpenManager={() => setActiveTab('rules-mgr')} />}
      {activeTab === 'rules-mgr' && <RulesManagerTab onBack={() => setActiveTab('sys')} />}
      {activeTab === 'world' && <LoreTab />}
      {activeTab === 'mem' && <MemoryTab />}
      {activeTab === 'eng' && <EnginesTab />}
      {activeTab === 'comp' && <CompendiumTab />}
      {activeTab === 'gallery' && <GalleryTab />}
      {activeTab === 'chapters' && <ChapterTab />}
      {activeTab === 'chr' && <><ResolvedStatePanel /><BookkeepingTab /></>}
    </>
  );

  const tabBar = (
    <div className="flex border-b border-border overflow-x-auto flex-shrink-0">
      {visibleTabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => setActiveTab(id)}
          className={`flex items-center gap-1.5 px-4 py-3 min-h-[48px] text-xs md:text-[10px] uppercase tracking-wider whitespace-nowrap transition-colors flex-shrink-0
            ${activeTab === id
              ? 'text-terminal border-b-2 border-terminal bg-terminal/5'
              : 'text-text-dim hover:text-text-primary'
            }`}
        >
          <Icon size={14} />
          <span className="md:hidden">{label}</span>
          <span className="hidden md:inline">{id.toUpperCase()}</span>
        </button>
      ))}
    </div>
  );

  // ── Desktop: static sidebar ──
  const desktopDrawer = (
    <div className="hidden md:flex md:flex-col md:w-80 border-r border-border bg-void-lighter overflow-hidden flex-shrink-0">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="text-terminal text-[10px] font-bold uppercase tracking-widest">◆ Context Bank</span>
      </div>
      {tabBar}
      <div className="flex-1 overflow-y-auto">
        {tabContent}
      </div>
    </div>
  );

  // ── Mobile: bottom sheet ──
  const mobileSheet = (
    <>
      {/* Backdrop */}
      <div
        className={`bottom-sheet-backdrop md:hidden ${drawerOpen ? 'open' : ''}`}
        onClick={handleClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className={`bottom-sheet md:hidden ${drawerOpen ? 'open' : ''}`}
      >
        {/* Drag handle */}
        <div
          className="bottom-sheet-handle"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        />

        {/* Sheet header */}
        <div className="flex items-center justify-between px-4 py-2 flex-shrink-0">
          <span className="text-terminal text-xs font-bold uppercase tracking-widest">◆ Context Bank</span>
          <button onClick={handleClose} className="touch-btn text-text-dim">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        {tabBar}

        {/* Content */}
        <div className="bottom-sheet-content">
          {tabContent}
        </div>
      </div>
    </>
  );

  return (
    <>
      {desktopDrawer}
      {mobileSheet}
    </>
  );
}
