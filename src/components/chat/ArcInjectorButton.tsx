import { useState } from 'react';
import { Syringe, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { spawnArc, pickArcSpawnInput } from '../../services/arc';
import { computeOpenThreads } from '../../services/payload/payloadWorldContext';
import { toast } from '../Toast';

/**
 * Arc Injector — manual trigger for the Arc Engine (System 2 / Oracle).
 *
 * The old "Create Trouble" button generated a 4-option A/B/C/D menu the player PICKED
 * from (predictable — the thing requirement #2 was built to kill). This fires ONE
 * auto-generated, laddered arc into context.arcs; the player prods the timing but does
 * NOT author the arc. It then surfaces gradually (ambient → rumor → direct) via the
 * existing runArcTick / arcDigest machinery. The press IS the spawn gate — there is no
 * automatic seam spawn and no arcWorldState check.
 */
export function ArcInjectorButton({ onDone }: { onDone?: () => void } = {}) {
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const [injecting, setInjecting] = useState(false);

    const isStreaming = pipelinePhase !== 'idle';

    const handleClick = async () => {
        const state = useAppStore.getState();

        const provider = state.getActiveStoryEndpoint();
        if (!provider) {
            toast.error('No Story AI configured. Set one in Settings → AI Providers.');
            return;
        }

        setInjecting(true);
        try {
            const sealedChapters = (state.chapters ?? []).filter(c => c.sealedAt != null && !c.invalidated);
            const openThreads = computeOpenThreads(sealedChapters);
            const archiveIndex = state.archiveIndex ?? [];
            const nowScene = archiveIndex.length > 0
                ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
                : 0;
            const bornScene = archiveIndex.length > 0
                ? archiveIndex[archiveIndex.length - 1].sceneId
                : '000';

            const latestChapter = sealedChapters[sealedChapters.length - 1];
            const worldContext = latestChapter?.summary
                ? `Recently sealed chapter "${latestChapter.title}": ${latestChapter.summary}`
                : '';

            // Fallback anchor so a press always grounds on something: the last GM line.
            const lastGm = [...state.messages].reverse().find(m => m.role === 'assistant');
            const fallbackAnchorText = typeof lastGm?.content === 'string' ? lastGm.content : undefined;

            const spawnInput = pickArcSpawnInput({
                arcs: state.context.arcs ?? [],
                openThreads,
                pressure: state.npcPressure ?? {},
                npcLedger: state.npcLedger ?? [],
                worldContext,
                bornScene,
                nowScene,
                fallbackAnchorText,
            });

            if (!spawnInput) {
                toast.info('Nothing to anchor an arc to yet — play a little further first.');
                return;
            }

            const arc = await spawnArc({ provider, ...spawnInput });
            if (!arc) {
                toast.error('Arc generation failed — try again.');
                return;
            }

            const currentArcs = state.context.arcs ?? [];
            state.updateContext({ arcs: [...currentArcs, arc] });
            const activeCount = currentArcs.filter(a => a.status === 'active').length + 1;
            toast.success(`Arc injected — ${activeCount} now simmering. It will surface as the story unfolds.`);
            onDone?.();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to inject an arc');
        } finally {
            setInjecting(false);
        }
    };

    const disabled = isStreaming || injecting;

    return (
        <button
            onClick={handleClick}
            disabled={disabled}
            className="shrink-0 flex items-center gap-1.5 bg-void border border-amber-500/50 text-amber-500 text-[10px] uppercase tracking-wider px-3 py-1.5 min-h-[40px] rounded transition-all hover:bg-amber-500/5 disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
        >
            {injecting ? <Loader2 size={13} className="animate-spin" /> : <Syringe size={13} />} INJECT ARC
        </button>
    );
}
