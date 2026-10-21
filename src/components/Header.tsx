import { useEffect, useState, useRef } from 'react';
import { LogOut, MoreVertical, Save, Archive, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { hapticMedium } from '../utils/haptics';
import { useShallow } from 'zustand/react/shallow';
import { addNpcFromSelection } from '../services/npc';
import type { AiTier, HeaderActionId } from '../types';
import { HEADER_ACTIONS, DEFAULT_HEADER_SHORTCUTS, getHeaderAction, contextTabOf, type HeaderActionDef } from './header/headerActions';

const TIER_CYCLE: Record<AiTier, AiTier> = { lite: 'pro', pro: 'max', max: 'lite' };

import { TokenGauge } from './TokenGauge';
import { DeepSearchSheet } from './chat/DeepSearchSheet';
import { saveCampaignState, saveDivergenceRegister } from '../store/campaignStore';
import { api } from '../services/apiClient';
import { toast } from './Toast';
import { applyActiveSlotThinking } from '../store/slices/slotThinking';

type SelectionSnapshot = {
    messageId: string;
    text: string;
    start: number;
    end: number;
    bubbleText: string;
};

/** `gm`: a selection inside GM narration (lore check, NPC add). `any`: inside any message (pin, rename). */
type Selection = { gm: SelectionSnapshot | null; any: SelectionSnapshot | null };

const NO_SELECTION: Selection = { gm: null, any: null };
const BUBBLE_SELECTORS: Record<keyof Selection, string> = {
    gm: '[data-lore-checkable="true"]',
    any: '[data-message-id]',
};

type Tone = 'idle' | 'ready' | 'armed' | 'busy' | 'muted';

const TONE_CLASS: Record<Tone, string> = {
    idle: 'text-text-dim hover:text-terminal',
    ready: 'text-terminal animate-pulse',
    armed: 'text-amber-400 animate-pulse',
    busy: 'text-terminal',
    muted: 'text-text-dim/40',
};

type ActionState = {
    onPress: () => void;
    tone: Tone;
    title: string;
    /** false hides the action everywhere (e.g. Deep Search while the feature is off). */
    available?: boolean;
    /** Shows a spinner in place of the icon. */
    busy?: boolean;
    badge?: number;
};

const MENU_ITEM_CLASS = 'w-full text-left px-3 py-2 text-xs hover:text-terminal hover:bg-terminal/5 flex items-center gap-2 transition-colors';

// Strip markdown bold/italic markers so selecting from a [**NAME**] chip gives "NAME".
const stripMarkdown = (s: string) => s.replace(/\*\*/g, '').replace(/\*/g, '').trim();

const captureFromBubble = (selector: string): SelectionSnapshot | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = (node.nodeType === 1 ? node as Element : node.parentElement);
    const bubble = el?.closest(selector) as HTMLElement | null;
    if (!bubble) return null;
    const messageId = bubble.dataset.messageId;
    const text = sel.toString().trim();
    if (!messageId || text.length < 1) return null;
    const bubbleText = bubble.textContent ?? '';
    // Exact match first; fall back to whitespace-normalised comparison (handles
    // multi-paragraph selections where ReactMarkdown <p> tags add extra \n).
    let start = bubbleText.indexOf(text);
    if (start === -1) {
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        start = norm(bubbleText).indexOf(norm(text));
    }
    // Still no match — keep start=0 so callers at least get the selected text.
    if (start === -1) start = 0;
    return { messageId, text, start, end: start + text.length, bubbleText };
};

const captureSelection = (): Selection => ({
    gm: captureFromBubble(BUBBLE_SELECTORS.gm),
    any: captureFromBubble(BUBBLE_SELECTORS.any),
});

/**
 * Selection actions fire on press-down so the tap doesn't collapse the highlight
 * first; everything else fires on click.
 */
const pressProps = (def: HeaderActionDef, onPress: () => void) => def.selection
    ? {
        onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); onPress(); },
        onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); onPress(); },
    }
    : { onClick: onPress };

