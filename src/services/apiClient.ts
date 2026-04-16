import type { AppSettings, ArchiveChapter, ArchiveIndexEntry, BackupMeta, ChatMessage, CondenserState, EntityEntry, GameContext, NPCEntry, SemanticFact, TimelineEvent } from '../types';
import { offlineStorage } from './storage';
import { get as idbGet, set as idbSet } from 'idb-keyval';

export const api = {
    archive: {
        async append(campaignId: string, userText: string, assistantText: string): Promise<{ sceneId: string } | undefined> {
            try {
                const result = await offlineStorage.archive.append(campaignId, userText, assistantText);
                return result ? { sceneId: result.sceneId } : undefined;
            } catch (err) {
                console.warn('[Archive] Failed to append:', err);
            }
            return undefined;
        },
        async getIndex(campaignId: string): Promise<ArchiveIndexEntry[]> {
            return offlineStorage.archive.getIndex(campaignId);
        },
        async deleteFrom(campaignId: string, sceneId: string): Promise<void> {
            await offlineStorage.archive.deleteFrom(campaignId, sceneId);
        },
        async clear(campaignId: string): Promise<void> {
            await offlineStorage.archive.clear(campaignId);
        },
        async open(_campaignId: string): Promise<void> {
            // No-op on mobile — can't open text editor
        },
    },
    campaigns: {
        async saveState(campaignId: string, state: { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }): Promise<void> {
            const { saveCampaignState } = await import('../store/campaignStore');
            await saveCampaignState(campaignId, state);
        },
        async saveNPCs(campaignId: string, npcs: NPCEntry[]): Promise<void> {
            const { saveNPCLedger } = await import('../store/campaignStore');
            await saveNPCLedger(campaignId, npcs);
        },
    },
    facts: {
        get: async (campaignId: string): Promise<SemanticFact[]> => {
            return offlineStorage.facts.get(campaignId);
        },
        save: async (campaignId: string, facts: SemanticFact[]): Promise<void> => {
            await offlineStorage.facts.save(campaignId, facts);
        },
    },
    chapters: {
        list: async (campaignId: string): Promise<ArchiveChapter[]> => {
            return offlineStorage.chapters.list(campaignId);
        },
        create: async (campaignId: string, title?: string): Promise<ArchiveChapter> => {
            return offlineStorage.chapters.create(campaignId, title);
        },
        update: async (campaignId: string, chapterId: string, patch: Partial<ArchiveChapter>): Promise<void> => {
            await offlineStorage.chapters.update(campaignId, chapterId, patch);
        },
        seal: async (campaignId: string): Promise<any> => {
            return offlineStorage.chapters.seal(campaignId);
        },
        merge: async (campaignId: string, chapterA: string, chapterB: string): Promise<any> => {
            return offlineStorage.chapters.merge(campaignId, chapterA, chapterB);
        },
        split: async (campaignId: string, chapterId: string, atSceneId: string): Promise<any> => {
            return offlineStorage.chapters.split(campaignId, chapterId, atSceneId);
        },
    },
    backup: {
        create: async (campaignId: string, opts: { label?: string; trigger?: string; isAuto?: boolean }): Promise<any> => {
            return offlineStorage.backup.create(campaignId, opts);
        },
        list: async (campaignId: string): Promise<BackupMeta[]> => {
            const list = await offlineStorage.backup.list(campaignId);
            return list;
        },
        read: async (campaignId: string, timestamp: number): Promise<any> => {
            return offlineStorage.backup.read(campaignId, timestamp);
        },
        restore: async (campaignId: string, timestamp: number): Promise<any> => {
            return offlineStorage.backup.restore(campaignId, timestamp);
        },
        delete: async (campaignId: string, timestamp: number): Promise<void> => {
            await offlineStorage.backup.delete(campaignId, timestamp);
        },
    },
    timeline: {
        get: async (campaignId: string): Promise<TimelineEvent[]> => {
            return offlineStorage.timeline.get(campaignId);
        },
        add: async (campaignId: string, event: Partial<TimelineEvent>): Promise<TimelineEvent | null> => {
            return offlineStorage.timeline.add(campaignId, event);
        },
        remove: async (campaignId: string, eventId: string): Promise<boolean> => {
            return offlineStorage.timeline.remove(campaignId, eventId);
        },
    },
    entities: {
        get: async (campaignId: string): Promise<EntityEntry[]> => {
            return offlineStorage.entities.get(campaignId);
        },
        merge: async (campaignId: string, survivorId: string, absorbedId: string): Promise<any> => {
            return offlineStorage.entities.merge(campaignId, survivorId, absorbedId);
        },
    },
    settings: {
        async get(): Promise<any> {
            const localSettings = await idbGet('nn_settings');
            return localSettings?.settings || {};
        },
        async save(settings: AppSettings, activeCampaignId: string | null): Promise<void> {
            const { encryptSettingsPresets } = await import('./settingsCrypto');
            const encryptedPresets = await encryptSettingsPresets(settings.presets);
            const encryptedSettings = { ...settings, presets: encryptedPresets };
            await idbSet('nn_settings', { settings: encryptedSettings, activeCampaignId });
        },
    },
};
