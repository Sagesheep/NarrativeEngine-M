import { User, Trash2, CheckSquare, Square } from 'lucide-react';
import type { NPCEntry } from '../../types';

type Props = {
    npcLedger: NPCEntry[];
    selectedId: string | null;
    selectMode: boolean;
    checkedIds: Set<string>;
    onSelect: (npc: NPCEntry) => void;
    onToggleCheck: (id: string) => void;
    onDelete: (id: string, e: React.MouseEvent) => void;
};

export function NPCListView({ npcLedger, selectedId, selectMode, checkedIds, onSelect, onToggleCheck, onDelete }: Props) {
    return (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {npcLedger.length === 0 && (
                <p className="text-text-dim text-xs text-center p-4 italic opacity-50">No records found.</p>
            )}
            {npcLedger.map(npc => {
                const isActive = selectedId === npc.id && !selectMode;
                const isChecked = checkedIds.has(npc.id);
                return (
                    <div
                        key={npc.id}
                        onClick={() => selectMode ? onToggleCheck(npc.id) : onSelect(npc)}
                        className={`flex items-center justify-between p-3 md:p-3 cursor-pointer border-l-2 transition-all group min-h-[64px] md:min-h-0 ${isActive ? 'border-terminal bg-terminal/5' : isChecked ? 'border-terminal/40 bg-terminal/5' : 'border-transparent hover:bg-surface'}`}
                    >
                        <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                            {selectMode ? (
                                <div className="shrink-0 text-terminal">
                                    {isChecked
                                        ? <CheckSquare size={14} />
                                        : <Square size={14} className="text-text-dim" />}
                                </div>
                            ) : (
                                <User size={14} className={`shrink-0 ${isActive ? 'text-terminal' : 'text-text-dim'}`} />
                            )}
                            <div className="truncate min-w-0">
                                <p className={`text-[16px] md:text-sm font-bold truncate ${isActive ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>
                                    {npc.name}
                                </p>
                                <div className="flex items-center gap-1 text-[10px] mt-0.5 text-text-dim truncate">
                                    {npc.faction && <span className="bg-terminal/10 text-terminal px-1 rounded uppercase">{npc.faction}</span>}
                                    {npc.aliases && <span className="truncate">{npc.aliases}</span>}
                                </div>
                            </div>
                        </div>
                        {!selectMode && (
                            <button
                                onClick={(e) => onDelete(npc.id, e)}
                                className="p-3 md:p-1.5 text-text-dim hover:text-danger hover:bg-danger/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 shrink-0 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center"
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
