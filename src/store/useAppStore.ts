import { create } from 'zustand';

import { createSettingsSlice, type SettingsSlice } from './slices/settingsSlice';
import { createCampaignSlice, type CampaignSlice } from './slices/campaignSlice';
import { createChatSlice, type ChatSlice } from './slices/chatSlice';
import { createUISlice, type UISlice } from './slices/uiSlice';
import { createArchiveSlice, type ArchiveSlice } from './slices/archiveSlice';
import { createLoreSlice, type LoreSlice } from './slices/loreSlice';
import { createNPCSlice, type NPCSlice } from './slices/npcSlice';

// Re-export DEFAULT_* constants for backward compatibility
export {
    DEFAULT_SURPRISE_TYPES,
    DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES,
    DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO,
    DEFAULT_WORLD_WHERE,
    DEFAULT_WORLD_WHY,
    DEFAULT_WORLD_WHAT,
} from './slices/settingsSlice';
export type { ReindexState } from './slices/uiSlice';

// ── Combined store type ────────────────────────────────────────────────

type AppState = SettingsSlice & CampaignSlice & ChatSlice & UISlice & ArchiveSlice & LoreSlice & NPCSlice;

// ── Store ──────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()((set, get, store) => {
    const settingsSlice = createSettingsSlice(set, get, store);
    const campaignSlice = createCampaignSlice(set, get, store);
    const chatSlice = createChatSlice(set, get, store);
    const uiSlice = createUISlice(set, get, store);
    const archiveSlice = createArchiveSlice(set, get, store);
    const loreSlice = createLoreSlice(set, get, store);
    const npcSlice = createNPCSlice(set, get, store);

    return {
        ...settingsSlice,
        ...campaignSlice,
        ...chatSlice,
        ...uiSlice,
        ...archiveSlice,
        ...loreSlice,
        ...npcSlice,
    };
});

