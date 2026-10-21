import { Dices, Package, Pin, ScanSearch, BookCheck, Replace, UserPlus, type LucideIcon } from 'lucide-react';
import type { ContextTabId, HeaderActionId } from '../../types';
import { CONTEXT_TABS } from '../context-drawer/contextTabs';

/**
 * Header shortcuts — which actions sit in the header bar, and in what order.
 * Every action not chosen as a shortcut is still reachable from the ⋮ menu.
 *
 * `selection` actions act on highlighted story text, so they must fire on
 * press-down (before the tap collapses the selection) rather than on click.
 */
export type HeaderActionDef = {
    id: HeaderActionId;
    label: string;
    icon: LucideIcon;
    selection: boolean;
};

export const HEADER_ACTIONS: readonly HeaderActionDef[] = [
    { id: 'dice',       label: 'Dice roll',       icon: Dices,      selection: false },
    { id: 'loot',       label: 'Loot drop',       icon: Package,    selection: false },
    { id: 'pin',        label: 'Pin selection',   icon: Pin,        selection: true },
    { id: 'deepSearch', label: 'Deep Search',     icon: ScanSearch, selection: false },
    { id: 'loreCheck',  label: 'Lore Check',      icon: BookCheck,  selection: true },
    { id: 'rename',     label: 'Rename',          icon: Replace,    selection: true },
    { id: 'addNpc',     label: 'Add NPC',         icon: UserPlus,   selection: true },
    ...CONTEXT_TABS.map(({ id, label, icon }) => ({ id: `tab:${id}` as const, label, icon, selection: false })),
];

const ACTIONS_BY_ID = new Map(HEADER_ACTIONS.map(a => [a.id, a]));

export const getHeaderAction = (id: HeaderActionId): HeaderActionDef => ACTIONS_BY_ID.get(id)!;

export const contextTabOf = (id: `tab:${ContextTabId}`): ContextTabId => id.slice('tab:'.length) as ContextTabId;

/** The header as it was before shortcuts were configurable. */
export const DEFAULT_HEADER_SHORTCUTS: readonly HeaderActionId[] = ['dice', 'loot', 'pin', 'deepSearch', 'loreCheck', 'rename', 'addNpc'];

/** Drops unknown and duplicate ids; anything that isn't a list falls back to the default. */
export function normalizeHeaderShortcuts(value: unknown): HeaderActionId[] {
    if (!Array.isArray(value)) return [...DEFAULT_HEADER_SHORTCUTS];
    const known = value.filter((id): id is HeaderActionId => ACTIONS_BY_ID.has(id));
    return [...new Set(known)];
}

/** Shows `id` at the end of the bar, or hides it if it's already shown. */
export function toggleHeaderShortcut(shortcuts: readonly HeaderActionId[], id: HeaderActionId): HeaderActionId[] {
    return shortcuts.includes(id) ? shortcuts.filter(s => s !== id) : [...shortcuts, id];
}

/** Swaps `id` with its neighbour; a move past either end is a no-op. */
export function moveHeaderShortcut(shortcuts: readonly HeaderActionId[], id: HeaderActionId, direction: -1 | 1): HeaderActionId[] {
    const from = shortcuts.indexOf(id);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= shortcuts.length) return [...shortcuts];
    const next = [...shortcuts];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
}
