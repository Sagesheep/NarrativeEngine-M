import { useEffect, useRef, useState } from 'react';
import { X, Waypoints, Loader2, Dices } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useBackHandler } from '../../hooks/useBackHandler';
import { hapticMedium } from '../../utils/haptics';
import {
    spawnArc, pickArcSpawnInput, pickSurpriseArc, arcTypeOption,
    ARC_TYPE_OPTIONS, ARC_TONES, ARC_PACE_LABEL,
} from '../../services/arc';
import { commitPendingTurn } from '../../services/turn';
import { computeOpenThreads } from '../../services/payload/payloadWorldContext';
import { toast } from '../Toast';
import { applyActiveSlotThinking } from '../../store/slices/slotThinking';
import type { ArcPace, ArcType, LLMProvider } from '../../types';

const GUIDE_MAX = 300;

type Picks = { pace: ArcPace; type?: ArcType; tone?: string; guide?: string; surprise: boolean };

/** Auxiliary → Utility → Story (with the auxiliary slot's thinking), cheapest configured first. */
function arcAuthorProvider(state: ReturnType<typeof useAppStore.getState>): LLMProvider | undefined {
    const usable = (p?: LLMProvider) => !!(p?.endpoint && p?.modelName);
    const aux = state.getActiveAuxiliaryEndpoint();
    if (usable(aux)) return aux;
    const utility = state.getActiveUtilityEndpoint();
    if (usable(utility)) return utility;
    return applyActiveSlotThinking(state.settings, 'auxiliary', state.getActiveStoryEndpoint());
}

/**
 * ArcCreatorSheet — the one place the player starts a story event. Replaces the Arc
 * Injector button and the One-Shot Event sheet.
 *
 * Pick a pace, optionally a type, a tone and a line of direction, then Create — or
 * Surprise me, which rolls a hidden type and tone. Either way ONE arc is authored
 * (+1 LLM via spawnArc, on the Auxiliary model when one is set) into context.arcs. An immediate arc's opening rung is also
 * armed as a hook that lands on the next send; a slow-burn arc surfaces gradually
 * through runArcTick.
 */
export function ArcCreatorSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
    useBackHandler(open, onClose);
    return open ? <SheetBody onClose={onClose} /> : null;
}

