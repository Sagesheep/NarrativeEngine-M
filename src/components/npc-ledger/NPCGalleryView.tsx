import { User, Trash2, CheckSquare, Square } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { NPCEntry } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { imageStorage } from '../../services/storage/imageStorage';

function PortraitThumb({ npc }: { npc: NPCEntry }) {
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!npc.portrait || !activeCampaignId) return;
        let cancelled = false;
        imageStorage.getPortrait(activeCampaignId, npc.id).then(u => { if (!cancelled) setUrl(u); });
        return () => { cancelled = true; };
    }, [npc.id, npc.portrait, activeCampaignId]);
    if (!url) return <User size={32} className="text-text-dim/30" />;
    return <img src={url} alt={npc.name} className="w-full h-full object-cover object-top" />;
}

type Props = {
    npcLedger: NPCEntry[];
    selectedId: string | null;
    selectMode: boolean;
    checkedIds: Set<string>;
    onSelect: (npc: NPCEntry) => void;
    onToggleCheck: (id: string) => void;
    onDelete: (id: string, e: React.MouseEvent) => void;
};

export function NPCGalleryView({ npcLedger, selectedId, selectMode, checkedIds, onSelect, onToggleCheck, onDelete }: Props) {
    return (
            <div className="p-4 grid grid-cols-2 md:grid-cols-3 gap-4 md:gap-3">
            {npcLedger.length === 0 && (
                <p className="text-text-dim text-xs text-center p-4 italic opacity-50 col-span-full">No records found.</p>
            )}
            {npcLedger.map(npc => {
                const isActive = selectedId === npc.id;
                const isChecked = checkedIds.has(npc.id);
                return (
                    <div
                        key={npc.id}
                        onClick={() => selectMode ? onToggleCheck(npc.id) : onSelect(npc)}
                        className={`relative aspect-[3/4] rounded overflow-hidden cursor-pointer border group transition-all ${isActive ? 'border-terminal ring-1 ring-terminal' : isChecked ? 'border-terminal/50 ring-1 ring-terminal/30' : 'border-border hover:border-terminal/50'}`}
                    >
                        <div className="w-full h-full bg-void-lighter flex flex-col items-center justify-center gap-2">
                            <PortraitThumb npc={npc} />
                        </div>
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-void via-void/80 to-transparent p-3 pt-8">
                            <p className={`text-[14px] md:text-xs font-bold truncate ${isActive ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>{npc.name}</p>
                            {npc.canon === true && <p className="text-[9px] text-amber-400 uppercase mt-0.5" title="Canon character — identity locked to source">Canon</p>}
                            {npc.faction && <p className="text-[9px] text-text-dim truncate uppercase mt-0.5">{npc.faction}</p>}
                        </div>
                        {selectMode ? (
                            <div className="absolute top-2 left-2 p-1 bg-void/80 rounded" onClick={(e) => { e.stopPropagation(); onToggleCheck(npc.id); }}>
                                {isChecked ? <CheckSquare size={14} className="text-terminal" /> : <Square size={14} className="text-text-dim" />}
                            </div>
                        ) : (
                            <button
                                onClick={(e) => onDelete(npc.id, e)}
                                className="absolute top-2 right-2 p-3 md:p-1.5 bg-void/80 rounded text-text-dim hover:text-danger hover:bg-danger/20 transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100 flex items-center justify-center min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0"
                            >
                                <Trash2 size={16} className="md:w-[12px] md:h-[12px]" />
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
