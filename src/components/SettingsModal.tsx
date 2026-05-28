import { useState, useEffect } from 'react';
import { X, Plus, Trash2, ArrowLeft, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { testConnection } from '../services/chatEngine';
import type { AIPreset, CondenseAggressiveness, LLMProvider, ApiFormat, SamplingConfig, AiTier } from '../types';
import { detectFormatFromEndpoint } from '../utils/llmApiHelper';
import { toast } from './Toast';
import { uid } from '../utils/uid';
import { SamplingPanel } from './SamplingPanel';
import { ProviderConfigSection } from './settings/ProviderConfigSection';
import { switchEmbeddingModel, getCurrentModelId, runFullReindex, rebuildAllEmbeddings } from '../services/embedding';
import type { DownloadProgress } from '../services/embedding';
import { embeddingStorage } from '../services/storage/embeddingStorage';
import { useUtilityCalls, clearHistory } from '../services/llm/utilityCallTracker';
import type { UtilityCallStatus } from '../services/llm/utilityCallTracker';

type ProviderSection = 'storyAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI';

export function SettingsModal() {
  const settings = useAppStore(s => s.settings);
  const updateSettings = useAppStore(s => s.updateSettings);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const toggleSettings = useAppStore(s => s.toggleSettings);
  const addPreset = useAppStore(s => s.addPreset);
  const updatePreset = useAppStore(s => s.updatePreset);
  const removePreset = useAppStore(s => s.removePreset);
  const setMobileView = useAppStore(s => s.setMobileView);
  const [activeTab, setActiveTab] = useState(settings.presets[0]?.id || '');
  const [testingSection, setTestingSection] = useState<ProviderSection | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string } | null>>({});

  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    storyAI: true,
    summarizerAI: false,
    utilityAI: false,
    auxiliaryAI: false,
  });

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const { history: utilityHistory } = useUtilityCalls();
  const [embeddingSwitching, setEmbeddingSwitching] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [reindexProgress, setReindexProgress] = useState<{ done: number; total: number } | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState<'toHigh' | 'toStandard' | null>(null);
  const [showCacheConfirm, setShowCacheConfirm] = useState(false);
  const [vectorCounts, setVectorCounts] = useState<Record<string, number> | null>(null);
  const activeCampaignId = useAppStore(s => s.activeCampaignId);

  useEffect(() => {
    if (!advancedOpen || !activeCampaignId) {
      setVectorCounts(null);
      return;
    }
    let cancelled = false;
    embeddingStorage.countByModel(activeCampaignId)
      .then(counts => { if (!cancelled) setVectorCounts(counts); })
      .catch(() => { if (!cancelled) setVectorCounts({}); });
    return () => { cancelled = true; };
  }, [advancedOpen, activeCampaignId, embeddingSwitching, reindexProgress?.done]);

  const handleClose = () => {
    toggleSettings();
    setMobileView('chat');
  };

  if (!settingsOpen) return null;

  const activePreset = settings.presets.find((p) => p.id === activeTab) || settings.presets[0];

  const handleTest = async (section: ProviderSection) => {
    if (!activePreset) return;
    const config = activePreset[section];
    if (!config || !config.endpoint) return;

    setTestingSection(section);
    setTestResults(prev => ({ ...prev, [section]: null }));
    const result = await testConnection(config);
    setTestResults(prev => ({ ...prev, [section]: result }));
    setTestingSection(null);
    if (result.ok) {
      toast.success(`${section} connection successful`);
    } else {
      toast.error(`${section} connection failed: ${result.detail}`);
    }
  };

  const handleAddPreset = () => {
    const newPreset: AIPreset = {
      id: uid(),
      name: `Preset ${settings.presets.length + 1}`,
      storyAI: { endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3', apiFormat: 'openai' },
      summarizerAI: { endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'llama3', apiFormat: 'openai' },
      utilityAI: { endpoint: '', apiKey: '', modelName: '' },
    };
    addPreset(newPreset);
    setActiveTab(newPreset.id);
    setTestResults({});
  };

  const handleRemovePreset = (id: string) => {
    if (settings.presets.length <= 1) return;
    removePreset(id);
    setActiveTab(settings.presets[0]?.id || '');
    setTestResults({});
  };

  const handleUpdatePresetName = (name: string) => {
    if (!activePreset) return;
    updatePreset(activePreset.id, { name });
  };

  const handleUpdateEndpoint = (section: ProviderSection, field: keyof LLMProvider, value: string | boolean | undefined) => {
    if (!activePreset) return;
    const updatedConfig = { ...activePreset[section], [field]: value };
    updatePreset(activePreset.id, { [section]: updatedConfig });
  };

  const handleApiFormatChange = (section: ProviderSection, newFormat: ApiFormat) => {
    if (!activePreset) return;
    const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' };
    let endpoint = (config.endpoint || '').replace(/\/+$/, '');
    if (newFormat === 'ollama') {
      endpoint = endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    } else if (newFormat === 'openai' || newFormat === 'claude') {
      if (endpoint && !endpoint.endsWith('/v1') && /localhost:11434|127\.0\.0\.1:11434/.test(endpoint)) {
        endpoint = endpoint + '/v1';
      }
    }
    const updatedConfig = { ...config, apiFormat: newFormat, endpoint };
    updatePreset(activePreset.id, { [section]: updatedConfig });
  };

  const handleEndpointBlur = (section: ProviderSection, endpoint: string) => {
    if (!activePreset || !endpoint) return;
    const detected = detectFormatFromEndpoint(endpoint);
    if (!detected) return;
    const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' };
    const currentFormat = config.apiFormat || 'openai';
    if (currentFormat === detected) return;
    let normalizedEndpoint = endpoint.replace(/\/+$/, '');
    if (detected === 'ollama') {
      normalizedEndpoint = normalizedEndpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    }
    updatePreset(activePreset.id, { [section]: { ...config, apiFormat: detected, endpoint: normalizedEndpoint } });
  };

  const toggleSection = (section: string) => {
    setExpanded(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const renderProviderConfig = (section: ProviderSection, title: string) => {
    return (
      <ProviderConfigSection
        section={section}
        title={title}
        activePreset={activePreset}
        isExpanded={expanded[section]}
        isTesting={testingSection === section}
        testResult={testResults[section] || null}
        onToggle={() => toggleSection(section)}
        onUpdateEndpoint={handleUpdateEndpoint}
        onApiFormatChange={handleApiFormatChange}
        onEndpointBlur={handleEndpointBlur}
        onTest={handleTest}
      />
    );
  };

  return (
    <div className={`mobile-page md:fixed md:inset-0 md:z-[100] md:flex md:items-center md:justify-center ${settingsOpen ? 'open' : ''}`} role="dialog" aria-modal="true" aria-label="Settings">
      {/* Desktop Backdrop */}
      <div className="hidden md:absolute md:inset-0 md:bg-ember/40 md:backdrop-blur-sm" onClick={handleClose} />

      {/* Panel */}
      <div className="relative bg-surface border-border w-full h-full md:h-[85vh] md:max-w-xl md:mx-4 md:border md:shadow-2xl flex flex-col overflow-hidden">
        {/* Mobile Header */}
        <div className="mobile-page-header safe-top md:hidden px-4 py-3 border-b border-border bg-void">
          <button onClick={handleClose} className="back-btn -ml-2">
            <ArrowLeft size={24} />
          </button>
          <span className="page-title">Settings</span>
        </div>

        {/* Desktop Header */}
        <div className="hidden md:flex items-center justify-between p-6 border-b border-border shrink-0 bg-void z-10">
          <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase glow-green">
            ⚙ SETTINGS
          </h2>
          <button onClick={handleClose} className="text-text-dim hover:text-danger">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 nav-clearance md:pb-6">
          {/* Preset Tabs */}
          <div className="flex flex-col mb-8">
            <label className="text-text-dim text-xs uppercase tracking-widest mb-3 font-bold">AI Presets</label>
            <div className="flex items-center gap-1 border-b border-border overflow-x-auto pb-px">
              {settings.presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setActiveTab(p.id); setTestResults({}); }}
                  className={`px-4 py-3 md:py-2 text-xs md:text-[11px] uppercase tracking-wider whitespace-nowrap transition-all border-b-2 -mb-px ${activeTab === p.id
                    ? 'text-terminal border-terminal bg-terminal/5 font-bold'
                    : 'text-text-dim border-transparent hover:text-text-primary'
                    }`}
                >
                  {p.name}
                </button>
              ))}
              <button
                onClick={handleAddPreset}
                className="px-4 py-3 md:py-2 text-text-dim hover:text-terminal transition-colors touch-btn"
              >
                <Plus size={18} />
              </button>
            </div>
          </div>

          {activePreset && (
            <div className="mb-8">
              <div className="flex gap-2 items-end mb-8">
                <div className="flex-1">
                  <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Preset Name</label>
                  <input
                    type="text"
                    value={activePreset.name}
                    onChange={(e) => handleUpdatePresetName(e.target.value)}
                    className="w-full bg-void border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary font-bold focus:border-terminal focus:outline-none"
                  />
                </div>
                {settings.presets.length > 1 && (
                  <button
                    onClick={() => handleRemovePreset(activePreset.id)}
                    className="bg-void border border-danger/40 text-danger touch-btn hover:bg-danger/10"
                  >
                    <Trash2 size={20} />
                  </button>
                )}
              </div>

              {renderProviderConfig('storyAI', 'Story & Logic AI')}
              {renderProviderConfig('summarizerAI', 'Summarizer & Context AI')}
              {renderProviderConfig('utilityAI', 'Utility AI (Context Recommender)')}
              {renderProviderConfig('auxiliaryAI', 'Auxiliary AI (NPC Validator — use Haiku/Flash)')}

              <SamplingPanel
                preset={activePreset}
                onUpdate={(sampling: SamplingConfig) => updatePreset(activePreset.id, { sampling })}
              />
            </div>
          )}

          {/* Global Settings */}
          <div className="mt-4 pt-8 border-t border-border space-y-8">
            <label className="text-text-dim text-xs uppercase tracking-widest font-bold block">Global Preferences</label>

            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-[11px] text-text-dim uppercase tracking-wider">Max Context (Tokens)</label>
                <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-xs">
                  {settings.contextLimit.toLocaleString()}
                </span>
              </div>
              <input
                type="number"
                step={1024}
                value={settings.contextLimit || 0}
                onChange={(e) => updateSettings({ contextLimit: parseInt(e.target.value) || 0 })}
                className="w-full bg-void border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm font-mono focus:border-terminal focus:outline-none mb-4"
              />
              <div className="flex flex-wrap gap-2">
                {[8192, 16384, 32768, 131072, 1048576].map(limit => (
                  <button
                    key={limit}
                    onClick={() => updateSettings({ contextLimit: limit })}
                    className={`px-3 py-2 text-[10px] md:text-[9px] font-mono border rounded transition-colors ${settings.contextLimit === limit ? 'bg-terminal text-void border-terminal' : 'bg-surface border-border text-text-dim'}`}
                  >
                    {limit >= 1048576 ? `${limit / 1048576}M` : `${limit / 1024}K`}
                  </button>
                ))}
              </div>
            </div>

            {/* Auto-Condense — separate card with strategy selector */}
            <div className="bg-void p-4 border border-border rounded">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">Auto-Trim</label>
                  <p className="text-[10px] text-text-dim">
                    Trim history at {Math.round((settings.condenseAggressiveness === 'aggressive' ? 50 : settings.condenseAggressiveness === 'quality' ? 90 : 75))}% limit
                  </p>
                </div>
                <button
                  onClick={() => updateSettings({ autoCondenseEnabled: !settings.autoCondenseEnabled })}
                  className={`relative w-12 h-6 rounded-full transition-colors ${settings.autoCondenseEnabled ? 'bg-terminal' : 'bg-border'}`}
                >
                  <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.autoCondenseEnabled ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                </button>
              </div>

              {settings.autoCondenseEnabled && (
                <div className="mt-4 pt-4 border-t border-border/60">
                  <label className="block text-[10px] text-text-dim uppercase tracking-widest mb-3">Context Strategy</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { value: 'aggressive' as const, label: 'Tight', pct: 50, desc: 'Lower cost' },
                      { value: 'balanced' as const, label: 'Smart', pct: 75, desc: 'Best default' },
                      { value: 'quality' as const, label: 'Deep', pct: 90, desc: 'Higher cost' },
                    ] as { value: CondenseAggressiveness; label: string; pct: number; desc: string }[]).map(({ value, label, pct, desc }) => (
                      <button
                        key={value}
                        onClick={() => updateSettings({ condenseAggressiveness: value })}
                        className={`py-3 text-center border rounded transition-colors ${
                          (settings.condenseAggressiveness || 'balanced') === value
                            ? 'bg-terminal border-terminal text-void'
                            : 'bg-surface border-border text-text-dim hover:border-terminal/50'
                        }`}
                      >
                        <div className="text-[11px] font-bold">{label}</div>
                        <div className="text-[16px] font-mono font-bold">{pct}%</div>
                        <div className="text-[9px] text-current opacity-60">{desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

             </div>

             {/* AI Tier */}
            <div className="bg-void p-4 border border-border rounded">
              <div className="mb-3">
                <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">AI Call Budget</label>
                <p className="text-[10px] text-text-dim">Controls how many AI calls fire per turn. Lower tiers save cost; the engine and on-device embedder handle recall at every tier.</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {([
                  {
                    value: 'lite' as const,
                    label: 'Lite',
                    calls: '~1',
                    desc: 'Story only',
                  },
                  {
                    value: 'pro' as const,
                    label: 'Pro',
                    calls: '~4–6',
                    desc: 'Balanced',
                  },
                  {
                    value: 'max' as const,
                    label: 'Max',
                    calls: '~9–10',
                    desc: 'Full fidelity',
                  },
                ] as { value: AiTier; label: string; calls: string; desc: string }[]).map(({ value, label, calls, desc }) => (
                  <button
                    key={value}
                    onClick={() => updateSettings({ aiTier: value })}
                    className={`py-3 text-center border rounded transition-colors ${
                      (settings.aiTier ?? 'pro') === value
                        ? 'bg-terminal border-terminal text-void'
                        : 'bg-surface border-border text-text-dim hover:border-terminal/50'
                    }`}
                  >
                    <div className="text-[11px] font-bold">{label}</div>
                    <div className="text-[16px] font-mono font-bold">{calls}</div>
                    <div className="text-[9px] text-current opacity-60">{desc}</div>
                  </button>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-border/60 text-[9px] text-text-dim space-y-1.5">
                <p><span className="text-text-primary font-bold">Lite</span> — Only the storyteller runs; memory recall, NPC tracking, and bookkeeping are handled by the built-in engine and the free on-device embedder. Past-scene recall still works via semantic similarity, but there is no AI chapter summarization or NPC profiling. Best for tight budgets, local/weak models, and shorter campaigns.</p>
                <p><span className="text-text-primary font-bold">Pro</span> — Adds the high-impact context calls (search planner, chapter recall funnel, NPC/lore recommender) and maintains the memory they rely on (chapter summaries + NPC profiles, with throttled NPC updates). Skips polish calls. Balanced cost and quality for long campaigns on a budget.</p>
                <p><span className="text-text-primary font-bold">Max</span> — Everything fires: reranking, query expansion, per-turn importance rating, NPC intro engine, and periodic profile/inventory scans. Highest continuity and fidelity, highest cost. Best for capable models where quality outweighs spend.</p>
              </div>
            </div>

             {/* Divergence Register */}
            <div className="bg-void p-4 border border-amber-500/20 rounded">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-[11px] text-amber-400 uppercase tracking-wider font-bold mb-1">Divergence Register</label>
                  <p className="text-[10px] text-text-dim">Auto-extract campaign-altering facts from each turn</p>
                </div>
                <button
                  onClick={() => updateSettings({ autoExtractDivergences: !settings.autoExtractDivergences })}
                  className={`relative w-12 h-6 rounded-full transition-colors ${settings.autoExtractDivergences !== false ? 'bg-amber-500' : 'bg-border'}`}
                >
                  <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.autoExtractDivergences !== false ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                </button>
              </div>

              <div className="mt-4 pt-4 border-t border-border/60">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-[10px] text-text-dim uppercase tracking-widest">Register Token Budget</label>
                  <span className="text-amber-400 font-bold font-mono bg-amber-500/10 px-2 py-0.5 rounded text-xs">
                    {(settings.divergenceTokenBudget ?? 2000).toLocaleString()}
                  </span>
                </div>
                <input
                  type="number"
                  step={500}
                  min={500}
                  value={settings.divergenceTokenBudget ?? 2000}
                  onChange={(e) => updateSettings({ divergenceTokenBudget: Math.max(500, parseInt(e.target.value) || 500) })}
                  className="w-full bg-void border border-border px-3 py-2 text-[16px] md:text-sm font-mono focus:border-amber-500 focus:outline-none"
                />
              </div>

              <div className="mt-4 pt-4 border-t border-border/60">
                 <div className="flex items-center justify-between mb-2">
                   <label className="block text-[10px] text-text-dim uppercase tracking-widest">Divergence Scan Budget (tokens)</label>
                   <span className="text-amber-400 font-bold font-mono bg-amber-500/10 px-2 py-0.5 rounded text-xs">
                     {(!settings.divergenceScanBudget || settings.divergenceScanBudget <= 0)
                       ? `auto (${Math.floor(settings.contextLimit * 0.75).toLocaleString()})`
                       : settings.divergenceScanBudget.toLocaleString()}
                   </span>
                 </div>
                 <input
                   type="number"
                   step={1024}
                   min={0}
                   max={settings.contextLimit || 200000}
                   value={settings.divergenceScanBudget ?? 0}
                   onChange={(e) => updateSettings({ divergenceScanBudget: Math.max(0, parseInt(e.target.value) || 0) })}
                   className="w-full bg-void border border-border px-3 py-2 text-[16px] md:text-sm font-mono focus:border-amber-500 focus:outline-none"
                 />
                 <p className="text-[9px] text-text-dim mt-1 italic">Max tokens per scene batch scanned for divergence extraction. Set to 0 for auto (75% of context limit). Higher = more thorough but slower.</p>
               </div>
            </div>

            {/* NPC Auto-Archive */}
            <div className="bg-void p-4 border border-border rounded">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">NPC Auto-Archive</label>
                  <p className="text-[10px] text-text-dim">Archive NPCs with no engagement after N turns. 0 = disabled. Archived NPCs auto-restore on mention.</p>
                </div>
                <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-xs ml-3 shrink-0">
                  {(settings.autoArchiveStaleNPCsTurns ?? 15) === 0 ? 'off' : `${settings.autoArchiveStaleNPCsTurns ?? 15}t`}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={50}
                step={5}
                value={settings.autoArchiveStaleNPCsTurns ?? 15}
                onChange={(e) => updateSettings({ autoArchiveStaleNPCsTurns: parseInt(e.target.value) })}
                className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer accent-terminal"
              />
              <div className="flex justify-between text-[9px] text-text-dim mt-1">
                <span>off</span>
                <span>50 turns</span>
              </div>
            </div>

            {/* Toggles */}
            <div className="space-y-4">
              {[
                { label: 'Debug Mode', setting: 'debugMode' as const, sub: 'Show raw API payloads' },
                { label: 'Show Reasoning', setting: 'showReasoning' as const, sub: 'Display model thinking blocks' },
                { label: 'Deep Archive Search', setting: 'enableDeepArchiveSearch' as const, sub: 'Long-press Send for AI full-archive scan. Requires utility endpoint. ~1-2 min per use.' },
                { label: 'Auto-Gen Rule Keywords', setting: 'autoGenerateRuleKeywords' as const, sub: 'Use LLM to extract rule chunk keywords at index time. Disable to use header+bold derivation only (free, no API calls).' },
              ].map(({ label, setting, sub }) => (
                <div key={setting} className="flex items-center justify-between bg-void p-4 border border-border rounded">
                  <div>
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">{label}</label>
                    <p className="text-[10px] text-text-dim">{sub}</p>
                  </div>
                  <button
                    onClick={() => updateSettings({ [setting]: !settings[setting] })}
                    className={`relative w-12 h-6 rounded-full transition-colors ${settings[setting] ? 'bg-terminal' : 'bg-border'}`}
                  >
                    <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${settings[setting] ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                  </button>
                </div>
              ))}
            </div>

            {/* UI Scale */}
            <div className="flex flex-col bg-void p-4 border border-border rounded">
              <div className="flex items-center justify-between mb-3">
                <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">UI Scale</label>
                <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-xs">
                  {Math.round((settings.uiScale ?? 1) * 100)}%
                </span>
              </div>
              <p className="text-[10px] text-text-dim mb-3">100% is recommended for mobile. Changes apply immediately.</p>
              <div className="grid grid-cols-4 gap-2">
                {[0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3].map(v => (
                  <button
                    key={v}
                    onClick={() => updateSettings({ uiScale: v })}
                    className={`py-3 text-[11px] font-mono font-bold border rounded transition-colors min-h-[48px] ${Math.round((settings.uiScale ?? 1) * 100) === Math.round(v * 100) ? 'bg-terminal text-void border-terminal' : 'bg-surface border-border text-text-dim hover:border-terminal/50'}`}
                  >
                    {Math.round(v * 100)}%
                  </button>
                ))}
              </div>
            </div>

            {/* Theme */}
            <div className="flex items-center justify-between bg-void p-4 border border-border rounded">
              <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">UI Theme</label>
              <div className="flex border border-border overflow-hidden rounded">
                {(['light', 'system', 'dark'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => updateSettings({ theme: t })}
                    className={`px-4 py-2 text-[11px] uppercase tracking-wider transition-colors ${settings.theme === t ? 'bg-terminal text-surface font-bold' : 'bg-void text-text-dim'}`}
                  >
                    {t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'System'}
                  </button>
                ))}
              </div>
            </div>

            {/* Advanced → Retrieval */}
            <div className="bg-void p-4 border border-border rounded">
              <button
                className="w-full flex items-center justify-between"
                onClick={() => setAdvancedOpen(!advancedOpen)}
              >
                <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">Advanced</label>
                {advancedOpen ? <ChevronDown size={16} className="text-text-dim" /> : <ChevronRight size={16} className="text-text-dim" />}
              </button>

              {advancedOpen && (
                <div className="mt-4 pt-4 border-t border-border/60 space-y-3">
                  <label className="block text-[10px] text-text-dim uppercase tracking-widest mb-2">Embedding Model</label>

                  <div className="space-y-2">
                    <button
                      disabled={embeddingSwitching || settings.embeddingModel === 'standard'}
                      onClick={() => {
                        if (settings.embeddingModel === 'high') setShowConfirmDialog('toStandard');
                      }}
                      className={`w-full flex items-center justify-between p-3 border rounded text-left transition-colors ${
                        settings.embeddingModel !== 'high'
                          ? 'border-terminal bg-terminal/5 text-text-primary'
                          : 'border-border bg-surface text-text-dim hover:border-terminal/50'
                      }`}
                    >
                      <div>
                        <div className="text-[11px] font-bold">Standard</div>
                        <div className="text-[9px] opacity-70">384-dim · ~23MB · bundled</div>
                      </div>
                      {settings.embeddingModel !== 'high' && <span className="text-[9px] text-terminal font-bold uppercase">Active</span>}
                    </button>

                    <button
                      disabled={embeddingSwitching || settings.embeddingModel === 'high'}
                      onClick={() => {
                        if (settings.embeddingModel !== 'high') setShowConfirmDialog('toHigh');
                      }}
                      className={`w-full flex items-center justify-between p-3 border rounded text-left transition-colors ${
                        settings.embeddingModel === 'high'
                          ? 'border-terminal bg-terminal/5 text-text-primary'
                          : 'border-border bg-surface text-text-dim hover:border-terminal/50'
                      }`}
                    >
                      <div>
                        <div className="text-[11px] font-bold">High quality</div>
                        <div className="text-[9px] opacity-70">768-dim · ~110MB · download on demand</div>
                      </div>
                      {settings.embeddingModel === 'high'
                        ? <span className="text-[9px] text-terminal font-bold uppercase">Active</span>
                        : <span className="text-[9px] text-text-dim"><Download size={12} className="inline" /></span>
                      }
                    </button>
                  </div>

                  {/* Vector storage status (active campaign only) */}
                  {activeCampaignId && vectorCounts !== null && (() => {
                    const currentModel = settings.embeddingModel === 'high' ? 'Xenova/bge-base-en-v1.5' : 'Xenova/all-MiniLM-L6-v2';
                    const upToDate = vectorCounts[currentModel] ?? 0;
                    const staleEntries = Object.entries(vectorCounts).filter(([m]) => m !== currentModel);
                    const staleTotal = staleEntries.reduce((sum, [, n]) => sum + n, 0);
                    const total = upToDate + staleTotal;
                    return (
                      <div className="mt-3 space-y-1">
                        <div className="text-[10px] text-text-dim uppercase tracking-widest">Storage status (this campaign)</div>
                        {total === 0 ? (
                          <div className="text-[10px] text-amber-400">
                            No embeddings stored — semantic retrieval is offline. Tap "Rebuild ALL" below to fix.
                          </div>
                        ) : (
                          <>
                            <div className="text-[10px] text-text-primary">
                              <span className="text-terminal">{upToDate}</span> vectors on current model
                            </div>
                            {staleTotal > 0 && (
                              <div className="text-[10px] text-amber-400">
                                {staleTotal} vector{staleTotal === 1 ? '' : 's'} on older model{staleEntries.length > 1 ? 's' : ''} — re-index needed
                              </div>
                            )}
                            {staleTotal === 0 && (
                              <div className="text-[10px] text-text-dim">All up to date ✓</div>
                            )}
                          </>
                        )}
                        <button
                          disabled={embeddingSwitching || staleTotal === 0}
                          onClick={async () => {
                            setEmbeddingSwitching(true);
                            setReindexProgress({ done: 0, total: 0 });
                            useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'switch' });
                            try {
                              await runFullReindex(activeCampaignId, (p) => {
                                setReindexProgress({ done: p.done, total: p.total });
                                useAppStore.getState().setEmbeddingsReindexing({ active: true, total: p.total, done: p.done, reason: 'switch' });
                              });
                              toast.success('Re-index complete');
                              const fresh = await embeddingStorage.countByModel(activeCampaignId);
                              setVectorCounts(fresh);
                            } catch (e) {
                              toast.error(`Re-index failed: ${e instanceof Error ? e.message : String(e)}`);
                            } finally {
                              useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                              setEmbeddingSwitching(false);
                              setReindexProgress(null);
                            }
                          }}
                          className="mt-2 w-full px-3 py-2 text-[10px] border border-border rounded text-text-primary hover:border-terminal hover:bg-terminal/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {staleTotal === 0 ? 'Re-index now (nothing to do)' : `Re-index ${staleTotal} stale vector${staleTotal === 1 ? '' : 's'} now`}
                        </button>
                        <button
                          disabled={embeddingSwitching}
                          onClick={async () => {
                            setEmbeddingSwitching(true);
                            setReindexProgress({ done: 0, total: 0 });
                            useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'switch' });
                            try {
                              const counts = await rebuildAllEmbeddings(activeCampaignId, (p) => {
                                setReindexProgress({ done: p.done, total: p.total });
                                useAppStore.getState().setEmbeddingsReindexing({ active: true, total: p.total, done: p.done, reason: 'switch' });
                              });
                              toast.success(`Rebuilt: ${counts.scenes} scenes, ${counts.lore} lore, ${counts.npcs} NPCs, ${counts.rules} rules`);
                              const fresh = await embeddingStorage.countByModel(activeCampaignId);
                              setVectorCounts(fresh);
                            } catch (e) {
                              toast.error(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
                            } finally {
                              useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                              setEmbeddingSwitching(false);
                              setReindexProgress(null);
                            }
                          }}
                          className="mt-1 w-full px-3 py-2 text-[10px] border border-amber-500/50 rounded text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Rebuild ALL embeddings from source (recovery)
                        </button>
                        <div className="text-[9px] text-text-dim/70 italic">
                          Current model: {getCurrentModelId().split('/').pop()}
                        </div>
                      </div>
                    );
                  })()}

                  {downloadProgress && embeddingSwitching && !reindexProgress && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[9px] text-text-dim mb-1">
                        <span>Downloading model…</span>
                        <span>{downloadProgress.aggregateTotal > 0 ? ((downloadProgress.aggregateLoaded / downloadProgress.aggregateTotal) * 100).toFixed(0) : '0'}%</span>
                      </div>
                      <div className="w-full bg-border rounded-full h-2 overflow-hidden">
                        <div className="bg-terminal h-full transition-all" style={{ width: `${downloadProgress.aggregateTotal > 0 ? (downloadProgress.aggregateLoaded / downloadProgress.aggregateTotal) * 100 : 0}%` }} />
                      </div>
                    </div>
                  )}

                  {reindexProgress && embeddingSwitching && (
                    <div className="mt-2">
                      <div className="flex justify-between text-[9px] text-text-dim mb-1">
                        <span>Re-indexing lore…</span>
                        <span>{reindexProgress.done}/{reindexProgress.total}</span>
                      </div>
                      <div className="w-full bg-border rounded-full h-2 overflow-hidden">
                        <div className="bg-terminal h-full transition-all" style={{ width: `${reindexProgress.total > 0 ? (reindexProgress.done / reindexProgress.total) * 100 : 0}%` }} />
                      </div>
                    </div>
                  )}

                  <button
                    onClick={() => setShowCacheConfirm(true)}
                    className="text-[10px] text-text-dim hover:text-danger transition-colors mt-2"
                  >
                    Clear cached embedding models
                  </button>
                </div>
              )}
            </div>

            {/* Debug Panel */}
            <div className="bg-void p-4 border border-border rounded">
              <button
                className="w-full flex items-center justify-between"
                onClick={() => setDebugPanelOpen(!debugPanelOpen)}
              >
                <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">Utility AI Debug</label>
                {debugPanelOpen ? <ChevronDown size={16} className="text-text-dim" /> : <ChevronRight size={16} className="text-text-dim" />}
              </button>

              {debugPanelOpen && (
                <div className="mt-4 pt-4 border-t border-border/60 space-y-4">
                  {/* Timeout setting */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] text-text-dim uppercase tracking-widest">Utility AI Timeout (seconds)</label>
                      <span className="text-terminal font-bold font-mono bg-terminal/10 px-2 py-0.5 rounded text-xs">
                        {settings.utilityTimeoutSeconds ?? 45}s
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={300}
                      step={5}
                      value={settings.utilityTimeoutSeconds ?? 45}
                      onChange={e => updateSettings({ utilityTimeoutSeconds: Number(e.target.value) })}
                      className="w-full accent-terminal"
                    />
                    <div className="flex justify-between text-[9px] text-text-dim">
                      <span>10s (aggressive)</span>
                      <span>5min (lenient)</span>
                    </div>
                    <p className="text-[9px] text-text-dim leading-relaxed">
                      Soft deadline for reranker, query expansion, and AI recommender calls. When exceeded, the EXTEND +1m button appears in-chat. After expiry without extension, the call is abandoned and the pipeline falls back gracefully.
                    </p>
                  </div>

                  {/* Verbose logging toggle */}
                  <div className="flex items-center justify-between bg-surface p-3 border border-border rounded">
                    <div>
                      <label className="block text-[10px] text-text-dim uppercase tracking-widest font-bold mb-1">Verbose Logging</label>
                      <p className="text-[9px] text-text-dim">Record retries and queue waits in the log below</p>
                    </div>
                    <button
                      onClick={() => updateSettings({ verboseUtilityLogging: !settings.verboseUtilityLogging })}
                      className={`relative w-12 h-6 rounded-full transition-colors ${settings.verboseUtilityLogging ? 'bg-terminal' : 'bg-border'}`}
                    >
                      <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.verboseUtilityLogging ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                    </button>
                  </div>

                  {/* Log header */}
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-text-dim uppercase tracking-widest">Utility AI Log ({utilityHistory.length})</label>
                    {utilityHistory.length > 0 && (
                      <button
                        onClick={() => clearHistory()}
                        className="text-[9px] text-text-dim hover:text-danger transition-colors uppercase tracking-wider"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {/* Log table */}
                  {utilityHistory.length === 0 ? (
                    <p className="text-[9px] text-text-dim italic">No utility calls recorded yet. Start a turn with a utility AI endpoint configured.</p>
                  ) : (
                    <div className="space-y-1 max-h-72 overflow-y-auto">
                      {utilityHistory.map(record => {
                        const outcomeIcon = (status: UtilityCallStatus) => {
                          if (status === 'success') return record.extensions > 0 ? '⚠ EXTENDED → ✓' : '✓';
                          if (status === 'timeout') return '⚠ TIMEOUT';
                          if (status === 'error') return '✗ ERROR';
                          if (status === 'aborted') return '✗ ABORTED';
                          return '?';
                        };
                        const outcomeColor = (status: UtilityCallStatus) => {
                          if (status === 'success') return record.extensions > 0 ? 'text-amber-400' : 'text-terminal';
                          return 'text-red-400';
                        };
                        const time = new Date(record.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        const dur = record.durationMs != null ? `${(record.durationMs / 1000).toFixed(1)}s` : '—';

                        return (
                          <div key={record.id} className="flex items-start gap-2 bg-surface px-3 py-2 rounded text-[9px] font-mono border border-border/50">
                            <span className="text-text-dim shrink-0 w-16">{time}</span>
                            <span className="text-text-primary truncate flex-1">{record.label}</span>
                            <span className="text-text-dim truncate max-w-[80px]">{record.endpointName}</span>
                            <span className="text-text-dim shrink-0 w-10 text-right">{dur}</span>
                            <span className={`shrink-0 font-bold ${outcomeColor(record.status)}`}>{outcomeIcon(record.status)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Confirm dialogs */}
            {showConfirmDialog === 'toHigh' && (
              <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="bg-surface border border-border rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
                  <h3 className="text-text-primary font-bold text-sm mb-3">Switch to high-quality embeddings?</h3>
                  <ul className="text-[11px] text-text-dim space-y-1 mb-4">
                    <li>Better lore retrieval, especially for fuzzy queries</li>
                    <li>One-time ~110MB download from HuggingFace (Wi-Fi recommended)</li>
                    <li>Recommended for phones from 2022+ with 6GB+ RAM</li>
                    <li>Your current campaign will be re-indexed (~2–5 min). <strong className="text-text-primary">AI turns are paused during re-index.</strong></li>
                    <li>Other campaigns re-index when you open them.</li>
                  </ul>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowConfirmDialog(null)} className="px-4 py-2 text-[11px] border border-border rounded text-text-dim hover:text-text-primary">Cancel</button>
                    <button
                      onClick={async () => {
                        setShowConfirmDialog(null);
                        setEmbeddingSwitching(true);
                        setDownloadProgress(null);
                        setReindexProgress(null);
                        try {
                          await switchEmbeddingModel('high', (progress) => {
                            setDownloadProgress(progress);
                          });
                          const cid = useAppStore.getState().activeCampaignId;
                          if (cid) {
                            useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'switch' });
                            setReindexProgress({ done: 0, total: 0 });
                            await runFullReindex(cid, (p) => {
                              setReindexProgress({ done: p.done, total: p.total });
                              useAppStore.getState().setEmbeddingsReindexing({ active: true, total: p.total, done: p.done, reason: 'switch' });
                            });
                            useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                          }
                          updateSettings({ embeddingModel: 'high' });
                          toast.success('Switched to high-quality embeddings');
                        } catch (e) {
                          toast.error(`Failed to switch: ${e instanceof Error ? e.message : String(e)}`);
                          useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                        } finally {
                          setEmbeddingSwitching(false);
                          setDownloadProgress(null);
                          setReindexProgress(null);
                        }
                      }}
                      className="px-4 py-2 text-[11px] bg-terminal text-void rounded font-bold hover:bg-terminal/90"
                    >
                      Download &amp; Switch
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showConfirmDialog === 'toStandard' && (
              <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="bg-surface border border-border rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
                  <h3 className="text-text-primary font-bold text-sm mb-3">Switch back to standard embeddings?</h3>
                  <ul className="text-[11px] text-text-dim space-y-1 mb-4">
                    <li>Your current campaign will be re-indexed with the smaller model (~1–2 min).</li>
                    <li>The 110MB model stays cached on your device in case you switch back.</li>
                  </ul>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowConfirmDialog(null)} className="px-4 py-2 text-[11px] border border-border rounded text-text-dim hover:text-text-primary">Cancel</button>
                    <button
                      onClick={async () => {
                        setShowConfirmDialog(null);
                        setEmbeddingSwitching(true);
                        setReindexProgress(null);
                        try {
                          await switchEmbeddingModel('standard');
                          const cid = useAppStore.getState().activeCampaignId;
                          if (cid) {
                            useAppStore.getState().setEmbeddingsReindexing({ active: true, total: 0, done: 0, reason: 'switch' });
                            setReindexProgress({ done: 0, total: 0 });
                            await runFullReindex(cid, (p) => {
                              setReindexProgress({ done: p.done, total: p.total });
                              useAppStore.getState().setEmbeddingsReindexing({ active: true, total: p.total, done: p.done, reason: 'switch' });
                            });
                            useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                          }
                          updateSettings({ embeddingModel: 'standard' });
                          toast.success('Switched to standard embeddings');
                        } catch (e) {
                          toast.error(`Failed to switch: ${e instanceof Error ? e.message : String(e)}`);
                          useAppStore.getState().setEmbeddingsReindexing({ active: false, total: 0, done: 0, reason: null });
                        } finally {
                          setEmbeddingSwitching(false);
                          setReindexProgress(null);
                        }
                      }}
                      className="px-4 py-2 text-[11px] bg-terminal text-void rounded font-bold hover:bg-terminal/90"
                    >
                      Switch
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showCacheConfirm && (
              <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="bg-surface border border-border rounded-lg p-6 max-w-sm mx-4 shadow-2xl">
                  <h3 className="text-text-primary font-bold text-sm mb-3">Clear cached embedding models?</h3>
                  <p className="text-[11px] text-text-dim mb-4">This will delete all downloaded model files from cache storage. The standard model is bundled and will still work. Switching to high quality later will require re-downloading ~110MB.</p>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowCacheConfirm(false)} className="px-4 py-2 text-[11px] border border-border rounded text-text-dim hover:text-text-primary">Cancel</button>
                    <button
                      onClick={async () => {
                        try {
                          if ('caches' in window) {
                            const cacheNames = await caches.keys();
                            for (const name of cacheNames) {
                              if (/transformers/i.test(name) || /Xenova/i.test(name) || /bge-base/i.test(name) || /MiniLM/i.test(name)) {
                                await caches.delete(name);
                              }
                            }
                          }
                          toast.success('Cached models cleared');
                        } catch (_e) {
                          toast.error('Failed to clear cache');
                        }
                        setShowCacheConfirm(false);
                      }}
                      className="px-4 py-2 text-[11px] bg-danger text-white rounded font-bold hover:bg-danger/90"
                    >
                      Clear Cache
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
