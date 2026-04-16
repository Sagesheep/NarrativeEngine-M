import { useState, useRef } from 'react';
import { X, Plus, LayoutGrid, List, ArrowLeft } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { updateExistingNPCs } from '../services/chatEngine';
import { parseNPCsFromLore } from '../services/loreNPCParser';
import { dedupeNPCLedger } from '../store/slices/campaignSlice';
import { api } from '../services/apiClient';

import type { NPCEntry } from '../types';
import { toast } from './Toast';

import { NPCListView } from './npc-ledger/NPCListView';
import { NPCGalleryView } from './npc-ledger/NPCGalleryView';
import { NPCEditForm } from './npc-ledger/NPCEditForm';
import { uid } from '../utils/uid';

export function NPCLedgerModal() {
  const { npcLedger, npcLedgerOpen, toggleNPCLedger, addNPC, updateNPC, removeNPC, setNPCLedger, setMobileView, activeCampaignId } = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');
  const [isAIUpdating, setIsAIUpdating] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  const importRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<Partial<NPCEntry>>({
    status: 'Alive', nature: 5, training: 1, emotion: 5, social: 5, belief: 5, ego: 5,
  });

  if (!npcLedgerOpen) return null;

  const handleClose = () => {
    toggleNPCLedger();
    setMobileView('chat');
  };

  const handleSelect = (npc: NPCEntry) => {
    setSelectedId(npc.id);
    setForm({ ...npc });
    setIsEditing(false);
  };

  const handleBackToList = () => {
    setSelectedId(null);
    setIsEditing(false);
  };

  const handleCreateNew = () => {
    setSelectedId(null);
    setForm({
      name: '', aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '',
      status: 'Alive', goals: '', nature: 5, training: 1, emotion: 5, social: 5, belief: 5, ego: 5,
    });
    setIsEditing(true);
  };

  const handleSave = () => {
    if (!form.name?.trim()) return;
    if (selectedId) {
      updateNPC(selectedId, form);
    } else {
      const newId = uid();
      addNPC({ ...form, id: newId } as NPCEntry);
      setSelectedId(newId);
    }
    setIsEditing(false);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Delete this NPC from the ledger?')) {
      removeNPC(id);
      if (selectedId === id) { setSelectedId(null); setIsEditing(false); }
    }
  };



  const handleExport = () => {
    const exportData = npcLedger.map(({ ...rest }) => rest);
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `npc_ledger_export_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a).click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleAIUpdate = async () => {
    if (!selectedId) return;
    const state = useAppStore.getState();
    const provider = state.getActiveStoryEndpoint();
    if (!provider) return;
    setIsAIUpdating(true);
    try {
      const npc = npcLedger.find(n => n.id === selectedId);
      if (npc) await updateExistingNPCs(provider, state.messages, [npc], (id, patch) => {
        updateNPC(id, patch);
        setForm(prev => ({ ...prev, ...patch }));
      });
    } finally { setIsAIUpdating(false); }
  };

  const handleSeedFromLore = async () => {
    const chunks = useAppStore.getState().loreChunks;
    const loreNPCs = parseNPCsFromLore(chunks);
    if (loreNPCs.length > 0) {
      const merged = dedupeNPCLedger([...npcLedger, ...loreNPCs]);
      setNPCLedger(merged);
      toast.success(`Seeded ${loreNPCs.length} NPCs from lore`);
    } else {
      toast.info('No NPCs found in lore chunks');
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (Array.isArray(data)) {
          const imported = data.map((d: any) => ({
            id: d.id || uid(),
            name: d.name || '',
            aliases: d.aliases || '',
            appearance: d.appearance || '',
            faction: d.faction || '',
            storyRelevance: d.storyRelevance || '',
            disposition: d.disposition || '',
            status: d.status || 'Alive',
            goals: d.goals || '',
            nature: d.nature ?? 5,
            training: d.training ?? 1,
            emotion: d.emotion ?? 5,
            social: d.social ?? 5,
            belief: d.belief ?? 5,
            ego: d.ego ?? 5,
            affinity: d.affinity ?? 50,
          } as NPCEntry));
          const merged = dedupeNPCLedger([...npcLedger, ...imported]);
          setNPCLedger(merged);
          toast.success(`Imported ${imported.length} NPCs`);
        }
      } catch {
        toast.error('Invalid JSON file');
      }
    };
    reader.readAsText(file);
  };

  const handleBulkDelete = async () => {
    if (checkedIds.size === 0) return;
    if (!confirm(`Delete ${checkedIds.size} selected NPCs?`)) return;
    if (activeCampaignId) {
      await api.backup.create(activeCampaignId, { trigger: 'pre-npc-bulk-delete', isAuto: true }).catch(() => {});
    }
    const remaining = npcLedger.filter(n => !checkedIds.has(n.id));
    setNPCLedger(remaining);
    setCheckedIds(new Set());
    setSelectMode(false);
    toast.success(`Deleted ${checkedIds.size} NPCs`);
  };

  const showDetail = !!selectedId || (isEditing && !selectedId);

  return (
    <div className={`mobile-page md:fixed md:inset-0 md:z-[100] md:flex md:items-center md:justify-center ${npcLedgerOpen ? 'open' : ''}`}>
      {/* Desktop Backdrop */}
      <div className="hidden md:absolute md:inset-0 md:bg-void/80 md:backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-surface w-full h-full md:max-w-6xl md:h-[85vh] md:border md:border-border md:shadow-2xl flex flex-col md:flex-row overflow-hidden">
        <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />

        {/* Navigation / List Side */}
        <div className={`flex flex-col w-full h-full border-r border-border bg-void-lighter transition-transform duration-300 ${showDetail ? 'hidden md:flex md:w-80' : 'flex'}`}>
          <div className="mobile-page-header safe-top px-4 py-3 border-b border-border bg-void">
            <button onClick={handleClose} className="back-btn -ml-2">
              <ArrowLeft size={24} />
            </button>
            <span className="page-title">NPC Ledger</span>
            <button onClick={handleCreateNew} className="touch-btn text-terminal ml-auto">
              <Plus size={24} />
            </button>
          </div>

          {/* List Toolbar */}
          <div className="p-3 border-b border-border bg-void-lighter space-y-2">
            <div className="flex bg-surface border border-border rounded overflow-hidden h-10">
              <button onClick={() => setViewMode('list')} className={`flex-1 flex items-center justify-center gap-2 text-xs uppercase ${viewMode === 'list' ? 'bg-terminal text-void' : 'text-text-dim'}`}>
                <List size={14} /> List
              </button>
              <button onClick={() => setViewMode('gallery')} className={`flex-1 flex items-center justify-center gap-2 text-xs uppercase border-l border-border ${viewMode === 'gallery' ? 'bg-terminal text-void' : 'text-text-dim'}`}>
                <LayoutGrid size={14} /> Gallery
              </button>
            </div>
            <div className="flex gap-1.5 h-10">
              <button onClick={() => importRef.current?.click()} className="flex-1 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim">
                Import
              </button>
              <button onClick={handleExport} className="flex-1 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim">
                Export
              </button>
              <button onClick={handleSeedFromLore} className="flex-1 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim">
                Seed
              </button>
              <button onClick={() => { setSelectMode(!selectMode); setCheckedIds(new Set()); }} className={`flex-1 border rounded text-[10px] uppercase tracking-wider ${selectMode ? 'border-terminal text-terminal' : 'border-border text-text-dim'}`}>
                {selectMode ? 'Cancel' : 'Select'}
              </button>
            </div>
            {selectMode && (
              <div className="flex gap-1.5 h-10">
                <button onClick={() => setCheckedIds(new Set(npcLedger.map(n => n.id)))} className="flex-1 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim">
                  All
                </button>
                <button onClick={() => setCheckedIds(new Set())} className="flex-1 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim">
                  None
                </button>
                <button onClick={handleBulkDelete} disabled={checkedIds.size === 0} className="flex-1 border border-red-500/30 rounded text-[10px] uppercase tracking-wider text-red-500 disabled:opacity-30">
                  Delete ({checkedIds.size})
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {viewMode === 'list'
              ? <NPCListView npcLedger={npcLedger} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={(id) => setCheckedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; })} onDelete={handleDelete} />
              : <NPCGalleryView npcLedger={npcLedger} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={(id) => setCheckedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; })} onDelete={handleDelete} />
            }
          </div>
        </div>

        {/* Detail Side */}
        <div className={`flex-1 flex flex-col bg-surface transition-transform duration-300 ${!showDetail ? 'hidden md:flex' : 'flex'}`}>
          {/* Detail Header (Mobile) */}
          <div className="mobile-page-header md:hidden px-4 py-3 border-b border-border bg-void">
            <button onClick={handleBackToList} className="back-btn -ml-2">
              <ArrowLeft size={24} />
            </button>
            <span className="page-title">{isEditing && !selectedId ? 'New NPC' : 'NPC Details'}</span>
          </div>

          {/* Detail Header (Desktop) */}
          <div className="hidden md:flex items-center justify-between p-4 border-b border-border bg-void">
            <span className="text-terminal text-[10px] font-bold uppercase tracking-widest">NPC Detail</span>
            <button onClick={handleClose} className="text-text-dim hover:text-danger"><X size={18} /></button>
          </div>

          <NPCEditForm
            form={form}
            setForm={setForm}
            selectedId={selectedId}
            isEditing={isEditing}
            isAIUpdating={isAIUpdating}
            onEdit={() => setIsEditing(true)}
            onSave={handleSave}
            onCancel={() => setIsEditing(false)}
            onDelete={handleDelete}
            onAIUpdate={handleAIUpdate}
          />
        </div>
      </div>
    </div>
  );
}
