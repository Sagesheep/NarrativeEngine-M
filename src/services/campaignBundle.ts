import { get, set } from 'idb-keyval';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { SaveFile } from './infrastructure';
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

const READ_CHUNK = 10 * 1024 * 1024;

export async function readFileChunked(file: File): Promise<string> {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < file.size) {
        const end = Math.min(offset + READ_CHUNK, file.size);
        const blob = file.slice(offset, end);
        chunks.push(await blob.text());
        offset = end;
    }
    return chunks.join('');
}

/**
 * Drop the heavy per-message `debugPayload` blobs unless the caller is in debug
 * mode. These are captured for the inline payload viewer and can be hundreds of
 * KB each — they dominate export size and aren't needed for a normal save.
 */
function stripDebugPayloads(state: CampaignState | null | undefined): CampaignState | null {
    if (!state) return state ?? null;
    const messages = state.messages;
    if (!Array.isArray(messages) || !messages.some(m => (m as { debugPayload?: unknown }).debugPayload !== undefined)) {
        return state;
    }
    return {
        ...state,
        messages: messages.map(m => {
            if ((m as { debugPayload?: unknown }).debugPayload === undefined) return m;
            const { debugPayload: _drop, ...rest } = m as Record<string, unknown>;
            return rest as typeof m;
        }),
    };
}

export async function exportBundle(campaignId: string, includeDebug = false): Promise<CampaignBundle> {
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
        state: includeDebug ? (state || null) : stripDebugPayloads(state),
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

export async function downloadBundle(campaignId: string, includeDebug = false): Promise<void> {
    let step: string = 'build-bundle';
    try {
        const bundle = await exportBundle(campaignId, includeDebug);
        const safeName = bundle.campaign.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
        const filename = `${safeName}_${new Date().toISOString().slice(0, 10)}.campaign`;

        step = 'serialize';
        const json = JSON.stringify(bundle);
        console.log('[export] bundle size (chars):', json.length, 'filename:', filename);

        if (Capacitor.isNativePlatform()) {
            // Write in 512 KB chunks to avoid OOM crash on the JS→Native bridge
            const CHUNK = 512 * 1024;
            step = 'fs-write';
            console.log('[export] writing to cache in chunks, total chars:', json.length);
            await Filesystem.writeFile({ path: filename, data: json.slice(0, CHUNK), directory: Directory.Cache, encoding: Encoding.UTF8 });
            for (let offset = CHUNK; offset < json.length; offset += CHUNK) {
                step = `fs-append-${offset}`;
                await Filesystem.appendFile({ path: filename, data: json.slice(offset, offset + CHUNK), directory: Directory.Cache, encoding: Encoding.UTF8 });
            }

            step = 'fs-geturi';
            const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });
            console.log('[export] cache uri:', uri);

            step = 'savefile-copy';
            await SaveFile.copyToDownloads({ uri, filename });
            console.log('[export] copyToDownloads resolved');
        } else {
            step = 'web-blob';
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
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[export] failed at step "${step}":`, err);
        throw new Error(`Export failed at ${step}: ${msg}`);
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

    reembeddedCampaign(newId, bundle.scenes || [], bundle.lore || []);

    return newId;
}

function reembeddedCampaign(cid: string, scenes: SceneRecord[], lore: LoreChunk[]): void {
    import('./embedding').then(({ embedText, getCurrentModelId }) =>
        import('./storage').then(({ offlineStorage }) => {
            const modelId = getCurrentModelId();
            for (const s of scenes) {
                embedText(`${s.userContent}\n${s.assistantContent}`.slice(0, 500))
                    .then(vec => { if (vec) offlineStorage.embeddings.store(cid, s.sceneId, Array.from(vec), 'scene', modelId); })
                    .catch(() => {});
            }
            for (const chunk of lore) {
                // Full content — the embedder worker windows long text (mean-pooled),
                // so truncating here would silently drop the tail of long lore chunks.
                embedText(chunk.content)
                    .then(vec => { if (vec) offlineStorage.embeddings.store(cid, chunk.id, Array.from(vec), 'lore', modelId); })
                    .catch(() => {});
            }
        })
    ).catch(() => {});
}
