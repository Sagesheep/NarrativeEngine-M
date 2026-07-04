import { useAppStore } from '../../store/useAppStore';
import type { CondenseAggressiveness, AiTier } from '../../types';

export function GlobalSettingsPanel() {
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);

    return (
        <div className="space-y-8">
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

            <div className="bg-void p-4 border border-border rounded">
                <div className="flex items-center justify-between">
                    <div>
                        <label className="block text-[11px] text-amber-400 uppercase tracking-wider font-bold mb-1">Mature Mode</label>
                        <p className="text-[10px] text-text-dim">
                            Unlocks mature-tier NPC traits, wants &amp; reactions (darker, adult themes).
                        </p>
                    </div>
                    <button
                        onClick={() => updateSettings({ matureMode: !settings.matureMode })}
                        className={`relative w-12 h-6 shrink-0 ml-3 rounded-full transition-colors ${settings.matureMode ? 'bg-amber-400' : 'bg-border'}`}
                        aria-label="Toggle Mature Mode"
                    >
                        <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.matureMode ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                    </button>
                </div>
            </div>

            <div className="bg-void p-4 border border-border rounded">
                <div className="flex items-center justify-between">
                    <div>
                        <label className="block text-[11px] text-ice uppercase tracking-wider font-bold mb-1">Read Aloud (TTS)</label>
                        <p className="text-[10px] text-text-dim">
                            Speaker button on GM messages reads reply aloud. Uses your device's built-in voice (offline, no download).
                        </p>
                    </div>
                    <button
                        onClick={() => updateSettings({ ttsEnabled: !settings.ttsEnabled })}
                        className={`relative w-12 h-6 shrink-0 ml-3 rounded-full transition-colors ${settings.ttsEnabled ? 'bg-ice' : 'bg-border'}`}
                        aria-label="Toggle Read Aloud"
                    >
                        <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${settings.ttsEnabled ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                    </button>
                </div>

                {settings.ttsEnabled && (
                    <div className="mt-4 pt-4 border-t border-border/60">
                        <div className="flex items-center justify-between mb-2">
                            <label className="block text-[10px] text-text-dim uppercase tracking-widest">Playback Speed</label>
                            <span className="text-ice font-bold font-mono bg-ice/10 px-2 py-0.5 rounded text-xs">
                                {(settings.ttsRate ?? 1).toFixed(2)}×
                            </span>
                        </div>
                        <input
                            type="range"
                            min={0.5}
                            max={2}
                            step={0.05}
                            value={settings.ttsRate ?? 1}
                            onChange={(e) => updateSettings({ ttsRate: parseFloat(e.target.value) })}
                            className="w-full h-2 bg-border rounded-lg appearance-none cursor-pointer accent-ice"
                        />
                        <div className="flex justify-between text-[9px] text-text-dim mt-1">
                            <span>0.5× slow</span>
                            <span>2× fast</span>
                        </div>
                        <p className="text-[9px] text-text-dim mt-2 italic">Voice quality depends on your Android's TTS engine. For a better voice, install "Speech Services & Voices" from the Play Store and download a natural English voice.</p>
                    </div>
                )}
            </div>

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
                        className={`relative w-12 h-6 shrink-0 ml-3 rounded-full transition-colors ${settings.autoCondenseEnabled ? 'bg-terminal' : 'bg-border'}`}
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

            <div className="bg-void p-4 border border-border rounded">
                <div className="mb-3">
                    <label className="block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">AI Call Budget</label>
                    <p className="text-[10px] text-text-dim">Controls how many AI calls fire per turn. Lower tiers save cost; the engine and on-device embedder handle recall at every tier.</p>
                </div>
                <div className="grid grid-cols-3 gap-2">
                    {([
                        { value: 'lite' as const, label: 'Lite', calls: '~1', desc: 'Story only' },
                        { value: 'pro' as const, label: 'Pro', calls: '~4–6', desc: 'Balanced' },
                        { value: 'max' as const, label: 'Max', calls: '~9–10', desc: 'Full fidelity' },
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

            <div className="bg-void p-4 border border-amber-500/20 rounded">
                <div className="flex items-center justify-between">
                    <div>
                        <label className="block text-[11px] text-amber-400 uppercase tracking-wider font-bold mb-1">Divergence Register</label>
                        <p className="text-[10px] text-text-dim">Auto-extract campaign-altering facts from each turn</p>
                    </div>
                    <button
                        onClick={() => updateSettings({ autoExtractDivergences: !settings.autoExtractDivergences })}
                        className={`relative w-12 h-6 shrink-0 ml-3 rounded-full transition-colors ${settings.autoExtractDivergences !== false ? 'bg-amber-500' : 'bg-border'}`}
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
                            className={`relative w-12 h-6 shrink-0 ml-3 rounded-full transition-colors ${settings[setting] ? 'bg-terminal' : 'bg-border'}`}
                        >
                            <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-surface transition-transform ${settings[setting] ? 'translate-x-[25px]' : 'translate-x-[3px]'}`} />
                        </button>
                    </div>
                ))}
            </div>

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

            <div className="flex flex-col bg-void p-4 border border-border rounded">
                <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">Image Style Prompt</label>
                <p className="text-[10px] text-text-dim mb-2">Prepended to every illustration request. Leave empty for the default style scaffold.</p>
                <input
                    type="text"
                    value={settings.imageStylePrompt || ''}
                    onChange={(e) => updateSettings({ imageStylePrompt: e.target.value })}
                    placeholder="e.g. oil painting, fantasy art, dark atmosphere"
                    className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none"
                />
            </div>

            <div className="flex flex-col bg-void p-4 border border-border rounded">
                <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">Image Negative Prompt</label>
                <p className="text-[10px] text-text-dim mb-2">Elements to exclude from generated images. Only supported by some models (e.g. DALL-E 2, Stable Diffusion).</p>
                <input
                    type="text"
                    value={settings.imageNegativePrompt || ''}
                    onChange={(e) => updateSettings({ imageNegativePrompt: e.target.value })}
                    placeholder="e.g. text, watermark, blurry, deformed"
                    className="w-full bg-surface border border-border px-3 py-3 md:py-2 text-[16px] md:text-sm text-text-primary focus:border-terminal focus:outline-none"
                />
            </div>
        </div>
    );
}