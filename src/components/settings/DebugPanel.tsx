import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useUtilityCalls, clearHistory } from '../../services/llm/utilityCallTracker';
import type { UtilityCallStatus } from '../../services/llm/utilityCallTracker';
import { useCacheTelemetry, hitRatio, totalsForDay, clearCacheTelemetry } from '../../services/llm/cacheTelemetry';
import { useSceneStakesFallbackCount, resetSceneStakesFallbackCount } from '../../services/llm/sceneStakesTelemetry';
import { LootDropTraceView } from '../LootDropTraceView';

function CacheTelemetrySection() {
    const rollup = useCacheTelemetry();
    const days = Object.keys(rollup).sort().reverse().slice(0, 5);
    const fmtK = (n: number) => `${(n / 1000).toFixed(1)}k`;

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <label className="text-[10px] text-text-dim uppercase tracking-widest">Prompt-Cache Performance</label>
                {days.length > 0 && (
                    <button
                        onClick={() => clearCacheTelemetry()}
                        className="text-[9px] text-text-dim hover:text-danger transition-colors uppercase tracking-wider"
                    >
                        Clear
                    </button>
                )}
            </div>
            {days.length === 0 ? (
                <p className="text-[9px] text-text-dim italic">No cache data yet. Captured automatically from providers that report cache hits (e.g. DeepSeek).</p>
            ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto">
                    {days.map(day => {
                        const total = totalsForDay(day)!;
                        const dayRatio = hitRatio(total);
                        const labels = Object.entries(rollup[day]).sort((a, b) => (b[1].hitTokens + b[1].missTokens) - (a[1].hitTokens + a[1].missTokens));
                        return (
                            <div key={day} className="bg-surface px-3 py-2 rounded border border-border/50">
                                <div className="flex items-center justify-between text-[10px] font-mono">
                                    <span className="text-text-primary font-bold">{day}</span>
                                    <span className={dayRatio >= 0.5 ? 'text-terminal font-bold' : 'text-amber-400 font-bold'}>
                                        {(dayRatio * 100).toFixed(0)}% hit
                                    </span>
                                </div>
                                <div className="text-[8px] text-text-dim font-mono mb-1">
                                    {fmtK(total.hitTokens)} hit · {fmtK(total.missTokens)} miss · {total.calls} calls
                                </div>
                                {labels.map(([label, s]) => (
                                    <div key={label} className="flex items-center justify-between text-[9px] font-mono pl-2">
                                        <span className="text-text-dim truncate flex-1">{label}</span>
                                        <span className="text-text-dim shrink-0 w-12 text-right">{(hitRatio(s) * 100).toFixed(0)}%</span>
                                        <span className="text-text-dim/70 shrink-0 w-20 text-right">{fmtK(s.hitTokens + s.missTokens)} in</span>
                                    </div>
                                ))}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export function DebugPanel() {
    const settings = useAppStore(s => s.settings);
    const updateSettings = useAppStore(s => s.updateSettings);
    const [debugPanelOpen, setDebugPanelOpen] = useState(false);
    const { history: utilityHistory } = useUtilityCalls();
    // Hooks must run unconditionally — read this at the top, not inside the
    // collapsed-panel JSX (calling it there changed the hook count on toggle → React #310).
    const sceneStakesFallbackCount = useSceneStakesFallbackCount();

    return (
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

                    <CacheTelemetrySection />

                    <div>
                        <label className="text-[10px] text-text-dim uppercase tracking-widest font-bold mb-2 block">Loot Drops</label>
                        <LootDropTraceView />
                    </div>

                    <div className="flex items-center justify-between bg-surface p-3 border border-border rounded">
                        <div>
                            <label className="block text-[10px] text-text-dim uppercase tracking-widest font-bold mb-1">Scene-Stakes Fallback Rate</label>
                            <p className="text-[9px] text-text-dim">Times the GM omitted the [[SCENE_STAKES]] tag and the cheap classifier fired</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-terminal font-bold font-mono text-xs">{sceneStakesFallbackCount}</span>
                            {sceneStakesFallbackCount > 0 && (
                                <button
                                    onClick={() => resetSceneStakesFallbackCount()}
                                    className="text-[9px] text-text-dim hover:text-danger transition-colors uppercase tracking-wider"
                                >
                                    Reset
                                </button>
                            )}
                        </div>
                    </div>

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
    );
}