import { Database, List } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { TemplateField } from './TemplateField';

export function SaveFileTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);

    return (
        <div className="px-4 py-4 space-y-4">
            <p className="text-[9px] text-text-dim/50">
                Toggle ON = appended to context (top→bottom order)
            </p>

            <TemplateField
                icon={<Database size={13} />}
                label="Canon State"
                color="text-ember"
                value={context.canonState}
                onChange={(v) => updateContext({ canonState: v })}
                placeholder="Paste canon state data..."
                rows={6}
                active={context.canonStateActive}
                onToggle={() => updateContext({ canonStateActive: !context.canonStateActive })}
            />

            <TemplateField
                icon={<List size={13} />}
                label="Header Index"
                color="text-ice"
                value={context.headerIndex}
                onChange={(v) => updateContext({ headerIndex: v })}
                placeholder="Paste header index..."
                rows={4}
                active={context.headerIndexActive}
                onToggle={() => updateContext({ headerIndexActive: !context.headerIndexActive })}
            />
        </div>
    );
}
