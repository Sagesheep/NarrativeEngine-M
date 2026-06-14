import type { NPCPressure, NPCPressureHistory } from '../types';
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

function NPCCard({ name, id, pressure, hasDrives, hasTriggers }: {
    name: string;
    id: string;
    pressure: NPCPressure | undefined;
    hasDrives: boolean;
    hasTriggers: boolean;
}) {
    return (
        <div className="bg-void border border-border p-2 space-y-1.5">
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-text-primary">{name}</span>
                <span className="text-[9px] text-text-dim">id:{id.slice(0, 6)}</span>
            </div>

            {hasDrives && (
                <div className="text-[9px] text-text-dim">
                    <span className="text-terminal">Has drives</span>
                </div>
            )}

            {hasTriggers && (
                <div className="text-[9px] text-text-dim">
                    <span className="text-purple-400">Has triggers</span>
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
                    {pressure.history.slice(-5).reverse().map((h: NPCPressureHistory, i: number) => (
                        <div key={i} className="text-[8px] flex gap-2">
                            <span className="text-text-dim/50">T{h.turn}</span>
                            <span className={h.type === 'ignored' ? 'text-danger/60' : 'text-terminal/60'}>{h.type}</span>
                            <span className="text-text-dim">+{h.delta}</span>
                            <span className="text-text-dim/60 truncate">{h.reason}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export function NPCPressureInspector() {
    const npcLedger = useAppStore(s => s.npcLedger);
    const npcPressure = useAppStore(s => s.npcPressure);
    const debugMode = useAppStore(s => s.settings.debugMode);

    if (!debugMode) return null;

    const npcsWithData = npcLedger.filter(n => n.drives || npcPressure[n.id]);
    const npcsWithoutData = npcLedger.filter(n => !n.drives && !npcPressure[n.id]);

    return (
        <details className="border border-border/50 rounded">
            <summary className="cursor-pointer text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none px-2 py-1 flex items-center gap-2">
                <span className="font-bold uppercase tracking-wider">NPC Pressure Inspector</span>
                <span className="text-[9px] text-text-dim/40">({npcsWithData.length} tracked / {npcLedger.length} total)</span>
            </summary>
            <div className="p-2 space-y-2 max-h-96 overflow-y-auto">
                {npcsWithData.length === 0 && (
                    <p className="text-[9px] text-text-dim/40 italic p-2">No NPCs with drives or pressure data yet.</p>
                )}
                {npcsWithData.map(npc => (
                    <NPCCard
                        key={npc.id}
                        name={npc.name}
                        id={npc.id}
                        pressure={npcPressure[npc.id]}
                        hasDrives={!!npc.drives}
                        hasTriggers={!!npc.behavioralTriggers && npc.behavioralTriggers.length > 0}
                    />
                ))}
                {npcsWithoutData.length > 0 && (
                    <div className="text-[9px] text-text-dim/30 border-t border-border/20 pt-2">
                        <span className="uppercase tracking-wider">Untracked NPCs:</span>{' '}
                        {npcsWithoutData.map(n => n.name).join(', ')}
                    </div>
                )}
            </div>
        </details>
    );
}
