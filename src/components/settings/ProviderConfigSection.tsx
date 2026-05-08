import { ChevronDown, ChevronRight, Loader2, CheckCircle, XCircle } from 'lucide-react';
import type { AIPreset, LLMProvider, ApiFormat } from '../../types';

type ProviderKey = 'storyAI' | 'summarizerAI' | 'utilityAI' | 'auxiliaryAI' | 'enemyAI' | 'neutralAI' | 'allyAI';

type ProviderConfigSectionProps = {
    section: ProviderKey;
    title: string;
    activePreset: AIPreset;
    isExpanded: boolean;
    isTesting: boolean;
    testResult: { ok: boolean; detail: string } | null;
    onToggle: () => void;
    onUpdateEndpoint: (section: ProviderKey, field: keyof LLMProvider, value: string | boolean | undefined) => void;
    onApiFormatChange: (section: ProviderKey, format: ApiFormat) => void;
    onEndpointBlur: (section: ProviderKey, endpoint: string) => void;
    onTest: (section: ProviderKey) => void;
};

function getEndpointPlaceholder(apiFormat?: ApiFormat) {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'http://localhost:11434  or  https://ollama.com';
    if (fmt === 'claude') return 'https://api.anthropic.com/v1';
    if (fmt === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta';
    return 'http://localhost:11434/v1';
}

function getApiKeyPlaceholder(apiFormat?: ApiFormat) {
    const fmt = apiFormat || 'openai';
    if (fmt === 'ollama') return 'Ollama API key (optional for local)';
    if (fmt === 'claude') return 'sk-ant-...';
    if (fmt === 'gemini') return 'AIza...';
    return 'sk-...';
}

export function ProviderConfigSection({
    section,
    title,
    activePreset,
    isExpanded,
    isTesting,
    testResult,
    onToggle,
    onUpdateEndpoint,
    onApiFormatChange,
    onEndpointBlur,
    onTest,
}: ProviderConfigSectionProps) {
    const config = (activePreset[section] ?? { endpoint: '', apiKey: '', modelName: '' }) as LLMProvider;

    return (
        <div className="border border-border rounded mb-3 bg-void-lighter overflow-hidden">
            <button
                onClick={onToggle}
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
                            onChange={(e) => onUpdateEndpoint(section, 'endpoint', e.target.value)}
                            onBlur={(e) => onEndpointBlur(section, e.target.value)}
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
                            onChange={(e) => onApiFormatChange(section, e.target.value as ApiFormat)}
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
                            onChange={(e) => onUpdateEndpoint(section, 'modelName', e.target.value)}
                            placeholder="llama3"
                            className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="block text-[11px] text-text-dim uppercase tracking-wider mb-1">API Key</label>
                        <input
                            type="password"
                            value={config.apiKey}
                            onChange={(e) => onUpdateEndpoint(section, 'apiKey', e.target.value)}
                            placeholder={getApiKeyPlaceholder(config.apiFormat)}
                            className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary placeholder:text-text-dim/40 font-mono focus:border-terminal focus:outline-none"
                        />
                    </div>

                    <div className="flex items-center justify-between gap-3 py-2">
                        <label className="text-[11px] text-text-dim uppercase tracking-wider truncate">Enable Streaming</label>
                        <button
                            onClick={() => onUpdateEndpoint(section, 'streamingEnabled', config.streamingEnabled === false)}
                            className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${config.streamingEnabled !== false ? 'bg-terminal/60' : 'bg-border'}`}
                            title={config.streamingEnabled !== false ? 'Streaming on — click to disable' : 'Streaming off — click to enable'}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${config.streamingEnabled !== false ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                    </div>

                    <div className="pt-2">
                        <button
                            onClick={() => onTest(section)}
                            disabled={isTesting || !config.endpoint}
                            className="w-full bg-surface border border-terminal/40 hover:border-terminal text-terminal text-xs uppercase tracking-widest py-3 transition-all hover:glow-border disabled:opacity-50 flex items-center justify-center gap-2 min-h-[48px]"
                        >
                            {isTesting ? <><Loader2 size={14} className="animate-spin" /> Testing...</> : 'Test Connection'}
                        </button>
                        {testResult && (
                            <div className={`flex items-center gap-2 text-xs px-3 py-2 border mt-2 ${testResult.ok ? 'border-terminal/30 text-terminal bg-terminal/5' : 'border-danger/30 text-danger bg-danger/5'}`}>
                                {testResult.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
                                {testResult.detail}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
