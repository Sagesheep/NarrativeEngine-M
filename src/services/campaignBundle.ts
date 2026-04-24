import { get, set } from 'idb-keyval';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { SaveFile } from './saveFilePicker';
import type { Campaign, LoreChunk, ArchiveIndexEntry, ArchiveChapter, SemanticFact, TimelineEvent, EntityEntry, NPCEntry } from '../types';
import type { CampaignState } from '../store/campaignStore';
import { getList, setList, k, type SceneRecord } from './storage/_helpers';
import { uid } from '../utils/uid';

export type CampaignBundle = {
    version: 1;
    exportedAt: number;
    sourcePlatform: 'mobile' | 'desktop';
    campaign: Campaign;
    state: CampaignState | null;
    lore: LoreChunk[];
    npcs: NPCEntry[];
    scenes: SceneRecord[];
    archiveIndex: ArchiveIndexEntry[];
    chapters: ArchiveChapter[];
    facts: SemanticFact[];
    timeline: TimelineEvent[];
    entities: EntityEntry[];
};

export async function exportBundle(campaignId: string): Promise<CampaignBundle> {
    const cid = campaignId;
    const [
        allCampaigns,
        state,
        lore,
        npcs,
        scenes,
        archiveIndex,
        chapters,
        facts,
        timeline,
        entities,
    ] = await Promise.all([
        get<Campaign[]>('campaigns'),
        get<CampaignState>(`state_${cid}`),
        get<LoreChunk[]>(`lore_${cid}`),
        get<NPCEntry[]>(`npcs_${cid}`),
        getList<SceneRecord>(k(cid, 'scenes')),
        getList<ArchiveIndexEntry>(k(cid, 'archive_index')),
        getList<ArchiveChapter>(k(cid, 'chapters')),
        getList<SemanticFact>(k(cid, 'facts')),
        getList<TimelineEvent>(k(cid, 'timeline')),
        getList<EntityEntry>(k(cid, 'entities')),
    ]);

    const campaign = (allCampaigns || []).find(c => c.id === cid);
    if (!campaign) throw new Error(`Campaign ${cid} not found`);

    return {
        version: 1,
        exportedAt: Date.now(),
        sourcePlatform: 'mobile',
        campaign,
        state: state || null,
        lore: lore || [],
        npcs: npcs || [],
        scenes,
        archiveIndex,
        chapters,
        facts,
        timeline,
        entities,
    };
}

export async function downloadBundle(campaignId: string): Promise<void> {
    const bundle = await exportBundle(campaignId);
    const safeName = bundle.campaign.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    const filename = `${safeName}_${new Date().toISOString().slice(0, 10)}.campaign`;
    const json = JSON.stringify(bundle);

    if (Capacitor.isNativePlatform()) {
        // Write to cache first (avoids passing large string over JS bridge)
        await Filesystem.writeFile({ path: filename, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
        const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
        await SaveFile.copyToDownloads({ uri, filename });
    } else {
        // Web/desktop browser: standard blob download
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

}

export async function importBundle(bundle: CampaignBundle): Promise<string> {
    if (bundle.version !== 1) throw new Error(`Unsupported bundle version: ${bundle.version}`);

    const existing: Campaign[] = (await get<Campaign[]>('campaigns')) || [];
    const existingIds = new Set(existing.map(c => c.id));
    const newId = existingIds.has(bundle.campaign.id) ? uid() : bundle.campaign.id;
    const campaign: Campaign = { ...bundle.campaign, id: newId };

    await Promise.all([
        set('campaigns', [...existing, campaign]),
        bundle.state ? set(`state_${newId}`, bundle.state) : Promise.resolve(),
        bundle.lore?.length ? set(`lore_${newId}`, bundle.lore) : Promise.resolve(),
        bundle.npcs?.length ? set(`npcs_${newId}`, bundle.npcs) : Promise.resolve(),
        // Legacy key — kept so loadArchiveIndex() in campaignStore.ts can read it
        bundle.archiveIndex?.length ? set(`archive_index_${newId}`, bundle.archiveIndex) : Promise.resolve(),
        bundle.scenes?.length ? setList(k(newId, 'scenes'), bundle.scenes) : Promise.resolve(),
        bundle.archiveIndex?.length ? setList(k(newId, 'archive_index'), bundle.archiveIndex) : Promise.resolve(),
        bundle.chapters?.length ? setList(k(newId, 'chapters'), bundle.chapters) : Promise.resolve(),
        bundle.facts?.length ? setList(k(newId, 'facts'), bundle.facts) : Promise.resolve(),
        bundle.timeline?.length ? setList(k(newId, 'timeline'), bundle.timeline) : Promise.resolve(),
        bundle.entities?.length ? setList(k(newId, 'entities'), bundle.entities) : Promise.resolve(),
    ]);

    reembedCampaign(newId, bundle.scenes || [], bundle.lore || []);

    return newId;
}

function reembedCampaign(cid: string, scenes: SceneRecord[], lore: LoreChunk[]): void {
    import('./embedder').then(({ embedText }) =>
        import('./storage').then(({ offlineStorage }) => {
            for (const s of scenes) {
                embedText(`${s.userContent}\n${s.assistantContent}`.slice(0, 500))
                    .then(vec => { if (vec) offlineStorage.embeddings.store(cid, s.sceneId, Array.from(vec), 'scene'); })
                    .catch(() => {});
            }
            for (const chunk of lore) {
                embedText(chunk.content.slice(0, 500))
                    .then(vec => { if (vec) offlineStorage.embeddings.store(cid, chunk.id, Array.from(vec), 'lore'); })
                    .catch(() => {});
            }
        })
    ).catch(() => {});
}
