import { ScrollText, Globe, Zap, BookOpen, Bookmark, Brain, Sliders, Images, NotebookPen, type LucideIcon } from 'lucide-react';
import type { ContextTabId } from '../../types';

export const CONTEXT_TABS: readonly { id: ContextTabId; label: string; icon: LucideIcon }[] = [
  { id: 'sys',       label: 'System',    icon: ScrollText },
  { id: 'rules-mgr', label: 'RuleMgr',   icon: Sliders },
  { id: 'world',     label: 'World',     icon: Globe },
  { id: 'mem',       label: 'Knowledge', icon: Brain },
  { id: 'eng',       label: 'Engines',   icon: Zap },
  { id: 'gallery',   label: 'Gallery',   icon: Images },
  { id: 'chapters',  label: 'Chapters',  icon: BookOpen },
  { id: 'chr',       label: 'Bookkeep',  icon: Bookmark },
  { id: 'notes',     label: 'Notes',     icon: NotebookPen },
];