export function Header() {

    const {
        toggleBackupModal,
        activeCampaignId,
        setActiveCampaign,
        deepArmed,
        armedRoll,
        setArmedRoll,
        openDiceRollModal,
        armedLoot,
        openLootRollModal,
        context,
        settings,
        updateSettings,
        openLoreCheck,
        addPinnedExcerpt,
        openRenameModal,
        openContextTab,
    } = useAppStore(useShallow(s => ({
        toggleBackupModal: s.toggleBackupModal,
        activeCampaignId: s.activeCampaignId,
        setActiveCampaign: s.setActiveCampaign,
        deepArmed: s.deepArmed,
        armedRoll: s.armedRoll,
        setArmedRoll: s.setArmedRoll,
        openDiceRollModal: s.openDiceRollModal,
        armedLoot: s.armedLoot,
        openLootRollModal: s.openLootRollModal,
        context: s.context,
        settings: s.settings,
        updateSettings: s.updateSettings,
        openLoreCheck: s.openLoreCheck,
        addPinnedExcerpt: s.addPinnedExcerpt,
        openRenameModal: s.openRenameModal,
        openContextTab: s.openContextTab,
    })));

    const [selection, setSelection] = useState<Selection>(NO_SELECTION);
    // Opening the ⋮ menu can collapse the highlight, so selection actions in the
    // menu fall back to what was selected when it opened.
    const menuSelectionRef = useRef<Selection>(NO_SELECTION);
    const [npcAdding, setNpcAdding] = useState(false);
    // Outstanding NPC adds (active + waiting). The queue lets the player fire off
    // several highlighted names without waiting for each LLM resolve to finish.
    const [npcQueueCount, setNpcQueueCount] = useState(0);
    const npcQueueRef = useRef<string[]>([]);
    const npcProcessingRef = useRef(false);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const overflowRef = useRef<HTMLDivElement>(null);
    const [deepSearchSheetOpen, setDeepSearchSheetOpen] = useState(false);

    useEffect(() => {
        const handle = () => setSelection(captureSelection());
        document.addEventListener('selectionchange', handle);
        return () => document.removeEventListener('selectionchange', handle);
    }, []);

    useEffect(() => {
        if (!overflowOpen) {
            menuSelectionRef.current = NO_SELECTION;
            return;
        }
        const handler = (e: MouseEvent) => {
            if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [overflowOpen]);

    const resolveSelection = (kind: keyof Selection): SelectionSnapshot | null =>
        captureFromBubble(BUBBLE_SELECTORS[kind]) ?? selection[kind] ?? menuSelectionRef.current[kind];

    const clearSelection = () => {
        window.getSelection()?.removeAllRanges();
        setSelection(NO_SELECTION);
        menuSelectionRef.current = NO_SELECTION;
    };

    const handleDice = () => {
        hapticMedium();
        if (armedRoll) setArmedRoll(null);
        else openDiceRollModal();
    };

    const handleLoot = () => {
        if (!context?.lootTree) {
            toast.warning('No loot table for this world');
            return;
        }
        hapticMedium();
        openLootRollModal();
    };

    const handleLoreCheck = () => {
        const snap = resolveSelection('gm');
        if (!snap) return;
        const before = snap.bubbleText.slice(Math.max(0, snap.start - 200), snap.start);
        const after = snap.bubbleText.slice(snap.end, Math.min(snap.bubbleText.length, snap.end + 200));
        openLoreCheck({
            messageId: snap.messageId,
            selectedText: stripMarkdown(snap.text),
            start: snap.start,
            end: snap.end,
            surroundingContext: `${before}[[HIGHLIGHTED]]${snap.text}[[/HIGHLIGHTED]]${after}`,
        });
        clearSelection();
    };

    const handlePinSelection = () => {
        const snap = resolveSelection('any');
        if (!snap) return;
        const result = addPinnedExcerpt(snap.messageId, snap.text, false);
        if (result.ok) clearSelection();
        else toast.warning(result.reason);
    };

    const handleRenameSelection = () => {
        const snap = resolveSelection('any');
        if (!snap) return;
        openRenameModal(stripMarkdown(snap.text));
        clearSelection();
    };

    // Drain the queue one name at a time. Sequential (not parallel) on purpose:
    // each add re-reads fresh store state so it sees NPCs created by prior items,
    // avoiding duplicate creates when two highlighted names resolve to the same NPC.
    const processNpcQueue = async () => {
        if (npcProcessingRef.current) return;
        npcProcessingRef.current = true;
        setNpcAdding(true);
        while (npcQueueRef.current.length > 0) {
            const cleanName = npcQueueRef.current.shift()!;
            const state = useAppStore.getState();
            const campaignId = state.activeCampaignId;
            if (!campaignId) {
                toast.warning('No active campaign.');
                setNpcQueueCount(c => Math.max(0, c - 1));
                continue;
            }
            toast.info(`Resolving "${cleanName}"…`);
            try {
                const result = await addNpcFromSelection({
                    rawText: cleanName,
                    ledger: state.npcLedger ?? [],
                    messages: state.messages,
                    campaignId,
                    storyProvider: state.getActiveStoryEndpoint() ?? state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint(),
                    updateProvider: state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint() ?? applyActiveSlotThinking(state.settings, 'summarizer', state.getActiveStoryEndpoint()),
                    addNPC: state.addNPC,
                    updateNPC: state.updateNPC,
                    matureMode: state.settings?.matureMode ?? false,
                });
                if (result.ok) toast.success(result.message);
                else if (result.kind === 'ambiguous') toast.warning(result.message);
                else toast.error(result.message);
            } catch (err) {
                toast.error(`Add NPC failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                setNpcQueueCount(c => Math.max(0, c - 1));
            }
        }
        npcProcessingRef.current = false;
        setNpcAdding(false);
    };

    const handleAddNpc = () => {
        const snap = resolveSelection('gm');
        if (!snap) return;
        const cleanName = stripMarkdown(snap.text);
        if (!cleanName) return;

        npcQueueRef.current.push(cleanName);
        setNpcQueueCount(c => c + 1);
        clearSelection();
        toast.info(`Queued "${cleanName}"`);
        void processNpcQueue();
    };

    const handleExit = async () => {
        if (activeCampaignId) {
            const state = useAppStore.getState();
            await saveCampaignState(activeCampaignId, { context: state.context, messages: state.messages, condenser: state.condenser, pinnedExcerpts: state.pinnedExcerpts });
            await saveDivergenceRegister(activeCampaignId, state.divergenceRegister);
        }
        try {
            await setActiveCampaign(null);
        } catch {
            // The commit error is reported at its source; keep this campaign open.
        }
    };

    const actionState = (id: HeaderActionId): ActionState => {
        switch (id) {
            case 'dice':
                return {
                    onPress: handleDice,
                    tone: armedRoll ? 'armed' : 'idle',
                    title: armedRoll ? 'Dice armed — click to disarm, or send to roll' : 'Dice me — open roll configurator',
                };
            case 'loot':
                return {
                    onPress: handleLoot,
                    tone: armedLoot ? 'armed' : context?.lootTree ? 'idle' : 'muted',
                    title: armedLoot
                        ? `Loot armed (${armedLoot.rolls}) — send to drop`
                        : context?.lootTree ? 'Roll loot — arm a drop, send to resolve' : 'No loot table for this world',
                };
            case 'pin':
                return {
                    onPress: handlePinSelection,
                    tone: selection.any ? 'ready' : 'idle',
                    title: 'Pin selected text as memory',
                };
            case 'deepSearch':
                return {
                    onPress: () => setDeepSearchSheetOpen(true),
                    tone: deepArmed ? 'armed' : 'idle',
                    title: deepArmed ? 'Deep Search armed — send to activate, tap to edit' : 'Deep Archive Search',
                    available: !!settings.enableDeepArchiveSearch,
                };
            case 'loreCheck':
                return {
                    onPress: handleLoreCheck,
                    tone: selection.gm ? 'ready' : 'idle',
                    title: 'Lore Check selection (highlight text in a GM message first)',
                };
            case 'rename':
                return {
                    onPress: handleRenameSelection,
                    tone: selection.any ? 'ready' : 'idle',
                    title: 'Rename selected name everywhere (highlight a name first)',
                };
            case 'addNpc':
                return {
                    onPress: handleAddNpc,
                    tone: npcAdding ? 'busy' : selection.gm ? 'ready' : 'idle',
                    title: npcQueueCount > 0
                        ? `Adding NPCs… ${npcQueueCount} in queue (highlight more to queue)`
                        : 'Add highlighted name to the NPC ledger (or update if it exists)',
                    busy: npcAdding,
                    badge: npcQueueCount > 1 ? npcQueueCount : undefined,
                };
            default:
                return {
                    onPress: () => openContextTab(contextTabOf(id)),
                    tone: 'idle',
                    title: `Open ${getHeaderAction(id).label}`,
                };
        }
    };

    const states = new Map(HEADER_ACTIONS.map(a => [a.id, actionState(a.id)]));
    const isAvailable = (id: HeaderActionId) => states.get(id)!.available !== false;
    const shortcutIds = settings.headerShortcuts ?? DEFAULT_HEADER_SHORTCUTS;
    const shortcuts = shortcutIds.filter(isAvailable).map(getHeaderAction);
    const menuActions = HEADER_ACTIONS.filter(a => !shortcutIds.includes(a.id) && isAvailable(a.id));

    return (
        <>
        <header className="bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 shrink-0 safe-top min-h-9 md:min-h-10 py-0">
            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <div className="flex items-center gap-1">
                {shortcuts.map(def => {
                    const state = states.get(def.id)!;
                    const Icon = def.icon;
                    return (
                        <button
                            key={def.id}
                            {...pressProps(def, state.onPress)}
                            className={`relative transition-colors p-1 touch-btn ${TONE_CLASS[state.tone]}`}
                            title={state.title}
                            aria-label={def.label}
                        >
                            {state.busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
                            {state.badge !== undefined && (
                                <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-[9px] leading-[14px] text-black font-bold text-center pointer-events-none">
                                    {state.badge}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            <div className="ml-auto flex items-center gap-1">
                <button
                    onClick={handleExit}
                    className="text-text-dim hover:text-ember transition-colors p-1 touch-btn"
                    title="Exit campaign"
                    aria-label="Exit campaign"
                >
                    <LogOut size={16} />
                </button>

                <div className="relative" ref={overflowRef}>
                    <button
                        onPointerDown={() => { if (!overflowOpen) menuSelectionRef.current = { gm: resolveSelection('gm'), any: resolveSelection('any') }; }}
                        onClick={() => setOverflowOpen(v => !v)}
                        className="text-text-dim hover:text-terminal transition-colors p-1 touch-btn"
                        title="More actions"
                        aria-label="More actions"
                    >
                        <MoreVertical size={16} />
                    </button>
                    {overflowOpen && (
                        <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded shadow-lg z-50 min-w-[180px] max-h-[calc(70*var(--app-vh))] overflow-y-auto py-1">
                            {menuActions.map(def => {
                                const state = states.get(def.id)!;
                                const Icon = def.icon;
                                return (
                                    <button
                                        key={def.id}
                                        onClick={() => { state.onPress(); setOverflowOpen(false); }}
                                        className={`${MENU_ITEM_CLASS} ${state.tone === 'armed' ? 'text-amber-400' : 'text-text-dim'}`}
                                        title={state.title}
                                    >
                                        {state.busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />} {def.label}
                                    </button>
                                );
                            })}
                            {menuActions.length > 0 && <div className="my-1 border-t border-border" />}
                            <button
                                onClick={() => {
                                    if (activeCampaignId) api.backup.create(activeCampaignId, { trigger: 'manual', isAuto: false });
                                    setOverflowOpen(false);
                                }}
                                className={`${MENU_ITEM_CLASS} text-text-dim`}
                            >
                                <Save size={14} /> Save backup
                            </button>
                            <button
                                onClick={() => {
                                    toggleBackupModal();
                                    setOverflowOpen(false);
                                }}
                                className={`${MENU_ITEM_CLASS} text-text-dim`}
                            >
                                <Archive size={14} /> Manage backups
                            </button>
                            <button
                                onClick={() => {
                                    const current = settings.aiTier ?? 'pro';
                                    updateSettings({ aiTier: TIER_CYCLE[current] });
                                    setOverflowOpen(false);
                                }}
                                className={`${MENU_ITEM_CLASS} text-text-dim font-mono uppercase tracking-widest`}
                            >
                                <span className="text-[10px]">AI tier:</span> {(settings.aiTier ?? 'pro').toUpperCase()}
                            </button>
                        </div>
                    )}
                </div>
            </div>

        </header>

        <DeepSearchSheet open={deepSearchSheetOpen} onClose={() => setDeepSearchSheetOpen(false)} />
        </>);
}
