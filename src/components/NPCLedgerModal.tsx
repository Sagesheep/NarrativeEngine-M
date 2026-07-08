import { useState, useRef } from 'react';
import { X, Plus, LayoutGrid, List, ArrowLeft, Sparkles, Images } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { updateExistingNPCs } from '../services/chatEngine';
import { api } from '../services/apiClient';
import { runNPCReview, addNpcFromSelection, type NPCReviewCandidate, type NPCReviewCancelled } from '../services/npc';

import type { NPCEntry } from '../types';
import { toast } from './Toast';

import { NPCListView } from './npc-ledger/NPCListView';
import { NPCGalleryView } from './npc-ledger/NPCGalleryView';
import { NPCEditForm } from './npc-ledger/NPCEditForm';
import { NPCSuggestionsPanel } from './npc-ledger/NPCSuggestionsPanel';
import { NPCReviewModal, type NPCReviewAction } from './NPCReviewModal';
import { uid } from '../utils/uid';
import { useBackHandler } from '../hooks/useBackHandler';
import { getEntriesForNpc } from '../services/campaign-state';
import { imageStorage } from '../services/storage/imageStorage';
import { generateNPCPortrait } from '../services/image/portrait';

export function NPCLedgerModal() {
  const npcLedger = useAppStore(s => s.npcLedger);
  const npcLedgerOpen = useAppStore(s => s.npcLedgerOpen);
  const toggleNPCLedger = useAppStore(s => s.toggleNPCLedger);
  const addNPC = useAppStore(s => s.addNPC);
  const updateNPC = useAppStore(s => s.updateNPC);
  const removeNPC = useAppStore(s => s.removeNPC);
  const setNPCLedger = useAppStore(s => s.setNPCLedger);
  const setMobileView = useAppStore(s => s.setMobileView);
  const activeCampaignId = useAppStore(s => s.activeCampaignId);
  const divergenceRegister = useAppStore(s => s.divergenceRegister);
  const npcSuggestions = useAppStore(s => s.npcSuggestions);
  const dismissNpcSuggestion = useAppStore(s => s.dismissNpcSuggestion);
  const clearNpcSuggestions = useAppStore(s => s.clearNpcSuggestions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');
  const [isAIUpdating, setIsAIUpdating] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [populating, setPopulating] = useState<{ done: number; total: number } | null>(null);

  // ── AI NPC review (flags likely non-characters; user decides per entry) ──
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRunning, setReviewRunning] = useState(false);
  const [reviewProgress, setReviewProgress] = useState<{ msg: string; done: number; total: number } | null>(null);
  const [reviewCandidates, setReviewCandidates] = useState<NPCReviewCandidate[] | null>(null);
  const [reviewFailedBatches, setReviewFailedBatches] = useState(0);
  const [reviewActions, setReviewActions] = useState<Record<string, NPCReviewAction>>({});
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewCancelRef = useRef<NPCReviewCancelled>({ cancelled: false });

  const [form, setForm] = useState<Partial<NPCEntry>>({
    status: 'Alive', voice: '', personality: '', exampleOutput: '',
  });

  // Hardware back: close the whole ledger. Registered first (bottom of the stack).
  useBackHandler(npcLedgerOpen, () => {
    toggleNPCLedger();
    setMobileView('chat');
  });
  // When a detail/edit sub-view is open, back returns to the list first.
  // Registered second → sits above the ledger handler, so it fires first (LIFO).
  useBackHandler(npcLedgerOpen && (selectedId !== null || isEditing), () => {
    setSelectedId(null);
    setIsEditing(false);
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
      status: 'Alive', goals: '', voice: '', personality: '', exampleOutput: '',
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



  // Promote a suggestion: same resolve→create/update pass as the toolbar button.
  // Returns true if it landed (so the panel can clear it).
  const acceptSuggestion = async (name: string): Promise<boolean> => {
    const state = useAppStore.getState();
    if (!state.activeCampaignId) { toast.warning('No active campaign.'); return false; }
    const result = await addNpcFromSelection({
      rawText: name,
      ledger: state.npcLedger ?? [],
      messages: state.messages,
      campaignId: state.activeCampaignId,
      storyProvider: state.getActiveStoryEndpoint() ?? state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint(),
      updateProvider: state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint(),
      addNPC: state.addNPC,
      updateNPC: state.updateNPC,
      matureMode: state.settings?.matureMode ?? false,
    });
    if (result.ok) { dismissNpcSuggestion(name); return true; }
    if (result.kind === 'ambiguous') toast.warning(result.message);
    else toast.error(result.message);
    return false;
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

  // Generate portraits for every NPC that has no image yet. Skips NPCs without
  // an appearance description (generation requires one) and runs sequentially so
  // we don't slam the image endpoint with parallel requests.
  const handlePopulateImages = async () => {
    const state = useAppStore.getState();
    if (!state.getActiveImageEndpoint()) {
      toast.warning('No Image Generation AI configured. Add one in Settings → Presets.');
      return;
    }
    const targets = npcLedger.filter(n => !n.portrait && n.appearance?.trim());
    const skipped = npcLedger.filter(n => !n.portrait && !n.appearance?.trim()).length;
    if (targets.length === 0) {
      toast.warning(skipped > 0 ? `No portraits generated — ${skipped} NPC(s) need an appearance description first.` : 'All NPCs already have a portrait.');
      return;
    }

    setPopulating({ done: 0, total: targets.length });
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      try {
        await generateNPCPortrait(targets[i].id);
        ok++;
      } catch {
        failed++;
      }
      setPopulating({ done: i + 1, total: targets.length });
    }
    setPopulating(null);

    const parts = [`generated ${ok}`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} skipped (no appearance)`);
    if (failed) toast.warning(`Portraits: ${parts.join(', ')}`);
    else toast.success(`Portraits: ${parts.join(', ')}`);
  };

  const handleBulkDelete = async () => {
    if (checkedIds.size === 0) return;
    if (!confirm(`Delete ${checkedIds.size} selected NPCs?`)) return;
    if (activeCampaignId) {
      await api.backup.create(activeCampaignId, { trigger: 'pre-npc-bulk-delete', isAuto: true }).catch(() => {});
    }
    const remaining = npcLedger.filter(n => !checkedIds.has(n.id));
    setNPCLedger(remaining);
    if (activeCampaignId) {
      for (const id of checkedIds) {
        imageStorage.deletePortrait(activeCampaignId, id).catch(() => {});
      }
    }
    setCheckedIds(new Set());
    setSelectMode(false);
    toast.success(`Deleted ${checkedIds.size} NPCs`);
  };

  const handleStartReview = () => {
    const state = useAppStore.getState();
    const provider = state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint();
    if (!provider) {
      setReviewError('No AI endpoint configured.');
      setReviewOpen(true);
      return;
    }
    setReviewOpen(true);
    setReviewRunning(true);
    setReviewProgress(null);
    setReviewCandidates(null);
    setReviewFailedBatches(0);
    setReviewActions({});
    setReviewError(null);
    reviewCancelRef.current = { cancelled: false };

    runNPCReview(npcLedger, provider, reviewCancelRef.current, (msg, done, total) => {
      setReviewProgress({ msg, done, total });
    }).then(result => {
      setReviewCandidates(result.candidates);
      setReviewFailedBatches(result.failedBatches);
      // Default every flagged entry to "archive" — the safe, reversible action.
      const defaults: Record<string, NPCReviewAction> = {};
      for (const c of result.candidates) defaults[c.id] = 'archive';
      setReviewActions(defaults);
      setReviewRunning(false);
      setReviewProgress(null);
    }).catch(err => {
      if (err?.message === 'NPC review cancelled.') {
        setReviewOpen(false);
        setReviewRunning(false);
        setReviewProgress(null);
      } else {
        setReviewError(err?.message || String(err));
        setReviewRunning(false);
        setReviewProgress(null);
      }
    });
  };

  const handleStopReview = () => {
    reviewCancelRef.current.cancelled = true;
    setReviewOpen(false);
    setReviewRunning(false);
    setReviewProgress(null);
  };

  const handleCloseReview = () => {
    if (reviewRunning) return;
    setReviewOpen(false);
    setReviewCandidates(null);
    setReviewActions({});
    setReviewError(null);
  };

  const handleApplyReview = async () => {
    const cands = reviewCandidates ?? [];
    const archiveIds = cands.filter(c => reviewActions[c.id] === 'archive').map(c => c.id);
    const deleteIds = cands.filter(c => reviewActions[c.id] === 'delete').map(c => c.id);

    if (deleteIds.length > 0 && activeCampaignId) {
      await api.backup.create(activeCampaignId, { trigger: 'pre-npc-review-delete', isAuto: true }).catch(() => {});
    }

    for (const id of archiveIds) removeNPC(id);
    for (const id of deleteIds) removeNPC(id);

    if (selectedId && (archiveIds.includes(selectedId) || deleteIds.includes(selectedId))) {
      setSelectedId(null);
      setIsEditing(false);
    }

    const removedCount = archiveIds.length + deleteIds.length;
    const parts: string[] = [];
    if (removedCount) parts.push(`removed ${removedCount}`);
    if (parts.length) toast.success(`NPC review: ${parts.join(', ')}`);

    setReviewOpen(false);
    setReviewCandidates(null);
    setReviewActions({});
    setReviewError(null);
  };

  const byName = (a: NPCEntry, b: NPCEntry) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base', numeric: true });
  const activeNPCList = npcLedger.slice().sort(byName);
  const missingPortraitCount = npcLedger.filter(n => !n.portrait).length;

  const showDetail = !!selectedId || (isEditing && !selectedId);

  return (
    <div className={`mobile-page md:fixed md:inset-0 md:z-[100] md:flex md:items-center md:justify-center ${npcLedgerOpen ? 'open' : ''}`}>
      {/* Desktop Backdrop */}
      <div className="hidden md:absolute md:inset-0 md:bg-void/80 md:backdrop-blur-sm" onClick={handleClose} />

      <div className="relative bg-surface w-full h-full md:max-w-6xl md:h-[calc(85*var(--app-vh))] md:border md:border-border md:shadow-2xl flex flex-col md:flex-row overflow-hidden">

        {/* Navigation / List Side */}
        <div className={`flex flex-col min-h-0 w-full h-full border-r border-border bg-void-lighter transition-transform duration-300 ${showDetail ? 'hidden md:flex md:w-80' : 'flex'}`}>
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
              <button onClick={() => { setSelectMode(!selectMode); setCheckedIds(new Set()); }} className={`flex-1 border rounded text-[10px] uppercase tracking-wider ${selectMode ? 'border-terminal text-terminal' : 'border-border text-text-dim'}`}>
                {selectMode ? 'Cancel' : 'Select'}
              </button>
              <button
                onClick={handleStartReview}
                disabled={reviewRunning || activeNPCList.length === 0}
                className="flex-1 flex items-center justify-center gap-1.5 border border-amber-500/30 rounded text-[10px] uppercase tracking-wider text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Sparkles size={12} />
                Review ({activeNPCList.length})
              </button>
            </div>

            {missingPortraitCount > 0 && (
              <button
                onClick={handlePopulateImages}
                disabled={!!populating}
                className="w-full h-10 flex items-center justify-center gap-1.5 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal hover:bg-terminal/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Images size={12} />
                {populating
                  ? `Generating ${populating.done}/${populating.total}…`
                  : `Populate Images (${missingPortraitCount})`}
              </button>
            )}

            <NPCSuggestionsPanel
              suggestions={npcSuggestions}
              onAccept={acceptSuggestion}
              onDismiss={dismissNpcSuggestion}
              onClearAll={clearNpcSuggestions}
            />
            {selectMode && (
              <div className="flex gap-1.5 h-10">
                <button onClick={() => setCheckedIds(new Set(activeNPCList.map(n => n.id)))} className="flex-1 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim">
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

          <div className="flex-1 min-h-0 overflow-y-auto npc-ledger-scroll">
            {viewMode === 'list'
              ? <NPCListView npcLedger={activeNPCList} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={(id) => setCheckedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onDelete={handleDelete} />
              : <NPCGalleryView npcLedger={activeNPCList} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={(id) => setCheckedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onDelete={handleDelete} />
            }
          </div>
        </div>

        {/* Detail Side */}
        <div className={`flex-1 min-h-0 flex flex-col bg-surface transition-transform duration-300 ${!showDetail ? 'hidden md:flex' : 'flex'}`}>
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
            divergenceEntries={selectedId ? getEntriesForNpc(divergenceRegister, selectedId) : undefined}
          />
        </div>
      </div>

      <NPCReviewModal
        open={reviewOpen}
        running={reviewRunning}
        progress={reviewProgress}
        candidates={reviewCandidates}
        failedBatches={reviewFailedBatches}
        actions={reviewActions}
        error={reviewError}
        onCancel={handleCloseReview}
        onStop={handleStopReview}
        onSetAction={(id, action) => setReviewActions(prev => ({ ...prev, [id]: action }))}
        onApply={handleApplyReview}
      />
    </div>
  );
}
