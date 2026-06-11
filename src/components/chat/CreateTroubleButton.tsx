import { Flame, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { generateTroubleOptions } from '../../services/engine';
import { toast } from '../Toast';

export function CreateTroubleButton() {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const troubleLoading = useAppStore(s => s.troubleLoading);
    const openTroubleModal = useAppStore(s => s.openTroubleModal);
    const closeTroubleModal = useAppStore(s => s.closeTroubleModal);

    const isStreaming = pipelinePhase !== 'idle';

    const handleClick = async () => {
        const state = useAppStore.getState();

        const provider = state.getActiveStoryEndpoint();
        if (!provider) {
            toast.error('No Story AI configured. Set one in Settings → AI Providers.');
            return;
        }

        useAppStore.setState({ troubleModalOpen: true, troubleLoading: true, troubleOptions: [] });

        try {
            const ctx = state.context;
            const sceneNote = ctx?.sceneNoteActive ? ctx.sceneNote : undefined;
            const options = await generateTroubleOptions(
                provider,
                state.messages,
                state.archiveIndex ?? [],
                state.chapters ?? [],
                state.npcLedger ?? [],
                sceneNote,
            );
            openTroubleModal(options);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to generate trouble options');
            closeTroubleModal();
        }
    };

    const disabled = isStreaming || troubleLoading;

    return (
        <button
            onClick={handleClick}
            disabled={disabled}
            className="shrink-0 flex items-center gap-1.5 bg-void border border-amber-500/50 text-amber-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all hover:bg-amber-500/5 disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
        >
            {troubleLoading ? <Loader2 size={13} className="animate-spin" /> : <Flame size={13} />} TROUBLE
        </button>
    );
}