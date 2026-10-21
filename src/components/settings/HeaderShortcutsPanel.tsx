import { ChevronUp, ChevronDown, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import type { HeaderActionId } from '../../types';
import {
    HEADER_ACTIONS,
    DEFAULT_HEADER_SHORTCUTS,
    getHeaderAction,
    toggleHeaderShortcut,
    moveHeaderShortcut,
} from '../header/headerActions';

const ICON_BUTTON = 'p-1.5 rounded text-text-dim hover:text-terminal hover:bg-terminal/5 transition-colors disabled:opacity-30 disabled:pointer-events-none';

/** Pick which actions sit in the header bar, and their order. The rest live in the ⋮ menu. */
export function HeaderShortcutsPanel() {
    const shortcuts = useAppStore(s => s.settings.headerShortcuts) ?? DEFAULT_HEADER_SHORTCUTS;
    const updateSettings = useAppStore(s => s.updateSettings);

    const save = (headerShortcuts: HeaderActionId[]) => updateSettings({ headerShortcuts });
    const menuOnly = HEADER_ACTIONS.filter(a => !shortcuts.includes(a.id));

    const row = (id: HeaderActionId, index: number | null) => {
        const { label, icon: Icon } = getHeaderAction(id);
        const shown = index !== null;
        return (
            <li key={id} className="flex items-center gap-2 py-1">
                <Icon size={14} className={shown ? 'text-terminal' : 'text-text-dim'} />
                <span className={`flex-1 text-[11px] ${shown ? 'text-text-primary' : 'text-text-dim'}`}>{label}</span>
                {shown && (
                    <>
                        <button className={ICON_BUTTON} disabled={index === 0} onClick={() => save(moveHeaderShortcut(shortcuts, id, -1))} aria-label={`Move ${label} earlier`}>
                            <ChevronUp size={14} />
                        </button>
                        <button className={ICON_BUTTON} disabled={index === shortcuts.length - 1} onClick={() => save(moveHeaderShortcut(shortcuts, id, 1))} aria-label={`Move ${label} later`}>
                            <ChevronDown size={14} />
                        </button>
                    </>
                )}
                <button className={ICON_BUTTON} onClick={() => save(toggleHeaderShortcut(shortcuts, id))} aria-label={shown ? `Hide ${label} from header` : `Show ${label} in header`}>
                    {shown ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
            </li>
        );
    };

    return (
        <div className="bg-void p-4 border border-border rounded space-y-3">
            <div className="flex items-center justify-between">
                <label className="text-[11px] text-text-primary uppercase tracking-wider font-bold">Header shortcuts</label>
                <button
                    onClick={() => save([...DEFAULT_HEADER_SHORTCUTS])}
                    className="text-[10px] text-text-dim hover:text-terminal transition-colors"
                >
                    Reset
                </button>
            </div>
            <p className="text-[10px] text-text-dim">
                Shown actions sit in the header, left to right. Hidden ones stay in the ⋮ menu. Deep Search only appears while it's enabled under Global.
            </p>

            <div>
                <div className="text-[10px] text-text-dim uppercase tracking-widest mb-1">In header</div>
                {shortcuts.length > 0
                    ? <ul>{shortcuts.map((id, i) => row(id, i))}</ul>
                    : <div className="text-[10px] text-text-dim/70 italic py-1">None — everything is in the ⋮ menu.</div>}
            </div>

            {menuOnly.length > 0 && (
                <div>
                    <div className="text-[10px] text-text-dim uppercase tracking-widest mb-1">In ⋮ menu</div>
                    <ul>{menuOnly.map(a => row(a.id, null))}</ul>
                </div>
            )}
        </div>
    );
}
