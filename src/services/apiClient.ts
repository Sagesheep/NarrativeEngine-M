import type { AppSettings, ArchiveChapter, ArchiveIndexEntry, BackupMeta, ChatMessage, CondenserState, GameContext, NPCEntry, SemanticFact } from '../types';

const API = '/api';

export const api = {
    archive: {
        async append(campaignId: string, userText: string, assistantText: string): Promise<{ sceneId: string } | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userContent: userText, assistantContent: assistantText }),
                });
                if (res.ok) {
                    return await res.json();
                }
            } catch (err) {
                console.warn('[Archive] Failed to append:', err);
            }
            return undefined;
        },
        async getIndex(campaignId: string): Promise<ArchiveIndexEntry[]> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/index`);
            if (res.ok) return await res.json();
            return [];
        },
        async deleteFrom(campaignId: string, sceneId: string): Promise<void> {
            await fetch(`${API}/campaigns/${campaignId}/archive/scenes-from/${sceneId}`, {
                method: 'DELETE'
            });
        },
        async clear(campaignId: string): Promise<void> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to clear archive');
        },
        async open(campaignId: string): Promise<void> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/open`);
            if (!res.ok) {
                const data = await res.json();
                console.warn('[Archive]', data.error || 'Failed to open');
            }
        }
    },
    campaigns: {
        async saveState(campaignId: string, state: { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }): Promise<void> {
            await fetch(`${API}/campaigns/${campaignId}/state`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state),
            });
        },
        async saveNPCs(campaignId: string, npcs: NPCEntry[]): Promise<void> {
            await fetch(`${API}/campaigns/${campaignId}/npcs`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(npcs),
            });
        }
    },
    facts: {
        get: async (campaignId: string): Promise<SemanticFact[]> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/facts`);
            if (!res.ok) return [];
            return res.json();
        },
        save: async (campaignId: string, facts: SemanticFact[]): Promise<void> => {
            await fetch(`${API}/campaigns/${campaignId}/facts`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(facts),
            });
        },
    },
    chapters: {
        list: async (campaignId: string): Promise<ArchiveChapter[]> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`);
            if (!res.ok) return [];
            return res.json();
        },
        create: async (campaignId: string, title?: string): Promise<ArchiveChapter> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: title || 'New Chapter' }),
            });
            return res.json();
        },
        update: async (campaignId: string, chapterId: string, patch: Partial<ArchiveChapter>): Promise<void> => {
            await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
        },
        seal: async (campaignId: string): Promise<any> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/seal`, { method: 'POST' });
            return res.json();
        },
        merge: async (campaignId: string, chapterA: string, chapterB: string): Promise<any> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/merge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chapterA, chapterB }),
            });
            return res.json();
        },
        split: async (campaignId: string, chapterId: string, atSceneId: string): Promise<any> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}/split`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ atSceneId }),
            });
            return res.json();
        },
    },
    backup: {
        create: async (campaignId: string, opts: { label?: string; trigger?: string; isAuto?: boolean }): Promise<any> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/backup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts),
            });
            return res.json();
        },
        list: async (campaignId: string): Promise<BackupMeta[]> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups`);
            if (!res.ok) return [];
            return res.json();
        },
        read: async (campaignId: string, timestamp: number): Promise<any> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}`);
            return res.json();
        },
        restore: async (campaignId: string, timestamp: number): Promise<any> => {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}/restore`, { method: 'POST' });
            return res.json();
        },
        delete: async (campaignId: string, timestamp: number): Promise<void> => {
            await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}`, { method: 'DELETE' });
        },
    },
    settings: {
        async get(): Promise<any> {
            const res = await fetch(`${API}/settings`);
            if (!res.ok) throw new Error('Failed to load settings');
            return await res.json();
        },
        async save(settings: AppSettings, activeCampaignId: string | null): Promise<void> {
            await fetch(`${API}/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings, activeCampaignId }),
            });
        }
    }
};
