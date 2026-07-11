import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Trash2, Play, Clock, BookOpen, Pencil, Settings, Download, Upload, Loader2, Package } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
    listCampaigns, deleteCampaign, loadCampaignState,
    saveCampaign, saveCampaignState, saveLoreChunks,
    getNPCLedger, saveNPCLedger, getLoreChunks,
} from '../store/campaignStore';
import { chunkLoreFile, extractEngineSeeds, parseNPCsFromLore, loadLootTree } from '../services/lore';
import { defaultContext } from '../store/slices/campaignSlice';
import { dedupeNPCLedger } from '../store/slices/npcSlice';
import { api } from '../services/apiClient';
import { downloadBundle, importBundle, readFileChunked } from '../services/campaignBundle';
import { useBackHandler } from '../hooks/useBackHandler';
import { toast } from './Toast';
import type { Campaign } from '../types';

const DEFAULT_CONDENSER = { condensedUpToIndex: -1 };

export function CampaignHub() {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const importInputRef = useRef<HTMLInputElement>(null);

    // Modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);

    // Form state
    const [name, setName] = useState('');
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const [coverPreview, setCoverPreview] = useState('');
    const [loreFile, setLoreFile] = useState<File | null>(null);
    const [loreName, setLoreName] = useState('');
    const [rulesFile, setRulesFile] = useState<File | null>(null);
    const [rulesName, setRulesName] = useState('');
    const [lootFile, setLootFile] = useState<File | null>(null);
    const [lootName, setLootName] = useState('');

    const refresh = useCallback(async () => {
        const list = await listCampaigns();
        setCampaigns(list);
    }, []);

    useEffect(() => {
        let mounted = true;
        listCampaigns().then(list => { if (mounted) setCampaigns(list); });
        return () => { mounted = false; };
    }, []);

    const resetForm = () => {
        setName('');
        setCoverFile(null);
        setCoverPreview('');
        setLoreFile(null);
        setLoreName('');
        setRulesFile(null);
        setRulesName('');
        setLootFile(null);
        setLootName('');
        setEditingCampaign(null);
    };

    // Hardware back dismisses whichever hub overlay is open.
    useBackHandler(modalOpen, () => { setModalOpen(false); resetForm(); });
    useBackHandler(confirmDelete !== null, () => setConfirmDelete(null));

    const openCreate = () => {
        resetForm();
        setModalOpen(true);
    };

    const openEdit = (campaign: Campaign) => {
        setEditingCampaign(campaign);
        setName(campaign.name);
        setCoverPreview(campaign.coverImage || '');
        setLoreName('');
        setRulesName('');
        setLoreFile(null);
        setRulesFile(null);
        setLootFile(null);
        setLootName('');
        setCoverFile(null);
        setModalOpen(true);
    };

    const handleCoverChange = (file: File) => {
        setCoverFile(file);
        const reader = new FileReader();
        reader.onload = (e) => setCoverPreview(e.target?.result as string);
        reader.readAsDataURL(file);
    };

    const handleSave = async () => {
        if (!name.trim()) return;

        const isEdit = !!editingCampaign;
        const campaign: Campaign = isEdit
            ? { ...editingCampaign, name: name.trim(), lastPlayedAt: Date.now() }
            : {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                name: name.trim(),
                coverImage: '',
                createdAt: Date.now(),
                lastPlayedAt: Date.now(),
            };

        if (coverFile) {
            campaign.coverImage = coverPreview;
        } else if (isEdit) {
            campaign.coverImage = coverPreview;
        }

        await saveCampaign(campaign);

        if (loreFile) {
            const loreText = await loreFile.text();
            const newChunks = chunkLoreFile(loreText);
            const existingChunks = await getLoreChunks(campaign.id);
            const preservedModes = new Map(
                existingChunks
                    .filter(c => c.modesUserEdited)
                    .map(c => [c.id, { activationModes: c.activationModes, modesUserEdited: true as const }])
            );
            const chunks = newChunks.map(c => {
                const p = preservedModes.get(c.id);
                return p ? { ...c, ...p } : c;
            });
            await saveLoreChunks(campaign.id, chunks);

            // Non-blocking LLM keyword enrichment — fire and forget
            const utilityEndpointForEnrichment = useAppStore.getState().getActiveUtilityEndpoint();
            if (utilityEndpointForEnrichment?.endpoint) {
                import('../services/lore').then(({ enrichLoreKeywords }) => {
                    enrichLoreKeywords(campaign.id, chunks, utilityEndpointForEnrichment, saveLoreChunks)
                        .catch(err => console.warn('[LoreEnricher] Background enrichment failed:', err));
                }).catch(() => {});
            }

            const seeds = extractEngineSeeds(chunks);
            if (seeds) {
                const existingState = await loadCampaignState(campaign.id);
                const ctx = { ...defaultContext, ...(existingState?.context ?? {}) };
                await saveCampaignState(campaign.id, {
                    context: {
                        ...ctx,
                        surpriseConfig: {
                            initialDC: ctx.surpriseConfig?.initialDC ?? 95,
                            dcReduction: ctx.surpriseConfig?.dcReduction ?? 3,
                            types: seeds.surpriseTypes.length > 0 ? seeds.surpriseTypes : (ctx.surpriseConfig?.types ?? []),
                            tones: seeds.surpriseTones.length > 0 ? seeds.surpriseTones : (ctx.surpriseConfig?.tones ?? []),
                        },
                        encounterConfig: {
                            initialDC: ctx.encounterConfig?.initialDC ?? 198,
                            dcReduction: ctx.encounterConfig?.dcReduction ?? 2,
                            types: seeds.encounterTypes.length > 0 ? seeds.encounterTypes : (ctx.encounterConfig?.types ?? []),
                            tones: seeds.encounterTones.length > 0 ? seeds.encounterTones : (ctx.encounterConfig?.tones ?? []),
                        },
                        worldEventConfig: {
                            initialDC: ctx.worldEventConfig?.initialDC ?? 498,
                            dcReduction: ctx.worldEventConfig?.dcReduction ?? 2,
                            who: seeds.worldWho.length > 0 ? seeds.worldWho : (ctx.worldEventConfig?.who ?? []),
                            where: seeds.worldWhere.length > 0 ? seeds.worldWhere : (ctx.worldEventConfig?.where ?? []),
                            why: seeds.worldWhy.length > 0 ? seeds.worldWhy : (ctx.worldEventConfig?.why ?? []),
                            what: seeds.worldWhat.length > 0 ? seeds.worldWhat : (ctx.worldEventConfig?.what ?? []),
                        },
                        npcIntroConfig: {
                            initialDC: ctx.npcIntroConfig?.initialDC ?? 196,
                            dcReduction: ctx.npcIntroConfig?.dcReduction ?? 2,
                            characters: seeds.characterIntros.length > 0 ? seeds.characterIntros : (ctx.npcIntroConfig?.characters ?? []),
                        },
                    },
                    messages: existingState?.messages ?? [],
                    condenser: existingState?.condenser ?? DEFAULT_CONDENSER,
                });
            }

            const loreNPCs = parseNPCsFromLore(chunks);
            if (loreNPCs.length > 0) {
                const existingNpcs = await getNPCLedger(campaign.id);
                const merged = dedupeNPCLedger([...existingNpcs, ...loreNPCs]);
                await saveNPCLedger(campaign.id, merged);
            }
        }

        // Only write campaign state when a new rules file is actually provided.
        // Never fall back to defaultContext — that would silently erase real data
        // if the modal opens before IndexedDB has finished loading.
        if (rulesFile) {
            const rulesRaw = await rulesFile.text();
            const existingState = await loadCampaignState(campaign.id);
            const ctx = { ...defaultContext, ...(existingState?.context ?? {}) };
            await saveCampaignState(campaign.id, {
                context: { ...ctx, rulesRaw },
                messages: existingState?.messages ?? [],
                condenser: existingState?.condenser ?? DEFAULT_CONDENSER,
            });
        }

        // Loot Engine WO-03: load + validate the optional loot.json into ctx.lootTree.
        // loadLootTree returns null (never throws) on bad input — the campaign
        // simply has no loot table, so the manual trigger no-ops (WO-05).
        if (lootFile) {
            try {
                const lootRaw = JSON.parse(await lootFile.text());
                const lootTree = loadLootTree(lootRaw);
                const existingState = await loadCampaignState(campaign.id);
                const ctx = { ...defaultContext, ...(existingState?.context ?? {}) };
                await saveCampaignState(campaign.id, {
                    context: { ...ctx, ...(lootTree ? { lootTree } : {}) },
                    messages: existingState?.messages ?? [],
                    condenser: existingState?.condenser ?? DEFAULT_CONDENSER,
                });
                if (lootTree) toast.success('Loot table loaded — the Loot button is armed.');
                else toast.warning('loot.json was invalid — no loot table loaded (see console).');
            } catch (err) {
                console.warn('[CampaignHub] loot.json parse failed:', err);
                toast.warning('loot.json could not be parsed — no loot table loaded.');
            }
        }

        setModalOpen(false);
        resetForm();
        refresh();

        // 🟢 FIX: Actually execute "Enter" if we just created a new campaign
        if (!isEdit) {
            handleSelectCampaign(campaign);
        }
    };

    const handleSelectCampaign = async (campaign: Campaign) => {
        const updatedCampaign = { ...campaign, lastPlayedAt: Date.now() };
        await saveCampaign(updatedCampaign);
        await useAppStore.getState().setActiveCampaign(campaign.id);
    };

    const handleExport = async (campaignId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setIsExporting(campaignId);
        try {
            const includeDebug = useAppStore.getState().settings.debugMode === true;
            await downloadBundle(campaignId, includeDebug);
            toast.success('Campaign saved to Downloads folder');
        } catch (err) {
            if (err instanceof Error && err.message === 'Cancelled') return;
            const msg = err instanceof Error ? err.message : String(err);
            console.error('[export] handler error:', err);
            toast.error(msg.startsWith('Export failed') ? msg : `Export failed: ${msg}`);
        } finally {
            setIsExporting(null);
        }
    };

    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        setIsImporting(true);
        try {
            const bundle = JSON.parse(await readFileChunked(file));
            await importBundle(bundle);
            await refresh();
            toast.success(`"${bundle.campaign?.name ?? 'Campaign'}" imported — rebuilding search index in background`);
        } catch {
            toast.error('Import failed — invalid campaign file');
        } finally {
            setIsImporting(false);
        }
    };

    const handleDelete = async (id: string) => {
        await api.backup.create(id, { trigger: 'pre-delete', isAuto: true }).catch(() => {});
        await deleteCampaign(id);
        setConfirmDelete(null);
        refresh();
    };

    const timeAgo = (ts: number | undefined) => {
        if (!ts) return 'Never played';
        const now = new Date().getTime();
        const diff = now - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        return `${days}d ago`;
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-void p-4 md:p-8 relative">
            <input ref={importInputRef} type="file" accept=".campaign, .json, application/json, application/octet-stream, */*" className="hidden" onChange={handleImportFile} />

            {/* Settings button */}
            <button
                onClick={() => useAppStore.getState().toggleSettings()}
                className="absolute safe-top-abs right-4 sm:right-8 p-3 text-text-dim hover:text-terminal transition-colors bg-surface border border-border rounded-full hover:border-terminal z-50"
                title="Global Settings"
            >
                <Settings size={20} />
            </button>

            {/* Import button */}
            <button
                onClick={() => importInputRef.current?.click()}
                disabled={isImporting}
                className="absolute safe-top-abs left-4 sm:left-8 p-3 text-text-dim hover:text-terminal transition-colors bg-surface border border-border rounded-full hover:border-terminal z-50 disabled:opacity-40"
                title="Import Campaign"
            >
                {isImporting ? <Loader2 size={20} className="animate-spin" /> : <Upload size={20} />}
            </button>

            {/* Title */}
            <h1 className="text-terminal text-lg sm:text-2xl font-bold tracking-[0.2em] sm:tracking-[0.4em] uppercase glow-green mb-2">
                Narrative Engine
            </h1>
            <p className="text-text-dim text-xs tracking-widest uppercase mb-6 sm:mb-10">
                SELECT CAMPAIGN
            </p>

            {/* Campaign Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-4xl w-full mb-8">
                {campaigns.filter(c => c && c.id && c.name && c.id !== 'undefined').map((c) => (
                    <div
                        key={c.id}
                        className="group relative bg-surface border border-border rounded-lg overflow-hidden hover:border-terminal transition-all duration-300 cursor-pointer"
                        onClick={() => handleSelectCampaign(c)}
                    >
                        {/* Cover Image */}
                        <div className="h-36 bg-void-lighter flex items-center justify-center overflow-hidden">
                            {c.coverImage ? (
                                <img src={c.coverImage} alt={c.name} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                            ) : (
                                <BookOpen size={32} className="text-text-dim group-hover:text-terminal transition-colors" />
                            )}
                        </div>

                        {/* Info */}
                        <div className="p-4">
                            <h2 className="text-text-primary font-bold text-sm uppercase tracking-wider group-hover:text-terminal transition-colors">
                                {c.name}
                            </h2>
                            <div className="flex items-center gap-1 mt-2 text-text-dim text-xs">
                                <Clock size={10} />
                                <span>{timeAgo(c.lastPlayedAt)}</span>
                            </div>
                        </div>

                        {/* Play overlay */}
                        <div className="absolute inset-0 bg-terminal/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                            <Play size={40} className="text-terminal glow-green opacity-0 group-hover:opacity-80 transition-opacity" />
                        </div>

                        {/* Edit button */}
                        <button
                            onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                            className="absolute top-2 left-2 p-2 rounded bg-void/90 text-text-dim hover:text-terminal touch-btn md:p-1.5 md:min-h-0 md:min-w-0 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                            title="Edit campaign"
                        >
                            <Pencil size={16} />
                        </button>

                        {/* Delete button */}
                        <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(c.id); }}
                            className="absolute top-2 right-2 p-2 rounded bg-void/90 text-text-dim hover:text-danger touch-btn md:p-1.5 md:min-h-0 md:min-w-0 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                            title="Delete campaign"
                        >
                            <Trash2 size={16} />
                        </button>

                        {/* Export button */}
                        <button
                            onClick={(e) => handleExport(c.id, e)}
                            disabled={isExporting === c.id}
                            className="absolute bottom-2 left-2 p-2 rounded bg-void/90 text-text-dim hover:text-terminal touch-btn md:p-1.5 md:min-h-0 md:min-w-0 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 disabled:opacity-40"
                            title="Export campaign"
                        >
                            {isExporting === c.id ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                        </button>
                    </div>
                ))}

                {/* New Campaign Card */}
                <button
                    onClick={openCreate}
                    className="bg-surface border border-dashed border-border rounded-lg min-h-[140px] md:h-56 flex flex-col items-center justify-center gap-3 hover:border-terminal hover:bg-void-lighter transition-all duration-300 group"
                >
                    <Plus size={32} className="text-text-dim group-hover:text-terminal transition-colors" />
                    <span className="text-text-dim text-xs uppercase tracking-widest group-hover:text-terminal transition-colors font-bold">
                        New Campaign
                    </span>
                </button>
            </div>

            {/* Delete Confirmation */}
            {confirmDelete && (
                <div className="fixed inset-0 bg-ember/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setConfirmDelete(null)}>
                    <div className="bg-surface border border-danger rounded-lg p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
                        <p className="text-text-primary text-sm mb-4">Delete this campaign? All data (chat, lore, saves) will be lost.</p>
                        <div className="flex gap-3 justify-end">
                            <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-xs text-text-dim hover:text-text-primary border border-border rounded transition-colors">
                                Cancel
                            </button>
                            <button onClick={() => handleDelete(confirmDelete)} className="px-4 py-2 text-xs text-void bg-danger rounded hover:brightness-110 transition-colors font-bold">
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Create / Edit Campaign Modal */}
            {modalOpen && (
                <div className="fixed inset-0 bg-ember/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => { setModalOpen(false); resetForm(); }}>
                    <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md max-h-[calc(85*var(--app-vh))] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                        <h2 className="text-terminal text-sm font-bold tracking-widest uppercase mb-6">
                            {editingCampaign ? 'Edit Campaign' : 'New Campaign'}
                        </h2>

                        {/* Campaign Name */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">Campaign Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Fantasy — Ash's Story"
                            className="w-full bg-void border border-border rounded px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/50 mb-4"
                            autoFocus
                        />

                        {/* Cover Image */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">Cover Image</label>
                        <div className="mb-4">
                            {coverPreview ? (
                                <div className="relative h-28 rounded overflow-hidden border border-border">
                                    <img src={coverPreview} alt="Cover" className="w-full h-full object-cover" />
                                    <button onClick={() => { setCoverFile(null); setCoverPreview(''); }}
                                        className="absolute top-1 right-1 bg-void/80 text-danger p-1 rounded">
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            ) : (
                                <label className="flex items-center justify-center h-20 border border-dashed border-border rounded cursor-pointer hover:border-terminal transition-colors">
                                    <span className="text-text-dim text-xs">Click or drop image</span>
                                    <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && handleCoverChange(e.target.files[0])} />
                                </label>
                            )}
                        </div>

                        {/* World Lore */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">
                            World Lore (.md) {editingCampaign && <span className="text-text-dim/50 normal-case">— re-upload to replace</span>}
                        </label>
                        <label className="flex items-center gap-2 px-3 py-3 md:py-2 bg-void border border-border rounded cursor-pointer hover:border-terminal transition-colors mb-1">
                            <BookOpen size={16} className="text-text-dim" />
                            <span className="text-sm text-text-dim">{loreName || 'Choose file...'}</span>
                            <input type="file" accept=".md,.txt" className="hidden" onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) { setLoreFile(f); setLoreName(f.name); }
                            }} />
                        </label>
                        <p className="text-text-dim text-xs mb-4 opacity-60">Split into chunks by ### headers for dynamic retrieval</p>

                        {/* Rules */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">
                            Rules (.md) {editingCampaign && <span className="text-text-dim/50 normal-case">— re-upload to replace</span>}
                        </label>
                        <label className="flex items-center gap-2 px-3 py-3 md:py-2 bg-void border border-border rounded cursor-pointer hover:border-terminal transition-colors mb-1">
                            <BookOpen size={16} className="text-text-dim" />
                            <span className="text-sm text-text-dim">{rulesName || 'Choose file...'}</span>
                            <input type="file" accept=".md,.txt" className="hidden" onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) { setRulesFile(f); setRulesName(f.name); }
                            }} />
                        </label>
                        <p className="text-text-dim text-xs mb-4 opacity-60">System rules — always-active context</p>

                        {/* Loot Table (optional — Loot Engine WO-03) */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">
                            Loot Table (.json) <span className="text-text-dim/50 normal-case">— optional</span> {editingCampaign && <span className="text-text-dim/50 normal-case">— re-upload to replace</span>}
                        </label>
                        <label className="flex items-center gap-2 px-3 py-3 md:py-2 bg-void border border-border rounded cursor-pointer hover:border-terminal transition-colors mb-1">
                            <Package size={16} className="text-text-dim" />
                            <span className="text-sm text-text-dim">{lootName || 'Choose file...'}</span>
                            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) { setLootFile(f); setLootName(f.name); }
                            }} />
                        </label>
                        <p className="text-text-dim text-xs mb-8 opacity-60">World loot tree — powers the Loot button (manual drops)</p>

                        {/* Actions */}
                        <div className="flex gap-3 justify-end">
                            <button onClick={() => { setModalOpen(false); resetForm(); }} className="px-6 py-3 md:py-2 text-xs text-text-dim hover:text-text-primary border border-border rounded transition-colors min-h-[48px] md:min-h-0">
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={!name.trim()}
                                className="px-6 py-3 md:py-2 text-xs text-void bg-terminal rounded font-bold hover:brightness-110 transition-colors disabled:opacity-30 disabled:cursor-not-allowed min-h-[48px] md:min-h-0"
                            >
                                {editingCampaign ? 'Save Changes' : 'Create & Enter'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}