function SheetBody({ onClose }: { onClose: () => void }) {
    const armed = useAppStore(s => s.armedArcHook);
    const setArmed = useAppStore(s => s.setArmedArcHook);
    const isLite = useAppStore(s => s.settings.aiTier === 'lite');
    const isStreaming = useAppStore(s => s.pipelinePhase !== 'idle');

    const [pace, setPace] = useState<ArcPace>('immediate');
    const [type, setType] = useState<ArcType | ''>('');
    const [tone, setTone] = useState('');
    const [guide, setGuide] = useState('');
    const [busy, setBusy] = useState<'create' | 'surprise' | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Synchronous re-entry lock: two taps in one tick would otherwise spawn two arcs.
    const inFlight = useRef(false);

    const openedAtRef = useRef(0);
    useEffect(() => {
        openedAtRef.current = Date.now();
    }, []);

    const handleBackdropClick = () => {
        if (busy) return;
        if (Date.now() - openedAtRef.current < 350) return;
        onClose();
    };

    const run = async (picks: Picks) => {
        if (inFlight.current) return;
        const state = useAppStore.getState();
        // Authoring an arc is GM planning, not prose: keep it off the Story model.
        const provider = arcAuthorProvider(state);
        if (!provider) {
            setError('No AI configured. Set one in Settings → AI Providers.');
            return;
        }

        inFlight.current = true;
        setBusy(picks.surprise ? 'surprise' : 'create');
        setError(null);
        try {
            // Swipe Generation v1: commit any pending swipe turn first (the arc tick
            // reads engine state that the commit derives).
            await commitPendingTurn();

            const sealedChapters = (state.chapters ?? []).filter(c => c.sealedAt != null && !c.invalidated);
            const archiveIndex = state.archiveIndex ?? [];
            const lastScene = archiveIndex[archiveIndex.length - 1];
            const latestChapter = sealedChapters[sealedChapters.length - 1];
            const lastGm = [...state.messages].reverse().find(m => m.role === 'assistant');
            const lastGmText = typeof lastGm?.content === 'string' ? lastGm.content : '';

            const spawnInput = pickArcSpawnInput({
                arcs: state.context.arcs ?? [],
                openThreads: computeOpenThreads(sealedChapters),
                pressure: state.npcPressure ?? {},
                npcLedger: state.npcLedger ?? [],
                worldContext: latestChapter?.summary
                    ? `Recently sealed chapter "${latestChapter.title}": ${latestChapter.summary}`
                    : '',
                bornScene: lastScene?.sceneId ?? '000',
                nowScene: lastScene ? parseInt(lastScene.sceneId, 10) || 0 : 0,
                fallbackAnchorText: lastGmText || picks.guide,
            });
            if (!spawnInput) {
                setError('Nothing to anchor an arc to yet — play a little further first, or add a direction.');
                return;
            }

            // Surprise me rolls the type and tone here, steering away from recent arc types.
            const rolled = picks.surprise ? pickSurpriseArc(spawnInput.suppressedTypes) : null;
            const arc = await spawnArc({
                provider,
                ...spawnInput,
                pace: picks.pace,
                type: rolled?.type ?? picks.type,
                tone: rolled?.tone ?? picks.tone,
                guide: picks.guide,
                currentScene: lastGmText.slice(-1500),
            });
            if (!arc) {
                setError('Arc generation failed — try again.');
                return;
            }

            const fresh = useAppStore.getState();
            fresh.updateContext({ arcs: [...(fresh.context.arcs ?? []), arc] });

            if (picks.pace === 'immediate') {
                const label = picks.surprise
                    ? 'Surprise'
                    : [arcTypeOption(arc.type)?.label, arc.tone].filter(Boolean).join(' · ') || 'Event';
                fresh.setArmedArcHook({ hook: arc.ladder[0].label, label });
                toast.success('Event ready — it happens on your next message.');
            } else {
                toast.success('Arc started — it will surface as the story unfolds.');
            }
            hapticMedium();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create an arc');
        } finally {
            inFlight.current = false;
            setBusy(null);
        }
    };

    const trimmedGuide = guide.trim() || undefined;
    const typeBlurb = type ? arcTypeOption(type)?.blurb : 'The AI picks a type that fits the story.';
    const disabled = busy !== null || isStreaming;

    const chip = (active: boolean) =>
        `px-2.5 py-1.5 min-h-[36px] rounded border text-[11px] uppercase tracking-wider transition-colors ${
            active
                ? 'border-amber-500/70 bg-amber-500/10 text-amber-400'
                : 'border-border text-text-dim hover:border-amber-500/40'
        }`;

    return (
        <div
            className="fixed inset-0 z-[120] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={handleBackdropClick}
        >
            <div
                className="w-full md:max-w-2xl bg-void-darker border border-border rounded-t-lg md:rounded-lg shadow-2xl max-h-[calc(85*var(--app-vh))] overflow-y-auto animate-in slide-in-from-bottom duration-300"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                        <Waypoints size={14} className="text-amber-500" />
                        <span className="text-[11px] uppercase tracking-widest text-text-dim">Arc Creator</span>
                    </div>
                    <button onClick={onClose} disabled={busy !== null} className="text-text-dim hover:text-text-primary p-1 rounded transition-colors disabled:opacity-40" title="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wider text-text-dim">Pace</div>
                        <div className="flex gap-1.5">
                            {(['immediate', 'slow'] as const).map(p => (
                                <button key={p} type="button" onClick={() => setPace(p)} className={`flex-1 ${chip(pace === p)}`}>
                                    {ARC_PACE_LABEL[p]}
                                </button>
                            ))}
                        </div>
                        <p className="text-[11px] text-text-dim leading-relaxed">
                            {pace === 'immediate'
                                ? 'Starts in the current scene on your next message, then keeps developing.'
                                : 'Begins quietly in the background — prices, rumours — and builds toward a crisis over many scenes.'}
                            {pace === 'slow' && isLite && ' Slow-burn arcs do not advance on the Lite tier.'}
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <label htmlFor="arc-type" className="text-[10px] uppercase tracking-wider text-text-dim">Type</label>
                        <select
                            id="arc-type"
                            value={type}
                            onChange={e => setType(e.target.value as ArcType | '')}
                            className="w-full bg-surface border border-border px-2 py-2 min-h-[40px] text-[16px] md:text-[12px] text-text-primary focus:border-amber-500 outline-none rounded"
                        >
                            <option value="">Any</option>
                            {ARC_TYPE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                        <p className="text-[11px] text-text-dim">{typeBlurb}</p>
                    </div>

                    <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-wider text-text-dim">Tone</div>
                        <div className="flex flex-wrap gap-1.5">
                            <button type="button" onClick={() => setTone('')} className={chip(tone === '')}>Any</button>
                            {ARC_TONES.map(t => (
                                <button key={t} type="button" onClick={() => setTone(t)} className={chip(tone === t)}>{t}</button>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <label htmlFor="arc-guide" className="text-[10px] uppercase tracking-wider text-text-dim flex justify-between">
                            <span>Direction (optional)</span>
                            <span>{guide.length}/{GUIDE_MAX}</span>
                        </label>
                        <textarea
                            id="arc-guide"
                            value={guide}
                            maxLength={GUIDE_MAX}
                            onChange={e => setGuide(e.target.value)}
                            rows={2}
                            placeholder="e.g. something to do with the innkeeper's brother"
                            className="w-full bg-surface border border-border px-2 py-1.5 text-[16px] md:text-[12px] text-text-primary focus:border-amber-500 outline-none rounded resize-y"
                        />
                    </div>

                    {error && <p className="text-[11px] text-danger">{error}</p>}
                </div>

                <div className="px-4 py-3 border-t border-border flex items-center gap-2 safe-bottom">
                    <button
                        type="button"
                        onClick={() => run({ pace, guide: trimmedGuide, surprise: true })}
                        disabled={disabled}
                        title="Random hidden type and tone"
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 min-h-[44px] border border-amber-500/40 text-amber-400 text-[11px] uppercase tracking-widest rounded hover:bg-amber-500/5 transition-colors disabled:opacity-40"
                    >
                        {busy === 'surprise' ? <Loader2 size={13} className="animate-spin" /> : <Dices size={13} />} Surprise me
                    </button>
                    <button
                        type="button"
                        onClick={() => run({ pace, type: type || undefined, tone: tone || undefined, guide: trimmedGuide, surprise: false })}
                        disabled={disabled}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 min-h-[44px] bg-amber-500/15 border border-amber-500/70 text-amber-400 text-[11px] uppercase tracking-widest rounded hover:bg-amber-500/25 transition-colors disabled:opacity-40"
                    >
                        {busy === 'create' && <Loader2 size={13} className="animate-spin" />} Create arc
                    </button>
                </div>

                {armed && (
                    <div className="px-4 py-2 border-t border-border/50 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-text-dim">
                        <span>Armed for next message: {armed.label}</span>
                        <button
                            type="button"
                            onClick={() => setArmed(null)}
                            disabled={busy !== null}
                            className="px-2 py-1 border border-border rounded hover:bg-border/40 transition-colors"
                        >
                            Disarm
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
