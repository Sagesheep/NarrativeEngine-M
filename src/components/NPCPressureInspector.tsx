import type { NPCEntry, NPCPressureHistory } from '../types';
import { useAppStore } from '../store/useAppStore';

function miniSparkline(history: NPCPressureHistory[] | undefined, type: 'ignored' | 'engaged'): string {
    if (!history || history.length === 0) return '—';
    const filtered = history.filter((h: NPCPressureHistory) => h.type === type).slice(-10);
    if (filtered.length === 0) return '—';
    const max = Math.max(...filtered.map((h: NPCPressureHistory) => h.delta), 1);
    const bars = filtered.map((h: NPCPressureHistory) => {
        const height = Math.max(1, Math.round((h.delta / max) * 4));
        return '▁▂▃▄▅'[height] || '▅';
    });
    return bars.join('');
}

function NPCCard({ npc, archived }: { npc: NPCEntry; archived?: boolean }) {
    const pressure = npc.pressure;
    const hasDrives = !!npc.drives;
    const hasTriggers = !!npc.behavioralTriggers && npc.behavioralTriggers.length > 0;

    return (
        <div className={`bg-void border p-2 space-y-1.5 ${archived ? 'border-text-dim/20 opacity-60' : 'border-border'}`}>
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-text-primary">{npc.name}</span>
                <div className="flex items-center gap-1.5">
                    {archived && <span className="text-[8px] text-text-dim/50 uppercase bg-white/5 px-1 rounded">archived</span>}
                    <span className="text-[9px] text-text-dim">aff:{npc.affinity}</span>
                </div>
            </div>

            {hasDrives && (
                <div className="text-[9px] text-text-dim space-y-0.5">
                    {npc.drives!.coreWant && <div><span className="text-terminal">Core:</span> {npc.drives!.coreWant}</div>}
                    {npc.drives!.sessionWant && <div><span className="text-ice">Session:</span> {npc.drives!.sessionWant}</div>}
                    {npc.drives!.sceneWant && <div><span className="text-amber-400">Scene:</span> {npc.drives!.sceneWant}</div>}
                </div>
            )}

            {hasTriggers && (
                <div className="text-[9px] text-text-dim">
                    <span className="text-purple-400">Triggers:</span>{' '}
                    {npc.behavioralTriggers!.map(t => `"${t.keyword}"→${t.shift}`).join('; ')}
                </div>
            )}

            {pressure ? (
                <div className="grid grid-cols-2 gap-2 mt-1">
                    <div>
                        <div className="text-[9px] text-danger/70 uppercase">Ignored</div>
                        <div className="text-[11px] font-mono text-text-primary">{pressure.ignored.toFixed(1)}</div>
                        <div className="text-[8px] text-text-dim font-mono">{miniSparkline(pressure.history, 'ignored')}</div>
                    </div>
                    <div>
                        <div className="text-[9px] text-terminal/70 uppercase">Engaged</div>
                        <div className="text-[11px] font-mono text-text-primary">{pressure.engaged.toFixed(1)}</div>
                        <div className="text-[8px] text-text-dim font-mono">{miniSparkline(pressure.history, 'engaged')}</div>
                    </div>
                </div>
            ) : (
                <div className="text-[9px] text-text-dim/40 italic">No pressure data</div>
            )}

            {pressure && pressure.history.length > 0 && (
                <div className="border-t border-border/30 pt-1 mt-1 space-y-0.5">
                    <div className="text-[8px] text-text-dim/50 uppercase">Last 5 events</div>
                    {pressure.history.slice(-5).reverse().map((h, i) => (
                        <div key={i} className="text-[8px] flex gap-2">
                            <span className="text-text-dim/50">T{h.turn}</span>
                            <span className={h.type === 'ignored' ? 'text-danger/60' : 'text-terminal/60'}>{h.type}</span>
                            <span className="text-text-dim">+{h.delta}</span>
                            <span className="text-text-dim/60 truncate">{h.reason}</span>
                        </div>
                    ))}
                </div>
            )}

            {archived && (
                <button
                    onClick={() => useAppStore.getState().restoreNPC(npc.id)}
                    className="text-[9px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10"
                >
                    Restore
                </button>
            )}
        </div>
    );
}

export function NPCPressureInspector() {
    const npcLedger = useAppStore(s => s.npcLedger);
    const debugMode = useAppStore(s => s.settings.debugMode);

    if (!debugMode) return null;

    const activeNPCs = npcLedger.filter(n => !n.archived);
    const archivedNPCs = npcLedger.filter(n => n.archived);

    const npcsWithPressure = activeNPCs.filter(n => n.drives || n.pressure);
    const npcsWithoutPressure = activeNPCs.filter(n => !n.drives && !n.pressure);
    const archivedWithPressure = archivedNPCs.filter(n => n.drives || n.pressure);

    return (
        <details className="border border-border/50 rounded">
            <summary className="cursor-pointer text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none px-2 py-1 flex items-center gap-2">
                <span className="font-bold uppercase tracking-wider">NPC Pressure Inspector</span>
                <span className="text-[9px] text-text-dim/40">({npcsWithPressure.length} tracked / {activeNPCs.length} active{archivedNPCs.length > 0 ? `, ${archivedNPCs.length} archived` : ''})</span>
            </summary>
            <div className="p-2 space-y-2 max-h-96 overflow-y-auto">
                {npcsWithPressure.length === 0 && (
                    <p className="text-[9px] text-text-dim/40 italic p-2">No NPCs with drives or pressure data yet.</p>
                )}
                {npcsWithPressure.map(npc => (
                    <NPCCard key={npc.id} npc={npc} />
                ))}
                {npcsWithoutPressure.length > 0 && (
                    <div className="text-[9px] text-text-dim/30 border-t border-border/20 pt-2">
                        <span className="uppercase tracking-wider">Untracked NPCs:</span>{' '}
                        {npcsWithoutPressure.map(n => n.name).join(', ')}
                    </div>
                )}
                {archivedWithPressure.length > 0 && (
                    <div className="border-t border-border/20 pt-2 mt-2">
                        <div className="text-[9px] text-text-dim/50 uppercase tracking-wider mb-1">Archived NPCs</div>
                        {archivedWithPressure.map(npc => (
                            <NPCCard key={npc.id} npc={npc} archived />
                        ))}
                    </div>
                )}
            </div>
        </details>
    );
}
