import { useState } from 'react';
import { X, Loader2, CheckCircle, XCircle, Plus, Trash2, ChevronDown, ChevronRight, ArrowLeft } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { testConnection } from '../services/chatEngine';
import type { AIPreset, LLMProvider, ApiFormat, SamplingConfig } from '../types';
import { detectFormatFromEndpoint } from '../utils/llmApiHelper';
import { toast } from './Toast';
import { uid } from '../utils/uid';
import { SamplingPanel } from './SamplingPanel';

export function SettingsModal() {
  const { settings, updateSettings, settingsOpen, toggleSettings, addPreset, updatePreset, removePreset, setMobileView } = useAppStore();
  const [activeTab, setActiveTab] = useState(settings.presets[0]?.id || '');
  const [testingSection, setTestingSection] = useState<'storyAI' | 'summarizerAI' | 'utilityAI' | 'enemyAI' | 'neutralAI' | 'allyAI' | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string } | null>>({});

  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    storyAI: true,
    summarizerAI: false,
    utilityAI: false,
    enemyAI: false,
    neutralAI: false,
    allyAI: false,
  });

  const handleClose = () => {
    toggleSettings();
    setMobileView('chat');
  };

  if (!settingsOpen) return null;

  const activePreset = settings.presets.find((p) => p.id === activeTab) || settings.presets[0];

  const handleTest = async (section: 'storyAI' | 'summarizerAI' | 'utilityAI' | 'enemyAI' | 'neutralAI' | 'allyAI') => {
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
      enemyAI: { endpoint: '', apiKey: '', modelName: '' },
      neutralAI: { endpoint: '', apiKey: '', modelName: '' },
      allyAI: { endpoint: '', apiKey: '', modelName: '' }
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

  const handleUpdateEndpoint = (section: 'storyAI' | 'summarizerAI' | 'utilityAI' | 'enemyAI' | 'neutralAI' | 'allyAI', field: keyof LLMProvider, value: string | boolean | undefined) => {
    if (!activePreset) return;
    const updatedConfig = { ...activePreset[section], [field]: value };
    updatePreset(activePreset.id, { [section]: updatedConfig });
  };

  const handleApiFormatChange = (section: 'storyAI' | 'summarizerAI' | 'utilityAI' | 'enemyAI' | 'neutralAI' | 'allyAI', newFormat: ApiFormat) => {
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

  const handleEndpointBlur = (section: 'storyAI' | 'summarizerAI' | 'utilityAI' | 'enemyAI' | 'neutralAI' | 'allyAI', endpoint: string) => {
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

  const getEndpointPlaceholder = (apiFormat?: ApiFormat) => {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'http://localhost:11434  or  https://ollama.com';
    if (fmt === 'claude') return 'https://api.anthropic.com/v1';
    if (fmt === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta';
    return 'http://localhost:11434/v1';
  };

  const getApiKeyPlaceholder = (apiFormat?: ApiFormat) => {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'Ollama API key (optional for local)';
    if (fmt === 'claude') return 'sk-ant-...';
    if (fmt === 'gemini') return 'AIza...';
    return 'sk-...';
  };

  const toggleSection = (section: string) => {
    setExpanded(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const renderProviderConfig = (section: 'storyAI' | 'summarizerAI' | 'utilityAI' | 'enemyAI' | 'neutralAI' | 'allyAI', title: string) => {
    const config = activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' };
    const isExpanded = expanded[section];
    const isTesting = testingSection === section;
    const result = testResults[section];

    return (
      <div className="border border-border rounded mb-3 bg-void-lighter overflow-hidden">
        <button
          onClick={() => toggleSection(section)}
          className="w-full flex items-center justify-between p-3 bg-void hover:bg-surface transition-colors min-h-[48px]"
        >
          <div className="flex items-center gap-2 text-sm font-bold text-text-primary uppercase tracking-wider">
            {isExpanded ? <ChevronDown size={16} className="text-terminal" /> : <ChevronRight size={16} className="text-text-dim" />}
            {title}
          </div>
        </button>

        {isExpanded && (
          <div className="p-4 space-y-4 border-t border-border bg-void">
            <div>
              <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Endpoint</label>
              <input
                type="text"
                value={config.endpoint}
                onChange={(e) => handleUpdateEndpoint(section, 'endpoint', e.target.value)}
                onBlur={(e) => handleEndpointBlur(section, e.target.value)}
                placeholder={getEndpointPlaceholder(config.apiFormat)}
                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
              {(config.apiFormat || 'openai') === 'ollama' && (
                <p className="text-[10px] text-text-dim mt-1">
                  Local: <span className="font-mono">http://localhost:11434</span> &middot; Cloud: <span className="font-mono">https://ollama.com</span> (needs API key)
                </p>
              )}
              </div>
              <div>
                <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Format</label>
                <select
                  value={config.apiFormat || 'openai'}
                  onChange={(e) => handleApiFormatChange(section, e.target.value as ApiFormat)}
                  className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none appearance-none"
                >
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama</option>
                  <option value="claude">Claude (Anthropic)</option>
                  <option value="gemini">Gemini (Google)</option>
                </select>
              </div>
            <div>
              <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">Model Name</label>
              <input
                type="text"
                value={config.modelName}
                onChange={(e) => handleUpdateEndpoint(section, 'modelName', e.target.value)}
                placeholder="llama3"
                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Key</label>
              <input
                type="password"
                value={config.apiKey}
                onChange={(e) => handleUpdateEndpoint(section, 'apiKey', e.target.value)}
                placeholder={getApiKeyPlaceholder(config.apiFormat)}
                className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-3 py-2">
              <label className="text-[11px] text-text-dim uppercase tracking-wider truncate">Enable Streaming</label>
              <button
                onClick={() => {
                  if (!activePreset) return;
                  const updatedConfig = { ...activePreset[section], streamingEnabled: config.streamingEnabled === false };
                  updatePreset(activePreset.id, { [section]: updatedConfig });
                }}
                className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${config.streamingEnabled !== false ? 'bg-terminal/60' : 'bg-border'}`}
                title={config.streamingEnabled !== false ? 'Streaming on — click to disable (use for cloud models like GLM-5.1:cloud)' : 'Streaming off — click to enable'}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${config.streamingEnabled !== false ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>

            <div className="pt-2">
              <button
                onClick={() => handleTest(section)}
                disabled={isTesting || !config.endpoint}
                className="w-full bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-3 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2 min-h-[48px]"
              >
                {isTesting ? <><Loader2 size={14} className="animate-spin" /> Testing...</> : 'Test Connection'}
              </button>
              {result && (
                <div className={`flex items-center gap-2 text-xs px-3 py-2 border mt-2 ${result.ok ? 'border-terminal/30 text-terminal bg-terminal/5' : 'border-danger/30 text-danger bg-danger/5'}`}>
                  {result.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                  {result.detail}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
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
              {renderProviderConfig('enemyAI', 'Enemy AI (Adversarial Player)')}
              {renderProviderConfig('neutralAI', 'Neutral AI (Chaos/Environmental)')}
              {renderProviderConfig('allyAI', 'Ally AI (Beneficial Player)')}

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

            {/* Toggles */}
            <div className="space-y-4">
              {[
                { label: 'Auto-Condense', setting: 'autoCondenseEnabled' as const, sub: 'Compress history at 75% limit' },
                { label: 'Debug Mode', setting: 'debugMode' as const, sub: 'Show raw API payloads' },
                { label: 'Show Reasoning', setting: 'showReasoning' as const, sub: 'Display model thinking blocks' },
                { label: 'Deep Archive Search', setting: 'enableDeepArchiveSearch' as const, sub: 'Long-press Send for AI full-archive scan. Requires utility endpoint. ~1-2 min per use.' },
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
          </div>
        </div>
      </div>
    </div>
  );
}
