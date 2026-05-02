import type { DivergenceEntry } from '../../types';

type QuestPanelProps = {
    entries: DivergenceEntry[];
    onResolve: (id: string) => void;
};

export function QuestPanel({ entries, onResolve }: QuestPanelProps) {
    const open = entries.filter(e => e.category === 'obligation' && !e.resolved);

    if (open.length === 0) return null;

    return (
        <div className="bg-void-lighter border border-amber-500/20 rounded p-3">
            <span className="text-[10px] text-amber-400 uppercase tracking-widest font-bold block mb-2">Open Obligations</span>
            <ul className="space-y-1.5">
                {open.map(e => (
                    <li key={e.id} className="flex items-start gap-2">
                        <button
                            onClick={() => onResolve(e.id)}
                            className="mt-0.5 w-3.5 h-3.5 shrink-0 border border-amber-500/40 rounded-sm hover:bg-amber-500/20 transition-colors"
                            title="Mark resolved"
                        />
                        <div className="min-w-0">
                            <span className="text-[11px] text-text-primary">{e.subject}: {e.divergence}</span>
                            <span className="text-[9px] text-text-dim ml-2">[Scene #{e.sceneRef}]</span>
                        </div>
                    </li>
                ))}
            </ul>
            <p className="text-[9px] text-text-dim mt-2">Tap checkbox to mark resolved.</p>
        </div>
    );
}
