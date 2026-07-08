import { useEffect, useState, useRef } from 'react';
import { LogOut, ScanSearch, BookCheck, Pin, Replace, MoreVertical, Save, Archive, UserPlus, Loader2, Dices, Package } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { hapticMedium } from '../utils/haptics';
import { useShallow } from 'zustand/react/shallow';
import { addNpcFromSelection } from '../services/npc';
import type { AiTier } from '../types';

const TIER_CYCLE: Record<AiTier, AiTier> = { lite: 'pro', pro: 'max', max: 'lite' };

import { TokenGauge } from './TokenGauge';
import { saveCampaignState, saveDivergenceRegister } from '../store/campaignStore';
import { api } from '../services/apiClient';
import { toast } from './Toast';

type SelectionSnapshot = {
    messageId: string;
    text: string;
    start: number;
    end: number;
    bubbleText: string;
};

// Strip markdown bold/italic markers so selecting from a [**NAME**] chip gives "NAME".
const stripMarkdown = (s: string) => s.replace(/\*\*/g, '').replace(/\*/g, '').trim();

export function Header() {

    const {
        toggleBackupModal,
        activeCampaignId,
        setActiveCampaign,
        deepArmed,
        toggleDeepArmed,
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
    } = useAppStore(useShallow(s => ({
        toggleBackupModal: s.toggleBackupModal,
        activeCampaignId: s.activeCampaignId,
        setActiveCampaign: s.setActiveCampaign,
        deepArmed: s.deepArmed,
        toggleDeepArmed: s.toggleDeepArmed,
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
    })));

    const [loreSel, setLoreSel] = useState<SelectionSnapshot | null>(null);
    const [pinSel, setPinSel] = useState<SelectionSnapshot | null>(null);
    const [renameSel, setRenameSel] = useState<SelectionSnapshot | null>(null);
    const [npcSel, setNpcSel] = useState<SelectionSnapshot | null>(null);
    const [npcAdding, setNpcAdding] = useState(false);
    // Outstanding NPC adds (active + waiting). The queue lets the player fire off
    // several highlighted names without waiting for each LLM resolve to finish.
    const [npcQueueCount, setNpcQueueCount] = useState(0);
    const npcQueueRef = useRef<string[]>([]);
    const npcProcessingRef = useRef(false);
    const [overflowOpen, setOverflowOpen] = useState(false);
    const overflowRef = useRef<HTMLDivElement>(null);

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

    useEffect(() => {
        const handle = () => {
            const lore = captureFromBubble('[data-lore-checkable="true"]');
            setLoreSel(lore);
            const pin = captureFromBubble('[data-message-id]');
            setPinSel(pin);
            setRenameSel(pin);
            // NPC add only makes sense on GM narration (where NPCs appear)
            setNpcSel(captureFromBubble('[data-lore-checkable="true"]'));
        };
        document.addEventListener('selectionchange', handle);
        return () => document.removeEventListener('selectionchange', handle);
    }, []);

    useEffect(() => {
        if (!overflowOpen) return;
        const handler = (e: MouseEvent) => {
            if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
                setOverflowOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [overflowOpen]);

    const handleLoreCheck = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? loreSel;
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
        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
        setPinSel(null);
    };

    const handlePinSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? pinSel;
        if (!snap) return;
        const result = addPinnedExcerpt(snap.messageId, snap.text, false);
        if (result.ok) {
            window.getSelection()?.removeAllRanges();
            setPinSel(null);
            setLoreSel(null);
        } else {
            toast.warning(result.reason);
        }
    };

    const handleRenameSelection = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-message-id]') ?? renameSel;
        if (!snap) return;
        openRenameModal(stripMarkdown(snap.text));
        window.getSelection()?.removeAllRanges();
        setRenameSel(null);
        setPinSel(null);
        setLoreSel(null);
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
                    updateProvider: state.getActiveSummarizerEndpoint() ?? state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint(),
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

    const handleAddNpc = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureFromBubble('[data-lore-checkable="true"]') ?? npcSel;
        if (!snap) return;
        const cleanName = stripMarkdown(snap.text);
        if (!cleanName) return;

        npcQueueRef.current.push(cleanName);
        setNpcQueueCount(c => c + 1);

        window.getSelection()?.removeAllRanges();
        setNpcSel(null);
        setLoreSel(null);
        setPinSel(null);
        toast.info(`Queued "${cleanName}"`);
        void processNpcQueue();
    };

    const handleExit = async () => {
        if (activeCampaignId) {
            const state = useAppStore.getState();
            await saveCampaignState(activeCampaignId, { context: state.context, messages: state.messages, condenser: state.condenser, pinnedExcerpts: state.pinnedExcerpts });
            await saveDivergenceRegister(activeCampaignId, state.divergenceRegister);
        }
        setActiveCampaign(null);
    };

    return (
        <header className="bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 shrink-0 safe-top min-h-9 md:min-h-10 py-0">
            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <div className="flex items-center gap-1">
                {/* Dice Me — opens 3-gate roll configurator modal. Click again to disarm. */}
                <button
                    onClick={() => {
                        hapticMedium();
                        if (armedRoll) {
                            setArmedRoll(null);
                        } else {
                            openDiceRollModal();
                        }
                    }}
                    className={`transition-colors p-1 touch-btn ${
                        armedRoll
                            ? 'text-amber-400 animate-pulse'
                            : 'text-text-dim hover:text-terminal'
                    }`}
                    title={armedRoll
                        ? 'Dice armed — click to disarm, or send to roll'
                        : 'Dice me — open roll configurator'}
                    aria-label="Dice me"
                >
                    <Dices size={16} />
                </button>

                {/* Loot Engine WO-05: manual loot drop trigger. Mirrors the dice button. */}
                <button
                    onClick={() => {
                        if (!context?.lootTree) {
                            toast.warning('No loot table for this world');
                            return;
                        }
                        hapticMedium();
                        openLootRollModal();
                    }}
                    className={`transition-colors p-1 touch-btn ${
                        armedLoot
                            ? 'text-amber-400 animate-pulse'
                            : context?.lootTree
                                ? 'text-text-dim hover:text-terminal'
                                : 'text-text-dim/40'
                    }`}
                    title={armedLoot
                        ? `Loot armed (${armedLoot.rolls}) — send to drop`
                        : context?.lootTree
                            ? 'Roll loot — arm a drop, send to resolve'
                            : 'No loot table for this world'}
                    aria-label="Roll loot"
                >
                    <Package size={16} />
                </button>

                <button
                    onMouseDown={handlePinSelection}
                    onTouchStart={handlePinSelection}
                    className={`transition-colors p-1 touch-btn ${
                        pinSel
                            ? 'text-terminal animate-pulse'
                            : 'text-text-dim hover:text-terminal'
                    }`}
                    title="Pin selected text as memory"
                    aria-label="Pin selection"
                >
                    <Pin size={16} />
                </button>

                {settings.enableDeepArchiveSearch && (
                    <button
                        onClick={toggleDeepArmed}
                        className={`transition-colors p-1 touch-btn ${
                            deepArmed
                                ? 'text-amber-400 animate-pulse'
                                : 'text-text-dim hover:text-terminal'
                        }`}
                        title={deepArmed ? 'Deep Search armed — send to activate' : 'Arm Deep Archive Search'}
                        aria-label="Toggle Deep Archive Search"
                    >
                        <ScanSearch size={16} />
                    </button>
                )}

                <button
                    onMouseDown={handleLoreCheck}
                    onTouchStart={handleLoreCheck}
                    className={`transition-colors p-1 touch-btn ${
                        loreSel
                            ? 'text-terminal animate-pulse'
                            : 'text-text-dim hover:text-terminal'
                    }`}
                    title="Lore Check selection (highlight text in a GM message first)"
                    aria-label="Lore Check selection"
                >
                    <BookCheck size={16} />
                </button>

                <button
                    onMouseDown={handleRenameSelection}
                    onTouchStart={handleRenameSelection}
                    className={`transition-colors p-1 touch-btn ${
                        renameSel
                            ? 'text-terminal animate-pulse'
                            : 'text-text-dim hover:text-terminal'
                    }`}
                    title="Rename selected name everywhere (highlight a name first)"
                    aria-label="Rename selection"
                >
                    <Replace size={16} />
                </button>

                <button
                    onMouseDown={handleAddNpc}
                    onTouchStart={handleAddNpc}
                    className={`relative transition-colors p-1 touch-btn ${
                        npcAdding
                            ? 'text-terminal'
                            : npcSel
                                ? 'text-terminal animate-pulse'
                                : 'text-text-dim hover:text-terminal'
                    }`}
                    title={npcQueueCount > 0
                        ? `Adding NPCs… ${npcQueueCount} in queue (highlight more to queue)`
                        : 'Add highlighted name to the NPC ledger (or update if it exists)'}
                    aria-label="Add selection to NPC ledger"
                >
                    {npcAdding ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
                    {npcQueueCount > 1 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-[9px] leading-[14px] text-black font-bold text-center pointer-events-none">
                            {npcQueueCount}
                        </span>
                    )}
                </button>
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
                        onClick={() => setOverflowOpen(v => !v)}
                        className="text-text-dim hover:text-terminal transition-colors p-1 touch-btn"
                        title="More actions"
                        aria-label="More actions"
                    >
                        <MoreVertical size={16} />
                    </button>
                    {overflowOpen && (
                        <div className="absolute right-0 top-full mt-1 bg-surface border border-border rounded shadow-lg z-50 min-w-[180px] py-1">
                            <button
                                onClick={() => {
                                    if (activeCampaignId) api.backup.create(activeCampaignId, { trigger: 'manual', isAuto: false });
                                    setOverflowOpen(false);
                                }}
                                className="w-full text-left px-3 py-2 text-xs text-text-dim hover:text-terminal hover:bg-terminal/5 flex items-center gap-2 transition-colors"
                            >
                                <Save size={14} /> Save backup
                            </button>
                            <button
                                onClick={() => {
                                    toggleBackupModal();
                                    setOverflowOpen(false);
                                }}
                                className="w-full text-left px-3 py-2 text-xs text-text-dim hover:text-terminal hover:bg-terminal/5 flex items-center gap-2 transition-colors"
                            >
                                <Archive size={14} /> Manage backups
                            </button>
                            <button
                                onClick={() => {
                                    const current = settings.aiTier ?? 'pro';
                                    updateSettings({ aiTier: TIER_CYCLE[current] });
                                    setOverflowOpen(false);
                                }}
                                className="w-full text-left px-3 py-2 text-xs text-text-dim hover:text-terminal hover:bg-terminal/5 flex items-center gap-2 transition-colors font-mono uppercase tracking-widest"
                            >
                                <span className="text-[10px]">AI tier:</span> {(settings.aiTier ?? 'pro').toUpperCase()}
                            </button>
                        </div>
                    )}
                </div>
            </div>

        </header>
    );
}